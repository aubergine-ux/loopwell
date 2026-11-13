// The performance budget: how much the browser has to fetch before the app can
// be used, and a check that the heavy things stay out of it. Run after a
// build (npm run budget); CI fails if a limit is passed.
//
// The limits are in perf-budget.json. They are a little above where the app
// is, so that growth is noticed and decided on, not drifted into.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

interface Budget {
  /** Kilobytes, gzipped, of everything index.html loads before the app starts. */
  startJsGzip: number; startCssGzip: number;
  /** Kilobytes, as they are on disk. */
  startJsRaw: number;
  /** The player other sites embed, all of it, gzipped. */
  embedGzip: number;
  /** Things that must be fetched only when used: a name for each, and a pattern its file matches. */
  lazy: Record<string, string>;
  /** Text that only appears inside a heavy library: finding it in a startup file means the library came along. */
  absent: Record<string, string>;
}
const budget = JSON.parse(readFileSync('perf-budget.json', 'utf8')) as Budget;
const kb = (n: number) => n / 1024;
const assets = readdirSync('dist/assets');

/** Every file a page asks for up front: its scripts, the modules they preload, and its stylesheets. */
function upFront(page: string): { js: string[]; css: string[] } {
  const html = readFileSync(`dist/${page}`, 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="\.\/(assets\/[^"]+)"/g)].map((m) => m[1]);
  return { js: [...new Set(refs.filter((r) => r.endsWith('.js')))], css: [...new Set(refs.filter((r) => r.endsWith('.css')))] };
}
const size = (files: string[]) => files.reduce((s, f) => ({ raw: s.raw + statSync(`dist/${f}`).size, gz: s.gz + gzipSync(readFileSync(`dist/${f}`), { level: 9 }).length }), { raw: 0, gz: 0 });

const app = upFront('index.html'), embed = upFront('embed.html');
const js = size(app.js), css = size(app.css), em = size([...embed.js, ...embed.css]);
let failed = false;
function line(what: string, got: number, limit: number): void {
  const over = got > limit;
  if (over) failed = true;
  console.log(`  ${over ? 'OVER' : 'ok  '}  ${what.padEnd(34)} ${got.toFixed(1).padStart(7)} kB   (limit ${limit} kB)`);
}
console.log('Before the app can be used, the browser fetches:');
for (const f of app.js) console.log(`        ${f.padEnd(46)} ${kb(statSync(`dist/${f}`).size).toFixed(1).padStart(7)} kB`);
line('scripts, gzipped', kb(js.gz), budget.startJsGzip);
line('scripts, as they are', kb(js.raw), budget.startJsRaw);
line('styles, gzipped', kb(css.gz), budget.startCssGzip);
line('the embedded player, gzipped', kb(em.gz), budget.embedGzip);

console.log('\nFetched only when used:');
for (const [name, pattern] of Object.entries(budget.lazy)) {
  const re = new RegExp(pattern);
  const found = assets.filter((a) => re.test(a));
  const early = found.filter((a) => app.js.includes(`assets/${a}`));
  const ok = found.length > 0 && early.length === 0;
  if (!ok) failed = true;
  const total = found.reduce((s, a) => s + statSync(`dist/assets/${a}`).size, 0);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(34)} ${found.length ? `${kb(total).toFixed(0).padStart(7)} kB in ${found.length} file${found.length === 1 ? '' : 's'}` : 'not found: is it still split out?'}${early.length ? `  loaded at startup: ${early.join(', ')}` : ''}`);
}
const startup = app.js.map((f) => ({ f, text: readFileSync(`dist/${f}`, 'utf8') }));
for (const [name, marker] of Object.entries(budget.absent)) {
  const inside = startup.filter((s) => s.text.includes(marker)).map((s) => s.f);
  if (inside.length) failed = true;
  console.log(`  ${inside.length ? 'FAIL' : 'ok  '}  ${`no ${name} at startup`.padEnd(34)} ${inside.length ? `found in ${inside.join(', ')}` : ''}`);
}
if (failed) { console.error('\nOver budget. Load the new code on demand, or raise the limit in perf-budget.json on purpose.'); process.exit(1); }
console.log('\nWithin budget.');
