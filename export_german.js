/**
 * export_german.js
 * ================
 * Конвертирует сохранённые Moodle-HTML страницы немецких курсов в «новый
 * формат», сохраняющий весь контекст офлайн:
 *   - <активность>.md      — Markdown (текст инструкций + все ссылки/эмбеды);
 *   - media/*.mp4          — скачанные YouTube-видео (через yt-dlp);
 *   - media/*.{png,jpg}    — контентные изображения страницы;
 *   - _<Курс>_index.md     — оглавление курса.
 *
 * Запуск:
 *   node export_german.js                  # курс по умолчанию (IT German)
 *   node export_german.js "Имя папки курса"
 *
 * Для скачивания видео нужен yt-dlp:  python -m pip install yt-dlp
 */

const { chromium } = require('playwright');
const config = require('./src/config');
const { Logger } = require('./src/logger');
const { ensureAuthenticated } = require('./src/auth');
const { exportCourse } = require('./src/exporter');

const DEFAULT_COURSE = 'IT German_General_2025_DA_WD_PD';

async function main() {
  const logger = new Logger();
  const courseFolder = process.argv[2] || DEFAULT_COURSE;

  // Браузер нужен только для скачивания контентных изображений (pluginfile
  // требует сессии). Видео и Markdown работают и без него.
  const context = await chromium.launchPersistentContext(config.PROFILE_DIR, {
    headless: config.HEADLESS,
    acceptDownloads: true,
    viewport: { width: 1400, height: 900 },
  });
  const page = context.pages()[0] || (await context.newPage());

  let requestContext = null;
  try {
    const auth = await ensureAuthenticated(context, page, config, logger);
    if (auth.ok) {
      requestContext = context.request;
    } else {
      logger.warn('Нет авторизации — изображения из pluginfile пропущу, видео и текст обработаю.');
    }

    const res = await exportCourse(config, logger, courseFolder, requestContext);
    logger.info(`\n✓ Готово. Обработано активностей: ${res.processed}.`);
    logger.info(`Лог: ${logger.logPath}`);
    return 0;
  } finally {
    await context.close();
    await logger.close();
  }
}

main().then((code) => {
  process.exitCode = code || 0;
}).catch((err) => {
  console.error('Критическая ошибка:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
