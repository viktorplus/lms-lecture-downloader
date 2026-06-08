/**
 * lms.js — навигация по Moodle: список курсов и активностей в курсе.
 *
 * Скачиваемые типы активностей (как в эталоне + разумное обобщение):
 *   resource → файл (PDF/PPTX...)   downloadable: file
 *   assign   → HTML-страница задания  downloadable: html
 *   page     → HTML-страница лекции   downloadable: html
 *   folder   → набор файлов           downloadable: folder
 * Прочее (quiz, url, forum, ...) пропускается.
 */

const { normalizeCourseName } = require('./utils');

const DOWNLOADABLE_TYPES = new Set(['resource', 'assign', 'page', 'folder']);

async function getMyCourses(page, config, logger) {
  await page.goto(config.MY_COURSES_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('a[href*="/course/view.php?id="]', { timeout: 30000 });

  const courses = await page.evaluate(() => {
    const byHref = new Map();
    for (const a of document.querySelectorAll('a[href*="/course/view.php?id="]')) {
      const href = a.href;
      const text = (a.textContent || '').trim().replace(/\s+/g, ' ');
      if (!href || !/id=\d+/.test(href) || !text) continue;
      if (!byHref.has(href) || text.length > byHref.get(href).name.length) {
        byHref.set(href, { href, name: text });
      }
    }
    return Array.from(byHref.values());
  });

  const result = courses
    .map((c) => {
      const idMatch = c.href.match(/id=(\d+)/);
      return {
        id: idMatch ? Number(idMatch[1]) : null,
        href: c.href,
        name: c.name,
        normalized: normalizeCourseName(c.name),
      };
    })
    .filter((c) => c.id);

  logger.info(`Найдено курсов на /my/: ${result.length}.`);
  return result;
}

/**
 * Парсит секции курса и активности в них. Возвращает массив секций вида
 * { heading, activities: [{ type, name, href }] }, где остаются только
 * секции с хотя бы одной скачиваемой активностью. Активности дедуплицируются
 * по href (на странице ссылка-иконка и ссылка-текст дублируют друг друга).
 */
async function getCourseActivities(page) {
  await page.waitForSelector('li[id^="section-"]', { timeout: 30000 });

  return page.evaluate((downloadableTypes) => {
    function cleanName(raw) {
      let s = (raw || '').trim().replace(/\s+/g, ' ');
      // Срезать статус проверки задания (галочка/оценка), которого нет в
      // эталонных именах: «✓ Зачёт», «— не проверено» и т.п.
      s = s.replace(/\s*[✓✔✗✕☑].*$/u, '');
      s = s.replace(
        /\s*[—–-]\s*(не проверено|проверено|требует оценки|сдано|не сдано|просрочено|ожидает( оценки)?|за[чн]ё?т[^]*)\b.*$/i,
        ''
      );
      s = s.replace(/\s*\b(Зачёт|Незачёт)\b\s*$/i, '');
      return s.trim();
    }

    const sections = [];
    for (const sec of document.querySelectorAll('li[id^="section-"]')) {
      const h = sec.querySelector('h3.sectionname') || sec.querySelector('h3') || sec.querySelector('.sectionname');
      const heading = (h?.textContent || '').trim().replace(/\s+/g, ' ');

      const byHref = new Map();
      for (const a of sec.querySelectorAll('a[href*="/mod/"][href*="view.php?id="]')) {
        const typeMatch = a.href.match(/\/mod\/([a-z]+)\/view\.php/);
        const type = typeMatch ? typeMatch[1] : '';
        if (!downloadableTypes.includes(type)) continue;

        const inst = a.querySelector('.instancename');
        let name;
        if (inst) {
          const clone = inst.cloneNode(true);
          clone.querySelectorAll('.accesshide').forEach((e) => e.remove());
          name = clone.textContent;
        } else {
          name = a.textContent;
        }
        name = cleanName(name);

        const existing = byHref.get(a.href);
        if (!existing || (name && name.length > existing.name.length)) {
          byHref.set(a.href, { type, name, href: a.href });
        }
      }

      const activities = Array.from(byHref.values());
      if (activities.length > 0) {
        sections.push({ heading: heading || 'Section', activities });
      }
    }
    return sections;
  }, Array.from(DOWNLOADABLE_TYPES));
}

module.exports = { getMyCourses, getCourseActivities, DOWNLOADABLE_TYPES };
