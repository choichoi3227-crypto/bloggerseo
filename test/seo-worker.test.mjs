import test from 'node:test';
import assert from 'node:assert/strict';
import { isTitleSlugPath, normalizePublicBase, buildSeoWorkPlan } from '../src/seo-utils.js';

test('title slug validation rejects Blogger origin paths and reserved paths', () => {
  assert.equal(isTitleSlugPath('/perfect-seo-title'), true);
  assert.equal(isTitleSlugPath('/완벽한-seo-제목'), true);
  assert.equal(isTitleSlugPath('/2026/06/post.html'), false);
  assert.equal(isTitleSlugPath('/p/about'), false);
  assert.equal(isTitleSlugPath('/search/label/seo'), false);
});

test('public base normalization rejects internal hosts', () => {
  assert.equal(normalizePublicBase('example.com'), 'https://example.com');
  assert.equal(normalizePublicBase('https://demo.blogspot.com'), '');
  assert.equal(normalizePublicBase('https://worker.example.workers.dev'), '');
});

test('SEO work plan only emits canonical title slugs', () => {
  const plan = buildSeoWorkPlan([
    { originPath: '/2026/06/default.html', titlePath: '/perfect-title', title: 'Perfect Title' },
    { originPath: '/2026/06/missing.html', titlePath: '' },
    { originPath: '/p/about', titlePath: '/about' },
  ], 'example.com');
  assert.equal(plan.ok, true);
  assert.equal(plan.canonical.length, 1);
  assert.equal(plan.canonical[0].canonicalUrl, 'https://example.com/perfect-title');
  assert.equal(plan.skipped.length, 2);
});
