/**
 * utils.js — общие утилиты: санитизация имён под Windows, нормализация
 * названий курсов, уникальные пути файлов, подсчёт файлов.
 */

const fs = require('fs');
const path = require('path');

function sanitizeName(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .replace(/[. ]+$/, ''); // Windows не разрешает завершающие точки/пробелы
}

function normalizeCourseName(name) {
  let x = String(name || '');
  x = x.replace(/^(Название курса|Kursname|Course name)\s*/i, '');
  x = x.replace(/\s*\(Free schedule\)/gi, '');
  x = x.split('/')[0];
  x = sanitizeName(x);
  return x;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function fileCountRecursive(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) count += fileCountRecursive(full);
    else if (entry.isFile()) count += 1;
  }
  return count;
}

function fileCount(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  return fs.readdirSync(dirPath, { withFileTypes: true }).filter((e) => e.isFile()).length;
}

function uniqueFilePath(dirPath, fileName) {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  let candidate = path.join(dirPath, fileName);
  let idx = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dirPath, `${base} (${idx})${ext}`);
    idx += 1;
  }
  return candidate;
}

function isSameSubject(dirName, baseCourseName, courseId) {
  const dirNorm = normalizeCourseName(dirName);
  const courseNorm = normalizeCourseName(baseCourseName);
  if (dirNorm.toLowerCase() === courseNorm.toLowerCase()) return true;
  if (dirName.toLowerCase().endsWith(`_id${courseId}`.toLowerCase())) return true;
  return false;
}

/**
 * Чинит мохибейк, возникающий когда UTF-8 имя из HTTP-заголовка прочитано как
 * latin1 (например «Конспект» → «ÐÐ¾Ð½ÑÐ¿ÐµÐºÑ»). Безопасно: трогает только
 * строки, состоящие из latin1-символов (U+0080–U+00FF) и не содержащие уже
 * «настоящего» Unicode (≥ U+0100). Если перекодировка невалидна — оставляет
 * как есть. Корректные имена (кириллица, немецкое ü и т.п.) не меняются.
 */
function fixHeaderMojibake(value) {
  const s = String(value || '');
  if (!/[-ÿ]/.test(s)) return s; // нет «подозрительных» байт-символов
  if (/[Ā-￿]/.test(s)) return s;  // уже есть настоящий Unicode — не трогаем
  const bytes = Buffer.from(s, 'latin1');
  const decoded = bytes.toString('utf8');
  if (decoded.includes('�')) return s; // невалидный UTF-8 — оставляем
  if (!Buffer.from(decoded, 'utf8').equals(bytes)) return s; // нет round-trip — оставляем
  return decoded;
}

function parseFilenameFromDisposition(contentDisposition) {
  if (!contentDisposition) return null;
  const utf = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf && utf[1]) {
    try {
      return decodeURIComponent(utf[1]); // %XX как UTF-8 — уже корректно
    } catch {
      return utf[1];
    }
  }
  const plain = contentDisposition.match(/filename="?([^";]+)"?/i);
  if (plain && plain[1]) return fixHeaderMojibake(plain[1]);
  return null;
}

module.exports = {
  sanitizeName,
  normalizeCourseName,
  pad2,
  ensureDir,
  fileCountRecursive,
  fileCount,
  uniqueFilePath,
  isSameSubject,
  parseFilenameFromDisposition,
  fixHeaderMojibake,
};
