import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {DEFAULT_SETTINGS, LEGACY_VOICES, normalizeSettings, notificationVoiceIds, voiceId, isVoiceId, voiceEnabled} from '../desktop/renderer/shared/settings.js';
import {assignedSpeaker} from '../desktop/renderer/runtime.js';
import {createNativeAdapter} from '../desktop/renderer/native-entry.js';
import {resolveVoice, voiceListMessage} from '../desktop/renderer/background/chat-commands.js';

const id = 'coeiroink:cb11bdbd-78fc-4f16-b528-a400bae1782d:90';
const secondStyle = 'coeiroink:cb11bdbd-78fc-4f16-b528-a400bae1782d:91';
const coeiroinkVoices = [{id, name: 'COEIROINK:リリンちゃん（のーまる）'}, {id: secondStyle, name: 'COEIROINK:リリンちゃん（ささやき）'}];

test('optional COEIROINK IDs survive settings round trips without colliding with VOICEVOX IDs', () => {
  assert.equal(DEFAULT_SETTINGS.coeiroinkEnabled, false);
  const settings = normalizeSettings({...DEFAULT_SETTINGS, provider: 'engine', coeiroinkEnabled: true, systemSpeaker: 3, commentSpeakers: [90, id]});
  assert.deepEqual(settings.commentSpeakers, [90, id]);
  assert.deepEqual(normalizeSettings(JSON.parse(JSON.stringify(settings))), settings);
  assert.equal(voiceId(id), id);
  assert.equal(voiceId('90'), 90);
  assert.equal(isVoiceId('coeiroink:invalid:90'), false);
  assert.equal(isVoiceId(id.replace(':90', ':2147483648')), false);
  assert.equal(voiceEnabled(id, settings), true);
  assert.equal(voiceEnabled(id, {...settings, coeiroinkEnabled: false}), false);
  assert.deepEqual(notificationVoiceIds([...LEGACY_VOICES, ...coeiroinkVoices], id), [id, secondStyle]);
  assert.deepEqual(notificationVoiceIds([coeiroinkVoices[1]], id), [secondStyle]);
});

test('automatic and manual voice assignments honor the optional engine setting', () => {
  const raw = {settings: {...DEFAULT_SETTINGS, coeiroinkEnabled: true, systemSpeaker: 3, commentSpeakers: [id]}, runtime: {voices: [...LEGACY_VOICES, ...coeiroinkVoices]}};
  assert.equal(assignedSpeaker(raw, 'listener'), id);
  raw.runtime.assignments = {listener: secondStyle};
  assert.equal(assignedSpeaker(raw, 'listener'), secondStyle);
  raw.settings.coeiroinkEnabled = false;
  assert.equal(typeof assignedSpeaker(raw, 'listener'), 'number');
  raw.settings.coeiroinkEnabled = true; raw.settings.systemSpeaker = id;
  assert.equal(typeof assignedSpeaker(raw, 'listener'), 'number');
});

test('direct API settings enable the same voices and reject simultaneous bridge use', () => {
  const direct = normalizeSettings({...DEFAULT_SETTINGS, coeiroinkDirectEnabled: true, coeiroinkDirectUrl: 'http://127.0.0.1:50032/', commentSpeakers: [id]});
  assert.equal(direct.coeiroinkDirectUrl, 'http://127.0.0.1:50032');
  assert.equal(voiceEnabled(id, direct), true);
  assert.equal(assignedSpeaker({settings: direct}, 'listener'), id);
  assert.throws(() => normalizeSettings({...direct, coeiroinkEnabled: true}), /同時にON/);
  assert.throws(() => normalizeSettings({...direct, coeiroinkDirectUrl: 'file:///invalid'}), /URL/);
});

