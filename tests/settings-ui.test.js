import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {DEFAULT_SETTINGS, LEGACY_VOICES} from '../desktop/renderer/shared/settings.js';

test('desktop settings initialize and playback status keeps updating', async t => {
  const dom = new JSDOM(await readFile(new URL('../desktop/renderer/popup/popup.html', import.meta.url), 'utf8'));
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  dom.window.scrollTo = () => {};
  const status = {enabled: true, playing: false, queued: 0, lastError: null};
  globalThis.browser = {tabs: {query: async () => []}, runtime: {sendMessage: async () => ({ok: true,
    settings: {...DEFAULT_SETTINGS, provider: 'engine', eventEnabled: {...DEFAULT_SETTINGS.eventEnabled, follow: true}},
    status, voices: LEGACY_VOICES, participants: [], roomKey: ''})}};
  t.after(() => {delete globalThis.document; delete globalThis.window; delete globalThis.browser; dom.window.close();});
  const {settingsUI} = await import('../desktop/renderer/popup/settings.js');
  await settingsUI.initialize({onDirty() {}});
  const label = document.getElementById('v-playback-status');
  assert.equal(label.textContent, 'コメントを待っています');
  assert.equal(document.getElementById('v-enabled').checked, true);
  status.playing = true; await settingsUI.refresh();
  assert.equal(label.textContent, '読み上げ中');
  status.playing = false; status.lastError = '音声の接続エラー'; await settingsUI.refresh();
  assert.equal(label.textContent, '接続を確認してください');
  assert.match(document.getElementById('notice').textContent, /音声の接続エラー/);
  status.lastError = null; await settingsUI.refresh();
  assert.equal(label.textContent, 'コメントを待っています');
  assert.match(document.getElementById('notice').textContent, /復旧/);
  assert.equal(document.getElementById('notice').classList.contains('error'), false);
  const template = document.getElementById('v-small-gift-template');
  assert.equal(template.value, DEFAULT_SETTINGS.autoReplies.heart.smallGiftTemplate);
  template.value = '{name}さん\n粗品ありがとう！'; template.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
  assert.equal(document.getElementById('v-small-gift-preview').textContent, 'リスナーさん\n粗品ありがとう！');
});
