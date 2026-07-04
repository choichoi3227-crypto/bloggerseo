import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/sitemap.js', import.meta.url), 'utf8');

test('sitemap and RSS handlers do not emit noindex headers', () => {
  assert.equal(source.includes("'x-robots-tag'  : 'noindex'"), false);
  assert.equal(source.includes("'x-robots-tag': 'noindex'"), false);
  assert.match(source, /'x-robots-tag'\s*:\s*'index, follow'/);
});
