/**
 * download_lectures.js
 * ====================
 * Скачивает все лекции с Moodle LMS (itcareerhub.de) и сохраняет их по
 * предметам в том же формате, что виден на странице курса:
 *   - mod/resource → файл (PDF/PPTX и т.п.) с серверным именем;
 *   - mod/assign / mod/page → сохранённая HTML-страница активности.
 *
 * Структура результата:
 *   TARGET_ROOT/<Предмет>/NN - <Название секции>/<файлы>
 *
 * ЗАПУСК:
 *   1. npm install && npx playwright install chromium   (один раз)
 *   2. Скопировать .env.example → .env и заполнить логин/пароль
 *   3. node download_lectures.js
 *
 * Сессия (токен) сохраняется в .pw-lms-profile/ и session.json и
 * переиспользуется. Все действия пишутся в logs/run_<timestamp>.log.
 */

const config = require('./src/config');
const { Logger } = require('./src/logger');
const { run } = require('./src/main');

const logger = new Logger();

run(config, logger)
  .then(async (code) => {
    await logger.close();
    process.exitCode = code || 0;
  })
  .catch(async (err) => {
    logger.error(`Критическая ошибка: ${err && err.stack ? err.stack : err}`);
    await logger.close();
    process.exitCode = 1;
  });
