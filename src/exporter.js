/**
 * exporter.js — конвертация сохранённых Moodle-HTML страниц в «новый формат»,
 * сохраняющий весь контекст офлайн:
 *   - <активность>.md      — чистый Markdown (текст инструкций + все ссылки/эмбеды);
 *   - media/               — скачанные изображения и YouTube-видео (mp4);
 *   - _<Курс>_index.md     — оглавление курса.
 *
 * Используется для немецких материалов (IT German), где контент — HTML/видео
 * без PDF. Парсинг HTML — на регулярных выражениях (без сторонних зависимостей).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ensureDir, sanitizeName } = require('./utils');

// ─── Декодирование HTML-сущностей ──────────────────────────────────────────────
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…',
  bdquo: '„', ldquo: '“', rdquo: '”', sbquo: '‚', lsquo: '‘', rsquo: '’',
  szlig: 'ß', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü',
  euro: '€', copy: '©', reg: '®', deg: '°', middot: '·', shy: '',
};

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => (name in NAMED_ENTITIES ? NAMED_ENTITIES[name] : m));
}

function safeCodePoint(cp) {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '';
  }
}

// ─── Вырезка основного региона страницы (без шапки/подвала/навигации) ──────────
function extractMainRegion(html) {
  let start = html.search(/id="region-main"/i);
  if (start === -1) start = html.search(/role="main"/i);
  if (start === -1) start = 0;
  let rest = html.slice(start);
  // Обрезать по началу подвала, чтобы не тянуть соц-ссылки и т.п.
  const footer = rest.search(/<footer\b|id="page-footer"|data-region="footer"/i);
  if (footer !== -1) rest = rest.slice(0, footer);
  return rest;
}

// ─── Инструкции активности → Markdown ──────────────────────────────────────────
function pickInstructionsHtml(mainHtml) {
  // Описание задания (assign) в #intro; для page — основной generalbox.
  const intro = mainHtml.match(/<div[^>]*\bid="intro"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<div)/i);
  if (intro && intro[1] && intro[1].replace(/<[^>]+>/g, '').trim().length > 0) return intro[1];
  const box = mainHtml.match(/<div[^>]*class="[^"]*\bno-overflow\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (box && box[1]) return box[1];
  // Фолбэк: весь main без скриптов/стилей.
  return mainHtml;
}

function htmlToMarkdown(inner) {
  let s = String(inner || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, '');
  s = s.replace(/<(nav|form|button)[\s\S]*?<\/\1>/gi, '');
  // Ссылки → [текст](url)
  s = s.replace(/<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, txt) => {
    const t = txt.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const u = decodeEntities(href);
    if (!t) return u;
    return `[${t}](${u})`;
  });
  s = s.replace(/<h[1-6][^>]*>/gi, '\n\n## ').replace(/<\/h[1-6]>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '\n- ').replace(/<\/li>/gi, '');
  s = s.replace(/<(strong|b)\b[^>]*>/gi, '**').replace(/<\/(strong|b)>/gi, '**');
  s = s.replace(/<(em|i)\b[^>]*>/gi, '*').replace(/<\/(em|i)>/gi, '*');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/p>/gi, '\n\n').replace(/<p[^>]*>/gi, '');
  s = s.replace(/<\/?(div|span|section|article|ul|ol|table|tbody|tr|td|th|figure|figcaption)[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  // Косметика: убрать пустые маркеры эмфазы/заголовков и висячие пункты списка.
  s = s.replace(/\*\*\s*\*\*/g, '');
  s = s.replace(/(^|\n)\s*#{2,}\s*\n+/g, '$1## ');
  s = s.replace(/(^|\n)\s*#{2,}\s*$/g, '$1');
  s = s.replace(/\n-\s*\n+/g, '\n- ');
  s = s.replace(/^\s*(\*\*\s*)+/g, '');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

// ─── Метаданные страницы ───────────────────────────────────────────────────────
function extractMeta(html, courseFolder) {
  const wwwroot = ((html.match(/"wwwroot":"([^"]+)"/) || [])[1] || '').replace(/\\\//g, '/');
  const cmid = (html.match(/\bcmid-(\d+)/) || [])[1] || null;
  const modtype = (html.match(/\bpage-mod-([a-z]+)-view/i) || [])[1] || 'mod';
  let title = (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '';
  title = decodeEntities(title).replace(/\s*\|\s*Your It Career Hub\s*$/i, '').trim();
  // Убрать префикс «<Курс>: »
  title = title.replace(new RegExp('^' + escapeRe(courseFolder) + '\\s*:\\s*', 'i'), '').trim();
  const sourceUrl = wwwroot && cmid ? `${wwwroot}/mod/${modtype}/view.php?id=${cmid}` : null;
  // Пометка проверки (рус.)
  const gradeNote =
    (html.match(/(Задание без проверки преподавателем|Это задание выполняется без проверки[^<.]*|Задание с эталонным ответом|Hausaufgabe)/i) || [])[1] || '';
  return { title, sourceUrl, modtype, cmid, gradeNote: gradeNote.trim() };
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Медиа и внешние ссылки ────────────────────────────────────────────────────
function extractMedia(mainHtml) {
  const iframes = [...mainHtml.matchAll(/<iframe\b[^>]*\bsrc="([^"]+)"/gi)].map((m) =>
    decodeEntities(m[1])
  );
  const links = [...mainHtml.matchAll(/<a\b[^>]*\bhref="([^"]+)"/gi)].map((m) => decodeEntities(m[1]));
  const images = [...mainHtml.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => decodeEntities(m[1]));

  const all = [...iframes, ...links];
  const youtube = new Map(); // id -> watchUrl
  const h5p = new Set();
  const external = new Set();

  for (const url of all) {
    const yt =
      url.match(/youtube\.com\/embed\/([A-Za-z0-9_-]{11})/) ||
      url.match(/youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})/) ||
      url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
    if (yt) {
      youtube.set(yt[1], `https://www.youtube.com/watch?v=${yt[1]}`);
      continue;
    }
    if (/h5p\.com|\/h5p\//i.test(url) && !/h5p-resizer\.js/i.test(url)) {
      h5p.add(url);
      continue;
    }
    if (/^https?:\/\//i.test(url) && !/lms\.itcareerhub\.de/i.test(url)) {
      external.add(url);
    }
  }

  // Картинки только из pluginfile (контентные), не темовые иконки.
  const contentImages = images.filter((u) => /pluginfile\.php/i.test(u));

  return {
    youtube, // Map id->url
    h5p: [...h5p],
    external: [...external],
    images: [...new Set(contentImages)],
    iframes,
  };
}

// ─── Скачивание ────────────────────────────────────────────────────────────────
function downloadYouTube(videoId, mediaDir, baseName, logger) {
  ensureDir(mediaDir);
  // Идемпотентность: если файл уже есть — пропускаем.
  const existing = fs
    .readdirSync(mediaDir)
    .find((f) => f.includes(videoId) && /\.(mp4|mkv|webm)$/i.test(f));
  if (existing) {
    logger.info(`      видео уже есть: ${existing}`);
    return path.join(mediaDir, existing);
  }
  const outTpl = path.join(mediaDir, `${sanitizeName(baseName)} [${videoId}].%(ext)s`);
  try {
    execFileSync(
      'python',
      [
        '-m', 'yt_dlp',
        '--no-playlist', '--quiet', '--no-warnings', '--retries', '3',
        // Ограничиваем 720p — для учебных видео достаточно, файлы разумного размера.
        '-f', 'bv*[height<=720]+ba/b[height<=720]/bv*+ba/b',
        '--merge-output-format', 'mp4',
        '-o', outTpl,
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], timeout: 300000 }
    );
    const saved = fs.readdirSync(mediaDir).find((f) => f.includes(videoId));
    logger.info(`      + видео: ${saved || videoId}`);
    return saved ? path.join(mediaDir, saved) : null;
  } catch (err) {
    const msg = (err.stderr && err.stderr.toString().trim().split('\n').pop()) || err.message;
    logger.warn(`      ! не удалось скачать видео ${videoId}: ${msg}`);
    return null;
  }
}

async function downloadImage(requestContext, url, mediaDir, logger) {
  ensureDir(mediaDir);
  try {
    const r = await requestContext.get(url, { timeout: 60000 });
    if (!r.ok()) return null;
    let name = sanitizeName(path.basename(new URL(url).pathname)) || 'image';
    if (!/\.[a-z0-9]+$/i.test(name)) name += '.png';
    const target = path.join(mediaDir, name);
    if (!fs.existsSync(target)) fs.writeFileSync(target, await r.body());
    return target;
  } catch (err) {
    logger.warn(`      ! изображение не скачано: ${err.message}`);
    return null;
  }
}

// ─── Обработка одного HTML-файла ───────────────────────────────────────────────
async function exportHtmlFile(htmlPath, courseFolder, requestContext, logger) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const meta = extractMeta(html, courseFolder);
  const main = extractMainRegion(html);
  const instructions = htmlToMarkdown(pickInstructionsHtml(main));
  const media = extractMedia(main);

  const dir = path.dirname(htmlPath);
  const baseName = path.basename(htmlPath, '.html');
  const mediaDir = path.join(dir, 'media');

  // Скачивание видео
  const savedVideos = [];
  for (const [id] of media.youtube) {
    const saved = downloadYouTube(id, mediaDir, baseName, logger);
    if (saved) savedVideos.push({ id, file: path.relative(dir, saved) });
  }
  // Скачивание контентных изображений
  const savedImages = [];
  if (requestContext) {
    for (const img of media.images) {
      const saved = await downloadImage(requestContext, img, mediaDir, logger);
      if (saved) savedImages.push(path.relative(dir, saved));
    }
  }

  // Сборка Markdown
  const lines = [];
  lines.push(`# ${meta.title || baseName}`);
  lines.push('');
  lines.push(`- **Курс:** ${courseFolder}`);
  lines.push(`- **Секция:** ${path.basename(dir)}`);
  lines.push(`- **Тип активности:** ${meta.modtype}`);
  if (meta.gradeNote) lines.push(`- **Проверка:** ${meta.gradeNote}`);
  if (meta.sourceUrl) lines.push(`- **Источник (LMS):** ${meta.sourceUrl}`);
  lines.push(`- **Оригинал:** ${path.basename(htmlPath)}`);
  lines.push('');
  lines.push('## Инструкции');
  lines.push('');
  lines.push(instructions || '_(текст инструкций не найден — см. оригинал HTML)_');
  lines.push('');

  const hasMedia =
    media.youtube.size || media.h5p.length || media.external.length || savedImages.length;
  if (hasMedia) {
    lines.push('## Медиа и ссылки');
    lines.push('');
    for (const [id, url] of media.youtube) {
      const local = savedVideos.find((v) => v.id === id);
      lines.push(`- **YouTube:** ${url} (id \`${id}\`)${local ? ` → \`${local.file}\`` : ''}`);
    }
    for (const url of media.h5p) {
      lines.push(`- **H5P (интерактив, только ссылка):** ${url}`);
    }
    for (const url of media.external) {
      lines.push(`- **Ссылка:** ${url}`);
    }
    for (const img of savedImages) {
      lines.push(`- **Изображение:** \`${img}\``);
    }
    lines.push('');
  }

  const mdPath = path.join(dir, `${baseName}.md`);
  fs.writeFileSync(mdPath, lines.join('\n'), 'utf8');

  return {
    mdPath,
    title: meta.title || baseName,
    section: path.basename(dir),
    sourceUrl: meta.sourceUrl,
    instructions,
    videos: savedVideos.length,
    h5p: media.h5p.length,
    external: media.external.length,
    images: savedImages.length,
  };
}

