// Guards the two hand-maintained lists of this site's own files against
// drifting out of sync with the code: public/sw.js's SHELL_FILES (what the
// service worker keeps on the device - a missing module would be fetched
// from the network on every cold start, or worse, come from a different
// deploy than the rest) and index.html's modulepreload links (a missing one
// quietly brings back the download waterfall they exist to remove).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const PUBLIC_DIR = new URL('../public/', import.meta.url).pathname;

function listModules(dir = path.join(PUBLIC_DIR, 'lib')) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? listModules(path.join(dir, entry.name)) : entry.name.endsWith('.mjs') ? [path.join(dir, entry.name)] : []
  );
}
const toRelative = file => `./${path.relative(PUBLIC_DIR, file).split(path.sep).join('/')}`;

// Every module actually reachable from app.js through static imports.
function importGraph() {
  const seen = new Set();
  const visit = file => {
    const source = readFileSync(file, 'utf8');
    for (const [, spec] of source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+'(\.[^']+)'/gms)) {
      const target = path.resolve(path.dirname(file), spec);
      const rel = toRelative(target);
      if (seen.has(rel)) continue;
      seen.add(rel);
      visit(target);
    }
  };
  visit(path.join(PUBLIC_DIR, 'app.js'));
  return seen;
}

describe('service worker shell list', () => {
  const sw = readFileSync(path.join(PUBLIC_DIR, 'sw.js'), 'utf8');
  const list = JSON.parse(
    sw
      .match(/const SHELL_FILES = (\[[\s\S]*?\]);/)[1]
      .replace(/'/g, '"')
      .replace(/,\s*\]/, ']')
  );

  test('lists every module under lib/', () => {
    const missing = listModules().map(toRelative).filter(rel => !list.includes(rel));
    assert.deepEqual(missing, []);
  });
  test('every listed file exists', () => {
    const absent = list.filter(rel => rel !== './' && !existsSync(path.join(PUBLIC_DIR, rel)));
    assert.deepEqual(absent, []);
  });
  test('includes the page, app.js and styles', () => {
    for (const rel of ['./', './index.html', './app.js', './styles.css']) assert.ok(list.includes(rel), rel);
  });
});

describe('index.html modulepreload links', () => {
  const html = readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const preloaded = new Set([...html.matchAll(/<link rel="modulepreload" href="([^"]+)"/g)].map(m => m[1]));

  test('preload exactly the modules app.js imports', () => {
    assert.deepEqual([...preloaded].sort(), [...importGraph()].sort());
  });
});

describe('prebuilt snapshot preload', () => {
  test("index.html preloads the same URL app.js fetches", () => {
    const html = readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    const app = readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
    const url = app.match(/const SERVER_SNAPSHOT_URL = '([^']+)'/)[1];
    assert.ok(html.includes(`<link rel="preload" as="fetch" crossorigin href="${url}" />`));
  });
});
