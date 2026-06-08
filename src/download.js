/**
 * download.js — загрузка содержимого активностей.
 *   - resource → бинарный файл (следуем редиректам, извлекаем pluginfile.php);
 *   - assign / page → сохранённая HTML-страница активности;
 *   - folder → все файлы из папки.
 */

const fs = require('fs');
const path = require('path');
const {
  sanitizeName,
  uniqueFilePath,
  parseFilenameFromDisposition,
} = require('./utils');

const REDIRECT_CODES = [301, 302, 303, 307, 308];

function extractPluginFileUrls(html, baseUrl) {
  if (!html) return [];
  const candidates = [];
  const patterns = [
    /href=["']([^"']*\/pluginfile\.php[^"']*)["']/gi,
    /window\.location(?:\.href)?\s*=\s*["']([^"']*\/pluginfile\.php[^"']*)["']/gi,
    /url=([^"'\s>]*\/pluginfile\.php[^"'\s>]*)/gi,
    /src=["']([^"']*\/pluginfile\.php[^"']*)["']/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(html)) !== null) {
      if (m[1]) candidates.push(m[1]);
    }
  }
  const urls = [];
  for (const rawCandidate of candidates) {
    const raw = rawCandidate.replace(/&amp;/g, '&');
    try {
      const url = new URL(raw, baseUrl).toString();
      urls.push(url);
    } catch {
      /* пропускаем битые url */
    }
  }
  return urls;
}

function pickResourcePluginUrl(html, baseUrl) {
  for (const url of extractPluginFileUrls(html, baseUrl)) {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.includes('/mod_resource/content/')) return url;
  }
  return null;
}

async function saveBinaryResponse(response, fallbackName, outDir) {
  const disposition = response.headers()['content-disposition'] || '';
  let fileName = parseFilenameFromDisposition(disposition);
  if (!fileName) {
    const urlObj = new URL(response.url());
    const base = path.basename(urlObj.pathname || '') || '';
    fileName = base || `${sanitizeName(fallbackName)}.bin`;
  }
  fileName = sanitizeName(fileName);
  const targetPath = uniqueFilePath(outDir, fileName);
  fs.writeFileSync(targetPath, await response.body());
  return { skipped: false, savedTo: targetPath };
}

async function fetchFollowingRedirect(requestContext, url) {
  let response = await requestContext.get(url, {
    timeout: 60000,
    maxRedirects: 0,
    failOnStatusCode: false,
  });
  if (REDIRECT_CODES.includes(response.status())) {
    const location = response.headers()['location'];
    if (location) {
      const redirected = new URL(location, url).toString();
      response = await requestContext.get(redirected, { timeout: 60000 });
    }
  }
  return response;
}

/** mod/resource → файл. Возвращает { skipped, savedTo, reason }. */
async function downloadResource(requestContext, resourceUrl, fallbackName, outDir) {
  let response = await fetchFollowingRedirect(requestContext, resourceUrl);
  if (!response.ok()) throw new Error(`HTTP ${response.status()} for ${resourceUrl}`);

  let contentType = (response.headers()['content-type'] || '').toLowerCase();
  if (!contentType.includes('text/html')) {
    return saveBinaryResponse(response, fallbackName, outDir);
  }

  // Промежуточная HTML-страница ресурса → ищем прямую ссылку pluginfile.
  const html = await response.text();
  const pluginUrl = pickResourcePluginUrl(html, response.url());
  if (!pluginUrl) return { skipped: true, reason: 'html-without-mod-resource-pluginfile' };

  response = await requestContext.get(pluginUrl, { timeout: 60000 });
  if (!response.ok()) throw new Error(`HTTP ${response.status()} for ${pluginUrl}`);

  contentType = (response.headers()['content-type'] || '').toLowerCase();
  if (contentType.includes('text/html')) return { skipped: true, reason: 'second-hop-html' };

  return saveBinaryResponse(response, fallbackName, outDir);
}

/** mod/assign, mod/page → сохранить отрендеренную HTML-страницу активности. */
async function saveActivityHtml(page, viewUrl, activityName, outDir) {
  await page.goto(viewUrl, { waitUntil: 'domcontentloaded' });
  // Дать догрузиться основному контенту страницы.
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  const html = await page.content();
  const fileName = `${sanitizeName(activityName)}.html`;
  const targetPath = uniqueFilePath(outDir, fileName);
  fs.writeFileSync(targetPath, html, 'utf8');
  return { skipped: false, savedTo: targetPath };
}

/** mod/folder → скачать все файлы из папки. Возвращает { savedCount }. */
async function downloadFolder(requestContext, folderUrl, outDir) {
  const response = await fetchFollowingRedirect(requestContext, folderUrl);
  if (!response.ok()) throw new Error(`HTTP ${response.status()} for ${folderUrl}`);
  const html = await response.text();
  const urls = extractPluginFileUrls(html, response.url()).filter((u) =>
    new URL(u).pathname.toLowerCase().includes('/mod_folder/content/')
  );
  // Убрать дубликаты
  const unique = Array.from(new Set(urls));
  let savedCount = 0;
  const saved = [];
  for (const url of unique) {
    try {
      const r = await requestContext.get(url, { timeout: 60000 });
      if (!r.ok()) continue;
      const ct = (r.headers()['content-type'] || '').toLowerCase();
      if (ct.includes('text/html')) continue;
      const out = await saveBinaryResponse(r, 'file', outDir);
      saved.push(out.savedTo);
      savedCount += 1;
    } catch {
      /* пропускаем отдельный файл */
    }
  }
  return { savedCount, saved };
}

module.exports = { downloadResource, saveActivityHtml, downloadFolder };
