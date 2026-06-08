/**
 * main.js — оркестрация прогона. Наполняется по мере реализации модулей
 * авторизации, парсинга и загрузки. Сейчас — каркас.
 */

async function run(config, logger) {
  logger.info('Каркас инициализирован.');
  logger.info(`LMS_BASE   = ${config.LMS_BASE}`);
  logger.info(`TARGET_ROOT= ${config.TARGET_ROOT}`);
  logger.info(`HEADLESS   = ${config.HEADLESS}`);
  logger.warn('Логика загрузки ещё не подключена (каркас).');
  return 0;
}

module.exports = { run };