function walkHtml(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkHtml(full, acc);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.html')) acc.push(full);
  }
  return acc;
}

// ─── Экспорт всего курса ───────────────────────────────────────────────────────
async function exportCourse(config, logger, courseFolder, requestContext) {
  const coursePath = path.join(config.TARGET_ROOT, courseFolder);
  if (!fs.existsSync(coursePath)) {
    logger.error(`Папка курса не найдена: ${coursePath}`);
    return { processed: 0 };
  }

  const files = walkHtml(coursePath, []).sort((a, b) =>
    a.localeCompare(b, 'ru', { numeric: true })
  );
  logger.info(`\n=== Экспорт «${courseFolder}» ===`);
  logger.info(`HTML-страниц к обработке: ${files.length}`);

  const results = [];
  for (const f of files) {
    logger.info(`  • ${path.relative(coursePath, f)}`);
    try {
      const r = await exportHtmlFile(f, courseFolder, requestContext, logger);
      results.push(r);
      logger.info(
        `    + ${path.basename(r.mdPath)} (видео:${r.videos}, h5p:${r.h5p}, ссылки:${r.external}, img:${r.images})`
      );
    } catch (err) {
      logger.error(`    ! ошибка экспорта ${path.basename(f)}: ${err.message}`);
    }
  }

  // Индекс курса
  const idx = [];
  idx.push(`# ${courseFolder} — оглавление`);
  idx.push('');
  idx.push(`Сгенерировано экспортом HTML→Markdown. Всего активностей: ${results.length}.`);
  idx.push('');
  idx.push('| № | Активность | Задание (кратко) | Видео | H5P | Ссылки |');
  idx.push('|---|------------|------------------|:-----:|:---:|:------:|');
  results.forEach((r, i) => {
    const brief = (r.instructions || '')
      .replace(/\n+/g, ' ')
      .replace(/\|/g, '/')
      .slice(0, 80)
      .trim();
    const mdRel = path.relative(coursePath, r.mdPath).replace(/\\/g, '/');
    idx.push(
      `| ${i + 1} | [${r.title.replace(/\|/g, '/')}](${encodeURI(mdRel)}) | ${brief} | ${r.videos} | ${r.h5p} | ${r.external} |`
    );
  });
  idx.push('');
  const idxPath = path.join(coursePath, `_${sanitizeName(courseFolder)}_index.md`);
  fs.writeFileSync(idxPath, idx.join('\n'), 'utf8');
  logger.info(`\nИндекс: ${idxPath}`);

  return { processed: results.length, indexPath: idxPath, results };
}

module.exports = {
  decodeEntities,
  extractMainRegion,
  pickInstructionsHtml,
  htmlToMarkdown,
  extractMeta,
  extractMedia,
  downloadYouTube,
  downloadImage,
  exportHtmlFile,
  exportCourse,
  walkHtml,
};
