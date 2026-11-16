import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { renderView } from '../admin/views.js';

const VIEWS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'admin', 'views');
const req = { query: {} };

function* ejsFiles(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* ejsFiles(p);
    else if (p.endsWith('.ejs')) yield p;
  }
}

test('views print raw (<%-) only include() and the trusted CSS/logo', () => {
  for (const file of ejsFiles(VIEWS)) {
    for (const m of readFileSync(file, 'utf8').matchAll(/<%-\s*([^%]*?)\s*%>/g)) {
      assert.match(m[1], /^(include\(|h\.CSS$|h\.LOGO$)/, `${path.relative(VIEWS, file)}: <%- ${m[1]} %>`);
    }
  }
});

test('user data in a list row is escaped', async () => {
  const r = { id: 1, name: '<script>alert(1)</script>', surname: '"x', email: 'a@b', notifications: 0, canali: '', keyword: '<b>', last_login: null, moodle: false };
  const out = await renderView('pages/utenti/row', { r }, req);
  assert.ok(!out.includes('<script>'));
  assert.ok(out.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(out.includes('&#34;x') || out.includes('&quot;x'));
  assert.ok(out.includes('&lt;b&gt;'));
});

test('empty list shows its empty text', async () => {
  const out = await renderView('components/list', { cols: [], rows: [], total: 0, page: 1, perPage: 50, ord: '', dir: '', emptyText: 'Vuoto <x>' }, req);
  assert.match(out, /<p class="empty">Vuoto &lt;x&gt;<\/p>/);
});
