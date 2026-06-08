/**
 * fix_filenames.js
 * ================
 * Чинит уже скачанные файлы/папки с «битыми» именами (мохибейк), возникшими
 * из-за того, что UTF-8 имя из HTTP-заголовка Content-Disposition было прочитано
 * как latin1 (например «Конспект» → «ÐÐ¾Ð½ÑÐ¿ÐµÐºÑ»). Имена переименовываются
 * в правильные, понятные и на macOS, и на Windows.
 *
 * Безопасно:
 *   - трогает ТОЛЬКО имена из latin1-символов (U+0080–U+00FF) без «настоящего»
 *     Unicode и только если перекодировка валидна (round-trip);
 *   - корректные имена (кириллица в HTML, немецкое ü и т.п.) НЕ меняются;
 *   - при конфликте имён пропускает (ничего не удаляет/не перезаписывает).
 *
 * Запуск:
 *   node fix_filenames.js            # переименовать в TARGET_ROOT (из .env)
 *   node fix_filenames.js --dry      # только показать, что будет переименовано
 *   node fix_filenames.js "путь"     # указать папку явно
 */

const fs = require('fs');
const path = require('path');
const config = require('./src/config');
const { fixHeaderMojibake } = require('./src/utils');

const DRY = process.argv.includes('--dry');
const target =
  process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) || config.TARGET_ROOT;

const stats = { renamed: [], collisions: [], scanned: 0 };

function repairDir(dir) {
  // Сначала рекурсивно обрабатываем подпапки (имена ещё старые — пути валидны).
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) repairDir(path.join(dir, e.name));
  }
  // Затем переименовываем записи в текущей папке (файлы и уже обработанные подпапки).
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    stats.scanned += 1;
    const fixed = fixHeaderMojibake(e.name);
    if (!fixed || fixed === e.name) continue;
    const from = path.join(dir, e.name);
    const to = path.join(dir, fixed);
    if (fs.existsSync(to)) {
      stats.collisions.push(path.relative(target, from));
      continue;
    }
    if (!DRY) fs.renameSync(from, to);
    stats.renamed.push([path.relative(target, from), fixed]);
  }
}

function main() {
  if (!fs.existsSync(target)) {
    console.error(`Папка не найдена: ${target}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${DRY ? '[DRY RUN] ' : ''}Чиню имена в: ${target}\n`);
  repairDir(target);

  for (const [from, to] of stats.renamed) {
    console.log(`  ${DRY ? '≈' : '✓'} ${from}  →  ${to}`);
  }
  if (stats.collisions.length) {
    console.log('\nПропущено из-за конфликта имён (целевое имя уже существует):');
    for (const f of stats.collisions) console.log(`  ~ ${f}`);
  }
  console.log(
    `\nПросмотрено: ${stats.scanned} | ${DRY ? 'будет переименовано' : 'переименовано'}: ` +
    `${stats.renamed.length} | конфликтов: ${stats.collisions.length}`
  );
  if (DRY && stats.renamed.length) {
    console.log('\nЗапусти без --dry, чтобы применить.');
  }
}

main();
