/**
 * main.js — оркестрация прогона: запуск браузера, авторизация, обход всех
 * курсов, загрузка ресурсов с идемпотентностью и подробным логированием.
 */

const path = require('path');
const { chromium } = require('playwright');
const { ensureAuthenticated } = require('./auth');
const { getMyCourses, getCourseActivities } = require('./lms');
const { downloadResource, saveActivityHtml, downloadFolder } = require('./download');
const fs = require('fs');
const { ensureDir, fileCount, sanitizeName, pad2, isSameSubject } = require('./utils');

/**
 * Находит уже существующую папку предмета (в т.ч. со старым суффиксом _idNN),
 * чтобы не плодить дубликаты. Если такой нет — возвращает «чистое» имя.
 */
function resolveSubjectFolder(targetRoot, course) {
  let existing = [];
  try {
    existing = fs
      .readdirSync(targetRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    /* папки ещё нет */
  }
  const match = existing.find((name) => isSameSubject(name, course.name, course.id));
  if (match) return match;
  return sanitizeName(course.normalized) || `course_id${course.id}`;
}

async function processSection(ctx, page, sectionPath, section, logger) {
  let saved = 0;
  for (const act of section.activities) {
    try {
      if (act.type === 'resource') {
        const out = await downloadResource(ctx.request, act.href, act.name, sectionPath);
        if (out.skipped) {
          logger.warn(`    ~ пропущен ресурс: ${act.name} (${out.reason})`);
        } else {
          saved += 1;
          logger.info(`    + ${path.basename(out.savedTo)}`);
        }
      } else if (act.type === 'assign' || act.type === 'page') {
        const out = await saveActivityHtml(page, act.href, act.name, sectionPath);
        saved += 1;
        logger.info(`    + ${path.basename(out.savedTo)} (html)`);
      } else if (act.type === 'folder') {
        const out = await downloadFolder(ctx.request, act.href, sectionPath);
        saved += out.savedCount;
        logger.info(`    + папка «${act.name}»: файлов ${out.savedCount}`);
      }
    } catch (err) {
      logger.error(`    ! ошибка: ${act.name}: ${err.message}`);
    }
  }
  return saved;
}

async function processCourse(ctx, page, course, config, logger) {
  const folderName = resolveSubjectFolder(config.TARGET_ROOT, course);
  const subjectPath = path.join(config.TARGET_ROOT, folderName);
  ensureDir(subjectPath);

  logger.info(`\n=== ${folderName} ===`);
  logger.info(`Курс на LMS: ${course.name} (id=${course.id})`);

  await page.goto(course.href, { waitUntil: 'domcontentloaded' });
  let sections;
  try {
    sections = await getCourseActivities(page);
  } catch (err) {
    logger.warn(`  (не удалось прочитать секции: ${err.message})`);
    return { saved: 0, sectionsDone: 0 };
  }

  if (sections.length === 0) {
    logger.info('  (нет файловых ресурсов в этом курсе)');
    return { saved: 0, sectionsDone: 0 };
  }

  let saved = 0;
  let sectionsDone = 0;
  let idx = 1;
  for (const section of sections) {
    const sectionFolder = `${pad2(idx)} - ${sanitizeName(section.heading)}`;
    const sectionPath = path.join(subjectPath, sectionFolder);

    if (fileCount(sectionPath) > 0) {
      logger.info(`  [skip] ${sectionFolder} (уже есть файлы)`);
      idx += 1;
      continue;
    }

    ensureDir(sectionPath);
    logger.info(`  ${sectionFolder}`);
    const sectionSaved = await processSection(ctx, page, sectionPath, section, logger);
    saved += sectionSaved;
    sectionsDone += 1;
    idx += 1;
  }

  return { saved, sectionsDone };
}

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

    const courses = await getMyCourses(page, config, logger);
    let totalSaved = 0;
    let totalSections = 0;

    for (const course of courses) {
      try {
        const res = await processCourse(context, page, course, config, logger);
        totalSaved += res.saved;
        totalSections += res.sectionsDone;
      } catch (err) {
        logger.error(`Курс «${course.name}» завершился с ошибкой: ${err.message}`);
      }
    }

    logger.info(`\n✓ Готово. Скачано файлов: ${totalSaved}. Заполнено секций: ${totalSections}.`);
    logger.info(`Лог: ${logger.logPath}`);
    return 0;
  } finally {
    await context.close();
  }
}

module.exports = { run };
