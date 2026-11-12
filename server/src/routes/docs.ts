// Serves the hand-written OpenAPI document and a small page that renders it.
// The page is self-contained: no scripts or styles from other hosts.

import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { parse } from 'yaml';

export const OPENAPI_FILE = new URL('../../openapi.yaml', import.meta.url);

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Loopwell API</title>
<style>
  :root { --bg: #f4f1ea; --fg: #1d1b18; --dim: #6b655c; --line: #d8d2c6; --card: #fffdf8; --accent: #b4532a; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #1d1b18; --fg: #ece7dc; --dim: #a39c8f; --line: #3a362f; --card: #26231f; --accent: #e08a5b; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 16px 64px; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 860px; margin: 0 auto; }
  h1 { margin: 0 0 4px; font-size: 28px; }
  h2 { margin: 36px 0 8px; font-size: 18px; border-bottom: 1px solid var(--line); padding-bottom: 6px; }
  p { margin: 6px 0; }
  a { color: var(--accent); }
  code, .path { font-family: ui-monospace, monospace; font-size: 13px; }
  .dim { color: var(--dim); }
  details { background: var(--card); border: 1px solid var(--line); border-radius: 8px; margin: 8px 0; }
  summary { cursor: pointer; padding: 9px 12px; display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
  .method { font: 700 12px ui-monospace, monospace; min-width: 52px; }
  .GET { color: #2f7d4f; } .POST { color: #2b6cb0; } .PUT { color: #a36a00; } .PATCH { color: #7c4dbd; } .DELETE { color: #c0392b; }
  .path { overflow-wrap: anywhere; }
  .body { padding: 0 12px 12px; border-top: 1px solid var(--line); }
  .lock { font-size: 12px; border: 1px solid var(--line); border-radius: 10px; padding: 0 7px; }
  table { border-collapse: collapse; width: 100%; margin: 6px 0; }
  td, th { text-align: left; vertical-align: top; padding: 4px 8px 4px 0; border-bottom: 1px solid var(--line); font-size: 13px; }
  .scroll { overflow-x: auto; }
  pre { white-space: pre-wrap; margin: 6px 0; }
</style>
</head>
<body>
<main id="app"><p class="dim">Loading the API description&hellip;</p></main>
<script>
(async () => {
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    for (const kid of kids) if (kid != null) n.append(kid);
    return n;
  };
  const app = document.getElementById('app');
  let spec;
  try {
    spec = await (await fetch('openapi.json')).json();
  } catch {
    app.replaceChildren(el('p', {}, 'Could not load openapi.json.'));
    return;
  }
  const deref = (o) => {
    if (!o || !o.$ref) return o;
    return o.$ref.replace(/^#\\//, '').split('/').reduce((n, key) => n && n[key], spec);
  };
  const typeOf = (s) => {
    s = deref(s) || {};
    if (s.enum) return s.enum.join(' | ');
    if (s.type === 'array') return typeOf(s.items) + '[]';
    return [].concat(s.type || 'object').join(' | ');
  };
  const table = (head, rows) => el('div', { class: 'scroll' }, el('table', {},
    el('tr', {}, ...head.map((h) => el('th', {}, h))),
    ...rows.map((r) => el('tr', {}, ...r.map((c, i) => el('td', {}, i === 0 ? el('code', {}, c) : c))))));
  const fields = (schema) => {
    schema = deref(schema) || {};
    const required = schema.required || [];
    return Object.entries(schema.properties || {}).map(([name, s]) => [name + (required.includes(name) ? ' *' : ''), typeOf(s), (deref(s) || {}).description || '']);
  };

  const out = [el('h1', {}, spec.info.title), el('p', { class: 'dim' }, 'Version ' + spec.info.version + ' \\u00b7 '), el('pre', {}, spec.info.description || '')];
  out[1].append(el('a', { href: 'openapi.json' }, 'openapi.json'));
  const groups = new Map((spec.tags || []).map((t) => [t.name, { tag: t, ops: [] }]));
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const op = item[method];
      if (!op) continue;
      const name = (op.tags || ['Other'])[0];
      if (!groups.has(name)) groups.set(name, { tag: { name }, ops: [] });
      groups.get(name).ops.push({ path, method: method.toUpperCase(), op, shared: item.parameters || [] });
    }
  }
  for (const { tag, ops } of groups.values()) {
    if (!ops.length) continue;
    out.push(el('h2', {}, tag.name));
    if (tag.description) out.push(el('p', { class: 'dim' }, tag.description));
    for (const { path, method, op, shared } of ops) {
      const body = el('div', { class: 'body' });
      if (op.description) body.append(el('pre', {}, op.description));
      const params = shared.concat(op.parameters || []).map(deref);
      if (params.length) {
        body.append(el('p', {}, el('b', {}, 'Parameters')), table(['Name', 'In', 'Type', 'Description'],
          params.map((p) => [p.name + (p.required ? ' *' : ''), p.in, typeOf(p.schema), p.description || ''])));
      }
      const content = (deref(op.requestBody) || {}).content;
      if (content) {
        for (const [type, media] of Object.entries(content)) {
          body.append(el('p', {}, el('b', {}, 'Request body '), el('code', {}, type)));
          const rows = fields(media.schema);
          if (rows.length) body.append(table(['Field', 'Type', 'Description'], rows));
        }
      }
      body.append(el('p', {}, el('b', {}, 'Responses')), table(['Status', 'Description', 'Body'],
        Object.entries(op.responses || {}).map(([status, r]) => {
          r = deref(r);
          const media = r.content && Object.entries(r.content)[0];
          const ref = media && media[1].schema && media[1].schema.$ref;
          return [status, r.description || '', media ? (ref ? ref.split('/').pop() : media[0]) : ''];
        })));
      const locked = op.security && op.security.length && !op.security.some((s) => !Object.keys(s).length);
      out.push(el('details', {},
        el('summary', {}, el('span', { class: 'method ' + method }, method), el('span', { class: 'path' }, path),
          el('span', { class: 'dim' }, op.summary || ''), locked ? el('span', { class: 'lock dim' }, 'token') : null),
        body));
    }
  }
  const schemas = Object.entries((spec.components || {}).schemas || {});
  if (schemas.length) out.push(el('h2', {}, 'Schemas'));
  for (const [name, schema] of schemas) {
    const rows = fields(schema);
    out.push(el('details', {}, el('summary', {}, el('span', { class: 'path' }, name), el('span', { class: 'dim' }, schema.description || '')),
      el('div', { class: 'body' }, rows.length ? table(['Field', 'Type', 'Description'], rows) : el('p', {}, typeOf(schema)))));
  }
  app.replaceChildren(...out);
})();
</script>
</body>
</html>
`;

export async function docsRoutes(app: FastifyInstance): Promise<void> {
  // parsed once at startup, so a broken document fails loudly instead of at request time
  const spec = parse(await readFile(OPENAPI_FILE, 'utf8'));

  app.get('/api/openapi.json', async () => spec);

  app.get('/api/docs', async (_req, reply) => {
    return reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('content-security-policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'")
      .send(PAGE);
  });
}
