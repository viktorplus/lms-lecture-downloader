/**
 * auth.js — авторизация в Moodle LMS с переиспользованием сессии (токена)
 * и защитой от блокировки аккаунта: не более MAX_LOGIN_FAILURES неудачных
 * попыток подряд (счётчик персистится между запусками).
 *
 * Стратегия:
 *   1. Пробуем открыть /my/ с уже сохранённой сессией (persistent context).
 *      Если залогинены — сбрасываем счётчик неудач и сохраняем session.json.
 *   2. Иначе выполняем автологин формой. При успехе — сброс счётчика и
 *      сохранение сессии. При неудаче — инкремент счётчика.
 *   3. Если неудач подряд >= лимита — останавливаемся и просим пользователя
 *      войти вручную (reason='login_limit').
 */

const fs = require('fs');

function readFailures(config) {
  try {
    const raw = fs.readFileSync(config.LOGIN_ATTEMPTS_FILE, 'utf8').trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeFailures(config, n) {
  try {
    fs.writeFileSync(config.LOGIN_ATTEMPTS_FILE, String(n), 'utf8');
  } catch {
    /* игнорируем — это лишь защитный счётчик */
  }
}

function resetFailures(config) {
  writeFailures(config, 0);
}

async function isLoggedIn(page) {
  // Если редиректнуло на форму логина — точно не залогинены.
  if (page.url().includes('/login/index.php')) return false;
  // Надёжный индикатор входа в Moodle — ссылка logout или меню пользователя
  // (курсы на /my/ подгружаются асинхронно и не годятся как ранний признак).
  try {
    await page.waitForSelector(
      'a[href*="/login/logout.php"], [data-region="user-menu"], .usermenu, ' +
      'a[href*="/course/view.php?id="]',
      { timeout: 15000 }
    );
    return true;
  } catch {
    return false;
  }
}

async function restoreSession(context, config, logger) {
  // MoodleSession — session-cookie без Expires; persistent-профиль Chromium
  // не сохраняет такие куки между запусками. Поэтому переинъектируем их
  // вручную из session.json, чтобы переиспользовать токен без повторного входа.
  try {
    if (!fs.existsSync(config.SESSION_FILE)) return;
    const state = JSON.parse(fs.readFileSync(config.SESSION_FILE, 'utf8'));
    if (state && Array.isArray(state.cookies) && state.cookies.length) {
      await context.addCookies(state.cookies);
      logger.info(`Восстановлено куки из session.json: ${state.cookies.length}.`);
    }
  } catch (err) {
    logger.warn(`Не удалось восстановить session.json: ${err.message}`);
  }
}

async function captureSession(context, page, config, logger) {
  try {
    await context.storageState({ path: config.SESSION_FILE });
    const cookies = await context.cookies();
    const sess = cookies.find((c) => /MoodleSession/i.test(c.name));
    if (sess) {
      const masked = `${sess.value.slice(0, 4)}…${sess.value.slice(-4)}`;
      logger.info(`Токен сессии получен и сохранён (${sess.name}=${masked}).`);
    } else {
      logger.warn('Cookie MoodleSession не найден, но session.json сохранён.');
    }
  } catch (err) {
    logger.warn(`Не удалось сохранить session.json: ${err.message}`);
  }
}

async function attemptLogin(page, config, logger) {
  logger.info('Выполняю автологин формой LMS...');
  await page.goto(config.LOGIN_URL, { waitUntil: 'domcontentloaded' });

  const userSel = '#username, input[name="username"]';
  const passSel = '#password, input[name="password"]';
  const btnSel = '#loginbtn, button[type="submit"], input[type="submit"]';

  // Moodle при уже активной сессии показывает страницу «вы уже вошли» без
  // формы. Тогда поля username не будет — значит мы фактически залогинены.
  const hasForm = await page
    .waitForSelector(userSel, { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  if (!hasForm) {
    await page.goto(config.MY_COURSES_URL, { waitUntil: 'domcontentloaded' });
    if (await isLoggedIn(page)) {
      logger.info('Обнаружена активная сессия (страница «уже вошли»).');
      return true;
    }
    return false;
  }

  await page.fill(userSel, config.LMS_EMAIL);
  await page.fill(passSel, config.LMS_PASSWORD);

  await Promise.all([
    page.waitForLoadState('domcontentloaded'),
    page.click(btnSel),
  ]).catch(() => { /* навигация могла уже произойти */ });

  // Перейти на /my/ и проверить результат
  await page.goto(config.MY_COURSES_URL, { waitUntil: 'domcontentloaded' });
  return isLoggedIn(page);
}

/**
 * Гарантирует авторизацию. Возвращает { ok, reason }.
 *   ok=true            — авторизованы;
 *   reason='login_limit' — превышен лимит неудачных попыток, нужен ручной вход.
 */
async function ensureAuthenticated(context, page, config, logger) {
  // 0. Переинъектируем сохранённый токен (session-cookie) из session.json
  await restoreSession(context, config, logger);

  // 1. Пробуем существующую сессию
  await page.goto(config.MY_COURSES_URL, { waitUntil: 'domcontentloaded' });
  if (await isLoggedIn(page)) {
    logger.info('Сессия активна — повторный вход не требуется (токен переиспользован).');
    resetFailures(config);
    await captureSession(context, page, config, logger);
    return { ok: true };
  }

  // 2. Проверяем счётчик неудач ДО новых попыток
  let failures = readFailures(config);
  if (failures >= config.MAX_LOGIN_FAILURES) {
    logger.error(
      `Достигнут лимит неудачных логинов подряд (${failures}/${config.MAX_LOGIN_FAILURES}). ` +
      'Останавливаюсь во избежание блокировки аккаунта.'
    );
    return { ok: false, reason: 'login_limit' };
  }

  // 3. Цикл автологина
  while (failures < config.MAX_LOGIN_FAILURES) {
    let success = false;
    try {
      success = await attemptLogin(page, config, logger);
    } catch (err) {
      logger.warn(`Ошибка при попытке логина: ${err.message}`);
      success = false;
    }

    if (success) {
      logger.info('Авторизация успешна.');
      resetFailures(config);
      await captureSession(context, page, config, logger);
      return { ok: true };
    }

    failures += 1;
    writeFailures(config, failures);
    logger.warn(`Неудачная попытка логина ${failures}/${config.MAX_LOGIN_FAILURES}.`);
  }

  logger.error(
    `Не удалось войти после ${config.MAX_LOGIN_FAILURES} попыток подряд. ` +
    'Нужен ручной вход пользователя.'
  );
  return { ok: false, reason: 'login_limit' };
}

module.exports = { ensureAuthenticated, isLoggedIn, readFailures, resetFailures };