test('native voice tests forward only a validated source selector', async () => {
  const calls = [];
  const adapter = createNativeAdapter({call: async (operation, input) => {calls.push({operation, input});}});
  for (const source of ['voicevox', 'coeiroink']) assert.equal((await adapter.message({type: 'TEST_VOICE', source, apiKey: 'ignored', text: 'ignored'})).ok, true);
  assert.deepEqual(calls, ['voicevox', 'coeiroink'].map(source => ({operation: 'test-voice', input: {source}})));
  assert.equal((await adapter.message({type: 'TEST_VOICE', source: 'invalid'})).ok, false);
  assert.equal(calls.length, 2);
});

test('voice commands select COEIROINK by name or namespaced ID and keep lists within chat limits', () => {
  const voices = [...LEGACY_VOICES, ...coeiroinkVoices];
  for (const query of ['リリンちゃん', 'リリンちゃん のーまる', 'COEIROINK:リリンちゃん', 'C90', 'c90', id]) assert.equal(resolveVoice(voices, query).voice?.id, id, query);
  assert.equal(resolveVoice(voices, 'リリンちゃん ささやき').voice?.id, secondStyle);
  assert.match(resolveVoice(voices, 'リリンちゃん', [id, secondStyle]).message, /通知専用/);
  for (let page = 1; page < 20; page++) assert.ok(voiceListMessage(voices, String(page)).length <= 200);
});

test('native adapter preserves optional catalog IDs and individual assignments', async () => {
  const key = 'api:dj:1';
  const raw = {settings: {...DEFAULT_SETTINGS, coeiroinkEnabled: true}, runtime: {voices: [...LEGACY_VOICES, ...coeiroinkVoices]}, manager: {sessions: [{key, live: {}, users: [{id: 'listener', name: 'Listener'}], events: [], totals: {}}]}, _native: {activeKey: key}};
  const adapter = createNativeAdapter({call: async (operation, input) => {
    if (operation === 'snapshot') return structuredClone(raw);
    if (operation === 'save-runtime') raw.runtime = structuredClone(input.runtime);
  }});
  assert.ok((await adapter.message({type: 'GET_STATE'})).voices.some(voice => voice.id === id));
  assert.equal((await adapter.message({type: 'SET_ASSIGNMENT', userId: 'listener', speaker: id})).ok, true);
  assert.equal((await adapter.message({type: 'GET_STATE'})).participants[0].speaker, id);
  raw.settings.coeiroinkEnabled = false;
  const disabled = createNativeAdapter({call: async () => structuredClone(raw)});
  assert.equal((await disabled.message({type: 'GET_STATE'})).voices.some(voice => voice.id === id), false);
  assert.equal((await disabled.message({type: 'SET_ASSIGNMENT', userId: 'listener', speaker: id})).ok, false);
});

