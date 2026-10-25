// Rebuild the self-hosted text subset after changing LP copy. No visitor requests Google Fonts.
import { readFile, writeFile } from 'node:fs/promises';
const root = new URL('../workers/api/public/', import.meta.url);
const sources = await Promise.all(
  [
    'index.html',
    'privacy.html',
    'terms.html',
    'legal/archive/privacy-2026-10-25.html',
    'credits.html',
    'assets/site.js',
  ].map((path) => readFile(new URL(path, root), 'utf8')),
);
const characters = [
  ...new Set(
    (sources.join('') + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789').match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff00-\uffefA-Za-z0-9]/gu,
    ),
  ),
]
  .sort()
  .join('');
const url = new URL('https://fonts.googleapis.com/css2');
url.searchParams.set('family', 'Noto Sans JP:wght@400..900');
url.searchParams.set('display', 'swap');
url.searchParams.set('text', characters);
const response = await fetch(url, {
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  },
  signal: AbortSignal.timeout(30000),
});
if (!response.ok) throw new Error('Font CSS request failed: ' + response.status);
const css = await response.text();
if (!css.includes('font-weight: 400 900') || !css.includes("format('woff2')"))
  throw new Error('Expected a variable WOFF2 font');
const source = css.match(/src:\s*url\(([^)]+)\)/)?.[1];
if (!source || new URL(source).hostname !== 'fonts.gstatic.com')
  throw new Error('Unexpected font source');
const font = await fetch(source, { signal: AbortSignal.timeout(30000) });
if (!font.ok) throw new Error('Font request failed: ' + font.status);
const bytes = Buffer.from(await font.arrayBuffer());
if (bytes.subarray(0, 4).toString() !== 'wOF2') throw new Error('Invalid WOFF2 header');
await writeFile(new URL('assets/landing-jp.woff2', root), bytes);
console.log(JSON.stringify({ characters: characters.length, fontBytes: bytes.length }));
