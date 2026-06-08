/**
 * config.js — загрузка настроек из .env и значения по умолчанию.
 * Зависимостей нет: .env парсится вручную, чтобы не тянуть dotenv.
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');

function loadEnvFile(envPath) {
  const result = {};
  if (!fs.existsSync(envPath)) return result;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Снять обрамляющие кавычки, если есть
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

const fileEnv = loadEnvFile(path.join(ROOT_DIR, '.env'));

function getEnv(key, fallback) {
  if (process.env[key] !== undefined) return process.env[key];
  if (fileEnv[key] !== undefined) return fileEnv[key];
  return fallback;
}

function toBool(value, fallback) {
  if (value === undefined) return fallback;
  return String(value).toLowerCase() === 'true';
}

const config = {
  ROOT_DIR,
  LMS_EMAIL: getEnv('LMS_EMAIL', ''),
  LMS_PASSWORD: getEnv('LMS_PASSWORD', ''),
  LMS_BASE: getEnv('LMS_BASE', 'https://lms.itcareerhub.de').replace(/\/+$/, ''),
  TARGET_ROOT: getEnv('TARGET_ROOT', path.join(ROOT_DIR, 'downloads')),
  HEADLESS: toBool(getEnv('HEADLESS', 'true'), true),

  // Служебные пути (в .gitignore)
  PROFILE_DIR: path.join(ROOT_DIR, '.pw-lms-profile'),
  SESSION_FILE: path.join(ROOT_DIR, 'session.json'),
  LOGIN_ATTEMPTS_FILE: path.join(ROOT_DIR, '.login_attempts'),
  LOGS_DIR: path.join(ROOT_DIR, 'logs'),

  // Лимит неудачных логинов подряд
  MAX_LOGIN_FAILURES: 5,
};

config.MY_COURSES_URL = `${config.LMS_BASE}/my/`;
config.LOGIN_URL = `${config.LMS_BASE}/login/index.php`;

module.exports = config;
