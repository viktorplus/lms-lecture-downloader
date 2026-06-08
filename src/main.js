/**
 * main.js — оркестрация прогона: запуск браузера, авторизация, обход курсов,
 * загрузка ресурсов. Наполняется по мере реализации модулей.
 */

const { chromium } = require('playwright');
const { ensureAuthenticated } = require('./auth');
const { ensureDir } = require('./utils');

async function run(config, logger) {
  if (!config.LMS_EMAIL || !config.LMS_PASSWORD) {
    logger.error('Не заданы LMS_EMAIL/LMS_PASSWORD. Заполни .env (см. .env.example).');
    return 1;
  }

  ensureDir(config.TARGET_ROOT);

  const context = await chromium.launchPersistentContext(config.PROFILE_DIR, {
    headless: config.HEADLESS,
    acceptDownloads: true,
    viewport: { width: 1400, height: 900 },
  });
  const page = context.pages()[0] || (await context.newPage());

  try {
    const auth = await ensureAuthenticated(context, page, config, logger);
    if (!auth.ok) {
      if (auth.reason === 'login_limit') {
        logger.error(
          'ТРЕБУЕТСЯ РУЧНОЙ ВХОД: запусти с HEADLESS=false, войди в браузере вручную, ' +
          'затем перезапусти. Счётчик неудач сбросится автоматически после успешного входа.'
        );
        return 2;
      }
      return 1;
    }

    logger.info('Готово к обходу курсов (загрузка подключается в следующих задачах).');
    return 0;
  } finally {
    await context.close();
  }
}

module.exports = { run };
