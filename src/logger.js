/**
 * logger.js — логирование всех действий в файл logs/run_<timestamp>.log и в консоль.
 * Нужно для поиска ошибок после автоматических прогонов.
 */

const fs = require('fs');
const path = require('path');
const { LOGS_DIR } = require('./config');

function timestampForFile(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function timestampIso(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

class Logger {
  constructor() {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    this.logPath = path.join(LOGS_DIR, `run_${timestampForFile()}.log`);
    this.stream = fs.createWriteStream(this.logPath, { flags: 'a' });
    this.line('INFO', `Лог запуска: ${this.logPath}`);
  }

  line(level, message) {
    const text = `[${timestampIso()}] [${level}] ${message}`;
    // В консоль — без префикса времени для читаемости, в файл — полностью.
    if (level === 'ERROR') {
      console.error(message);
    } else {
      console.log(message);
    }
    this.stream.write(text + '\n');
  }

  info(msg) { this.line('INFO', msg); }
  warn(msg) { this.line('WARN', msg); }
  error(msg) { this.line('ERROR', msg); }
  debug(msg) { this.stream.write(`[${timestampIso()}] [DEBUG] ${msg}\n`); }

  close() {
    return new Promise((resolve) => this.stream.end(resolve));
  }
}

module.exports = { Logger, timestampForFile };
