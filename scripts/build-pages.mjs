#!/usr/bin/env node
/**
 * 建立 GitHub Pages 用的純靜態版本（輸出到 dist/）。
 *
 * GitHub Pages 只提供靜態檔案、不能跑 Node 伺服器，所以這裡做兩件事：
 *   1. 複製前端檔案（index.html / styles.css / app.js / theme-init.js）
 *   2. 產生 app.config.js，把「聯機 / 交換色紙」改成離線模式
 *      （查詢程式暫時沒有雲端伺服器時，介面會清楚說明，而不是卡在連線中）
 *
 * 用法： node scripts/build-pages.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

// 可以透過環境變數指定雲端伺服器，例如在 GitHub Actions 的 repo variables 設 PAGES_BACKEND
const apiBase = (process.env.PAGES_BACKEND || '').trim().replace(/\/$/, '');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const files = ['index.html', 'styles.css', 'app.js', 'theme-init.js'];
for (const f of files) {
  const src = path.join(root, f);
  if (!fs.existsSync(src)) throw new Error(`找不到 ${f}`);
  fs.copyFileSync(src, path.join(dist, f));
}
fs.copyFileSync(path.join(root, '.nojekyll'), path.join(dist, '.nojekyll'));

const config = `/* 由 scripts/build-pages.mjs 產生 */
window.COLORPAPER_CONFIG = ${JSON.stringify({ apiBase, staticHost: !apiBase }, null, 2)};
`;
fs.writeFileSync(path.join(dist, 'app.config.js'), config);

// 應該已經由 index.html 載入；若否也自動補上（放在 app.js 之前）
const indexPath = path.join(dist, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
if (!html.includes('app.config.js')) {
  html = html.replace('<script src="app.js" defer></script>', '<script src="app.config.js"></script>\n  <script src="app.js" defer></script>');
  fs.writeFileSync(indexPath, html);
}

console.log(`✅ dist/ 已建立（${files.length + 2} 個檔案）${apiBase ? `｜聯機後端：${apiBase}` : '｜聯機：單機模式（需指定 PAGES_BACKEND 才有聯機）'}`);
