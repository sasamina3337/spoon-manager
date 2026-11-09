import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const script = readFileSync(new URL('../desktop/renderer/shared/theme.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../desktop/renderer/popup/popup.html', import.meta.url), 'utf8');
function setup(t, {dark = false, saved, storageBlocked = false} = {}) {
  const dom = new JSDOM(html, {url: 'https://app.test/', runScripts: 'outside-only'});
  t.after(() => dom.window.close());
  const media = {matches: dark, addEventListener(type, listener) {this.change = listener;}};
  dom.window.matchMedia = () => media;
  if (saved !== undefined) dom.window.localStorage.setItem('spoon-manager.theme', saved);
  if (storageBlocked) Object.defineProperty(dom.window, 'localStorage', {get() {throw new Error('Unavailable');}});
  dom.window.eval(script);
  const doc = dom.window.document;
  doc.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  const picker = doc.getElementById('theme-mode');
  const choose = mode => {picker.value = mode; picker.dispatchEvent(new dom.window.Event('change'));};
  return {dom, doc, media, picker, choose};
}

test('theme follows system changes until explicitly selected, and persists across startup', t => {
  const {dom, doc, media, picker, choose} = setup(t, {dark: true});
  assert.equal(doc.documentElement.dataset.theme, 'dark');
  assert.equal(picker.value, 'system');
  media.matches = false; media.change();
  assert.equal(doc.documentElement.dataset.theme, 'light');
  choose('dark');
  assert.equal(dom.window.localStorage.getItem('spoon-manager.theme'), 'dark');
  media.change();
  assert.equal(doc.documentElement.dataset.theme, 'dark');
  const reopened = setup(t, {saved: dom.window.localStorage.getItem('spoon-manager.theme')});
  assert.equal(reopened.doc.documentElement.dataset.theme, 'dark');
  assert.equal(reopened.picker.value, 'dark');
  choose('system');
  assert.equal(doc.documentElement.dataset.theme, 'light');
});

test('invalid preferences, cross-window updates and unavailable storage remain usable', t => {
  const {dom, doc, picker} = setup(t, {saved: 'invalid', dark: true});
  assert.equal(picker.value, 'system');
  dom.window.dispatchEvent(new dom.window.StorageEvent('storage', {key: 'spoon-manager.theme', newValue: 'light'}));
  assert.equal(doc.documentElement.dataset.theme, 'light');
  assert.equal(picker.value, 'light');
  dom.window.dispatchEvent(new dom.window.StorageEvent('storage', {key: null}));
  assert.equal(doc.documentElement.dataset.theme, 'dark');
  const blocked = setup(t, {storageBlocked: true});
  blocked.choose('dark');
  assert.equal(blocked.doc.documentElement.dataset.theme, 'dark');
});

test('both palettes maintain readable text, primary controls and status messages', () => {
  const css = readFileSync(new URL('../desktop/renderer/shared/theme.css', import.meta.url), 'utf8');
  const palettes = [...css.matchAll(/:root(?:\[data-theme="dark"\])?\s*\{([^}]+)\}/g)]
    .map(([, block]) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[\da-f]{6});/g)].map(([, key, color]) => [key, color])));
  const luminance = color => {
    const rgb = color.match(/[\da-f]{2}/g).map(value => parseInt(value, 16) / 255)
      .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  };
  for (const palette of palettes) {
    for (const [foreground, background] of [['ink', 'canvas'], ['muted', 'surface'], ['muted', 'canvas'],
      ['accent', 'surface'], ['on-accent', 'accent'], ['success', 'success-soft'], ['danger', 'danger-soft']]) {
      const values = [luminance(palette[foreground]), luminance(palette[background])].sort((a, b) => a - b);
      assert.ok((values[1] + .05) / (values[0] + .05) >= 4.5, `${foreground} on ${background}`);
    }
  }
  assert.equal(palettes.length, 2);
});