test('settings UI can save, refresh, select and disable optional bridge voices', async t => {
  const dom = new JSDOM(await readFile(new URL('../desktop/renderer/popup/popup.html', import.meta.url), 'utf8'));
  globalThis.document = dom.window.document; globalThis.window = dom.window;
  dom.window.scrollTo = () => {};
  let saved = {...structuredClone(DEFAULT_SETTINGS), provider: 'engine', systemSpeaker: 3, commentSpeakers: [2]};
  const calls = [];
  const state = () => ({ok: true, settings: saved, voices: [...LEGACY_VOICES, ...coeiroinkVoices], participants: [], status: {enabled: true}});
  globalThis.browser = {tabs: {query: async () => []}, runtime: {sendMessage: async input => {
    calls.push(input);
    if (input.type === 'SAVE_APP_SETTINGS') saved = input.settings;
    return state();
  }}};
  t.after(() => { delete globalThis.document; delete globalThis.window; delete globalThis.browser; dom.window.close(); });
  const {settingsUI} = await import('../desktop/renderer/popup/settings.js');
  await settingsUI.initialize({onDirty() {}, collectPreferences: () => ({}), preferencesRevision: () => 0, sessionKey: () => '', onSaved() {}});
  const field = name => document.getElementById('v-' + name);
  assert.equal(field('coeiroink-fields').hidden, true);
  assert.equal([...field('system-speaker').options].some(option => option.value === id), false);
  field('coeiroink-enabled').checked = true;
  field('coeiroink-enabled').dispatchEvent(new dom.window.Event('change', {bubbles: true}));
  assert.equal(field('coeiroink-fields').hidden, false);
  assert.equal(field('coeiroink-direct-enabled').disabled, true);
  assert.equal(field('coeiroink-enabled').closest('section').getAttribute('aria-labelledby'), 'v-connection-heading');
  assert.equal(field('coeiroink-enabled').closest('section').nextElementSibling.getAttribute('aria-labelledby'), 'v-coeiroink-heading');
  const checkbox = [...field('voice-pool').querySelectorAll('input')].find(input => input.value === id);
  assert.ok(checkbox); checkbox.checked = true;
  const settle = async () => { for (let i = 0; i < 100 && settingsUI.busy; i++) await new Promise(resolve => setImmediate(resolve)); assert.equal(settingsUI.busy, false); };
  field('settings-form').dispatchEvent(new dom.window.Event('submit', {cancelable: true}));
  await settle();
  assert.equal(saved.coeiroinkEnabled, true);
  assert.ok(saved.commentSpeakers.includes(id));
  assert.ok(calls.some(call => call.type === 'REFRESH_VOICES'));
  field('system-speaker').value = id;
  field('system-speaker').dispatchEvent(new dom.window.Event('change'));
  assert.ok([...field('voice-pool').querySelectorAll('input')].find(input => input.value === secondStyle).disabled);
  field('coeiroink-enabled').checked = false;
  field('coeiroink-enabled').dispatchEvent(new dom.window.Event('change'));
  assert.equal([...field('system-speaker').options].some(option => option.value === id), false);
  assert.equal(field('system-speaker').value, '0');
  // Turning the optional source off must remain saveable even when every
  // selected comment voice came from that source.
  field('coeiroink-enabled').checked = true;
  field('coeiroink-enabled').dispatchEvent(new dom.window.Event('change'));
  for (const input of field('voice-pool').querySelectorAll('input')) input.checked = input.value === id;
  field('coeiroink-enabled').checked = false;
  field('coeiroink-enabled').dispatchEvent(new dom.window.Event('change'));
  assert.ok(settingsUI.pool().length > 0);
  assert.equal(field('coeiroink-direct-enabled').disabled, false);
  field('coeiroink-direct-enabled').checked = true;
  field('coeiroink-direct-enabled').dispatchEvent(new dom.window.Event('change'));
  assert.equal(field('coeiroink-enabled').disabled, true);
  assert.equal(field('coeiroink-direct-fields').hidden, false);
  assert.equal(field('coeiroink-test').disabled, true); // Save the connection first.
  field('settings-form').dispatchEvent(new dom.window.Event('submit', {cancelable: true}));
  await settle();
  assert.equal(saved.coeiroinkDirectEnabled, true);
  assert.equal(saved.coeiroinkEnabled, false);
  assert.equal(field('coeiroink-test').disabled, false);
  field('coeiroink-test').click(); await settle();
  assert.equal(calls.filter(call => call.type === 'TEST_VOICE').at(-1).source, 'coeiroink');
  field('voicevox-test').click(); await settle();
  assert.equal(calls.filter(call => call.type === 'TEST_VOICE').at(-1).source, 'voicevox');
  field('provider').value = 'legacy';
  field('system-speaker').value = id;
  field('system-speaker').dispatchEvent(new dom.window.Event('change'));
  field('settings-form').dispatchEvent(new dom.window.Event('submit', {cancelable: true})); await settle();
  assert.equal(field('playback-status').textContent, 'コメントを待っています');
  field('coeiroink-direct-enabled').checked = false;
  field('coeiroink-direct-enabled').dispatchEvent(new dom.window.Event('change'));
  assert.equal(field('coeiroink-enabled').disabled, false);
  assert.equal(field('coeiroink-test').disabled, true);
});
