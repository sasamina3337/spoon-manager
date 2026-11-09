import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {renderDashboard} from '../desktop/renderer/popup/dashboard.js';
import {analyzeSessions} from '../desktop/renderer/shared/analytics.js';

const html = readFileSync(new URL('../desktop/renderer/popup/popup.html', import.meta.url), 'utf8');

test('unified UI has unique controls, valid labels and one settings form/save action', () => {
  const {document} = new JSDOM(html).window;
  const ids = [...document.querySelectorAll('[id]')].map(item => item.id);
  assert.equal(ids.length, new Set(ids).size);
  for (const label of document.querySelectorAll('[for]')) assert.ok(document.getElementById(label.getAttribute('for')), label.outerHTML);
  for (const item of document.querySelectorAll('[aria-labelledby], [aria-describedby]')) {
    for (const id of `${item.getAttribute('aria-labelledby') || ''} ${item.getAttribute('aria-describedby') || ''}`.trim().split(/\s+/)) assert.ok(document.getElementById(id), id);
  }
  assert.equal(document.querySelectorAll('form').length, 1);
  assert.equal(document.querySelectorAll('button[type="submit"]').length, 1);
  assert.equal(document.querySelectorAll('[data-view]').length, 6);
  for (const link of document.querySelectorAll('a[target="_blank"]')) assert.match(link.rel, /noopener|noreferrer/);
});

test('dashboard chart/report agree, safely display names and retain focused controls on unchanged polls', () => {
  const dom = new JSDOM(html); globalThis.document = dom.window.document;
  try {
    const sessions = [2, 1].map(id => ({key: `api:dj:${id}`, live: {title: `<img src=x onerror=alert(1)>${id}`},
      observedAt: `2026-10-${20 + id}T10:00:00Z`, endedAt: `2026-10-${20 + id}T11:00:00Z`,
      totals: {comments: id * 10, hearts: id * 100, spoons: id * 5}, users: [{id: 'api:dj:u', name: '<script>bad</script>', spoons: id * 5}]}));
    const analysis = analyzeSessions(sessions, {key: 'api:dj:2', now: Date.parse('2026-10-24')});
    const chosen = []; renderDashboard(analysis, key => chosen.push(key));
    assert.equal(document.getElementById('analysis-spoons').textContent, '15');
    assert.equal(document.querySelectorAll('#analysis-rows tr').length, 2);
    assert.equal(document.querySelectorAll('#contributors script').length, 0);
    assert.equal(document.querySelectorAll('#analysis-rows img').length, 0);
    const buttons = document.querySelectorAll('#trend-chart button');
    assert.equal(buttons.length, 2); buttons[0].click(); assert.deepEqual(chosen, ['api:dj:1']);
    buttons[0].focus(); renderDashboard(analysis, key => chosen.push(key));
    assert.equal(document.activeElement, buttons[0]);
    document.getElementById('trend-metric').value = 'comments'; renderDashboard(analysis, key => chosen.push(key));
    assert.match(document.getElementById('trend-chart').getAttribute('aria-label'), /コメント/);
    assert.equal(document.querySelector('#trend-chart strong').textContent, '10');
  } finally { delete globalThis.document; dom.window.close(); }
});
