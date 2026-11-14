import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {BUILTIN_VOICES, VOICE_TERMS_REVISION, ADDITIONAL_VOICE_TERMS_REVISION} from '../desktop/renderer/shared/builtin-voices.js';
import {DEFAULT_SETTINGS, normalizeSettings, voiceEnabled} from '../desktop/renderer/shared/settings.js';
import {speechCredits} from '../desktop/renderer/shared/speech-credits.js';
import {createNativeAdapter} from '../desktop/renderer/native-entry.js';

test('reviewed catalog, style allowlist and required credits agree with distribution manifest', async () => {
  const manifest = JSON.parse(await readFile(new URL('../licenses/voicevox-manifest.json', import.meta.url)));
  assert.deepEqual(BUILTIN_VOICES, manifest.voices);
  assert.equal(VOICE_TERMS_REVISION, manifest.termsRevision);
  assert.equal(ADDITIONAL_VOICE_TERMS_REVISION, manifest.additionalTermsRevision);
  assert.equal(BUILTIN_VOICES.length, 132);
  assert.equal(BUILTIN_VOICES.filter(v => !v.requiresAdditionalConsent).length, 92);
  assert.equal(new Set(BUILTIN_VOICES.map(v => v.id)).size, 132);
  assert.equal(new Set(BUILTIN_VOICES.filter(v => v.model !== 'n0.vvm').map(v => v.speaker)).size, 42);
  for (const voice of BUILTIN_VOICES) {
    assert.ok(manifest.models.some(model => model.name === voice.model));
    assert.ok(speechCredits().includes(voice.credit));
    assert.match(voice.terms, /^https:\/\//);
    assert.equal(voice.terms, new URL(voice.terms).href, 'Native link allowlist needs the browser-serialized URL');
  }
  assert.equal(voiceEnabled(13, DEFAULT_SETTINGS), false);
  assert.equal(voiceEnabled(13, {...DEFAULT_SETTINGS, provider: 'engine'}), true);
  for (const id of [13, 20, 27, 28, 29, 30, 31, 47, 48, 49, 50, 55, 56, 57, 58, 59, 60, 66, 74, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 89, 90, 91, 92, 93, 110, 111, 112, 126]) {
    assert.equal(voiceEnabled(id, DEFAULT_SETTINGS), false, `Restricted style ${id} must remain unavailable`);
  }
  for (const id of [11, 21, 23, 42, 43, 51, 52, 53, 54, 67, 68, 69, 75, 76, 46, 94, 99, 100, 107, 108, 109, 118, 122, 127]) {
    assert.equal(voiceEnabled(id, DEFAULT_SETTINGS), true, `Reviewed style ${id} must be available`);
  }
  assert.ok(speechCredits().split('\n').includes('VOICEVOX 離途'));
  const normalized = normalizeSettings({...DEFAULT_SETTINGS, commentSpeakers: [0, 2, 13]});
  assert.ok(normalized.commentSpeakers.every(id => voiceEnabled(id, normalized)));
  const credit = speechCredits([{id: 'coeiroink:cb11bdbd-78fc-4f16-b528-a400bae1782d:0', name: 'COEIROINK:つくよみちゃん（れいせい）'}, {id: 20, name: 'もち子さん（ノーマル）'}]);
  assert.match(credit, /COEIROINK:つくよみちゃん/);
  assert.match(credit, /VOICEVOX もち子さん\(cv明日葉よもぎ\)/);
  assert.equal(credit.split('\n').filter(c => c.includes('もち子さん')).length, 1);
  assert.equal(credit.split('\n').filter(c => c === 'VOICEVOX Nemo').length, 1);
});

test('personal voices require the current explicit consent and normalize safely after revocation', () => {
  const consent = {...DEFAULT_SETTINGS, avoidRestrictedVoices: false, additionalVoiceTermsAccepted: ADDITIONAL_VOICE_TERMS_REVISION, additionalVoiceUse: 'personalNoncommercial',
    systemSpeaker: 13, commentSpeakers: [20, 55, 74]};
  assert.equal(voiceEnabled(13, {...consent, additionalVoiceTermsAccepted: ''}), false);
  assert.equal(voiceEnabled(13, {...consent, additionalVoiceTermsAccepted: 'old-terms'}), false);
  assert.equal(voiceEnabled(13, {...consent, avoidRestrictedVoices: true}), false);
  assert.equal(voiceEnabled(13, {...consent, additionalVoiceUse: ''}), false);
  assert.equal(voiceEnabled(13, {...consent, additionalVoiceUse: 'commercial'}), false);
  assert.equal(voiceEnabled(13, {...consent, additionalVoiceUse: 'licensed'}), true);
  for (const voice of BUILTIN_VOICES.filter(v => v.requiresAdditionalConsent)) assert.equal(voiceEnabled(voice.id, consent), true);
  for (const id of [47, 48, 49, 50, 126]) assert.equal(voiceEnabled(id, consent), false);
  const accepted = normalizeSettings(consent);
  assert.equal(accepted.systemSpeaker, 13);
  assert.deepEqual(accepted.commentSpeakers, [20, 55, 74]);
  assert.equal(accepted.avoidRestrictedVoices, false);
  assert.equal(accepted.additionalVoiceTermsAccepted, ADDITIONAL_VOICE_TERMS_REVISION);
  for (const revoked of [{...consent, avoidRestrictedVoices: true}, {...consent, additionalVoiceTermsAccepted: 'old-terms'}]) {
    const settings = normalizeSettings(revoked);
    assert.equal(settings.avoidRestrictedVoices, true);
    assert.equal(settings.additionalVoiceTermsAccepted, '');
    assert.equal(settings.systemSpeaker, 0);
    assert.ok(settings.commentSpeakers.length > 0);
    assert.ok(settings.commentSpeakers.every(id => voiceEnabled(id, settings)));
  }
});

test('built-in popup catalog is offline, preserves consent and refuses synthesis setup without terms confirmation', async t => {
  const dom = new JSDOM(await readFile(new URL('../desktop/renderer/popup/popup.html', import.meta.url), 'utf8'));
  globalThis.document = dom.window.document; globalThis.window = dom.window;
  dom.window.scrollTo = () => {};
  dom.window.HTMLDialogElement.prototype.showModal = function() { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function() { this.open = false; };
  let saved = {...structuredClone(DEFAULT_SETTINGS), enabled: false};
  const calls = [];
  globalThis.browser = {tabs: {query: async () => []}, runtime: {sendMessage: async input => {
    calls.push(input);
    if (input.type === 'SAVE_APP_SETTINGS') saved = input.settings;
    return {ok: true, settings: saved, voices: BUILTIN_VOICES, participants: [], status: {enabled: saved.enabled}};
  }}};
  t.after(() => {delete globalThis.document; delete globalThis.window; delete globalThis.browser; dom.window.close();});
  const {settingsUI} = await import('../desktop/renderer/popup/settings.js');
  await settingsUI.initialize({onDirty() {}, collectPreferences: () => ({}), preferencesRevision: () => 0, sessionKey: () => '', onSaved() {}});
  const field = name => document.getElementById('v-' + name);
  assert.equal(field('builtin-fields').hidden, false);
  assert.equal(field('legacy-fields').hidden, true);
  assert.equal(field('system-speaker').options.length, 92);
  assert.equal(field('voice-terms').checked, false);
  assert.match(field('speech-credits').value, /VOICEVOX:ずんだもん/);
  assert.ok(field('model-terms').querySelectorAll('a').length >= 11);
  field('enabled').checked = true;
  field('settings-form').dispatchEvent(new dom.window.Event('submit', {cancelable: true}));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls.some(c => c.type === 'SAVE_APP_SETTINGS'), false);
  field('voice-terms').checked = true;
  field('settings-form').dispatchEvent(new dom.window.Event('submit', {cancelable: true}));
  for (let i = 0; settingsUI.busy && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(saved.voiceTermsAccepted, VOICE_TERMS_REVISION);
  assert.equal(saved.provider, 'builtin');
  assert.equal(field('voice-terms').checked, true);
  assert.equal(field('auto-voice-credits').checked, true);
  assert.equal(field('credit-off-warning').hidden, true);
  field('auto-voice-credits').checked = false;
  field('auto-voice-credits').dispatchEvent(new dom.window.Event('change', {bubbles:true}));
  assert.equal(field('credit-off-warning').hidden, false);
  field('settings-form').dispatchEvent(new dom.window.Event('submit', {cancelable:true}));
  for (let i = 0; settingsUI.busy && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(saved.autoVoiceCredits, false);
  await settingsUI.refresh({settings:true});
  assert.equal(field('credit-off-warning').hidden, false);
  const change = id => field(id).dispatchEvent(new dom.window.Event('change', {bubbles: true}));
  const openPersonal = () => { field('avoid-restricted-voices').checked = false; change('avoid-restricted-voices'); };
  openPersonal();
  assert.equal(field('additional-voice-dialog').open, true);
  assert.equal(field('avoid-restricted-voices').checked, true);
  assert.equal(field('system-speaker').options.length, 92);
  assert.equal(field('additional-model-terms').querySelectorAll('a').length, 10);
  assert.equal(field('additional-voice-accept').disabled, true);
  field('additional-use-confirm').checked = true; change('additional-use-confirm');
  assert.equal(field('additional-voice-accept').disabled, true);
  field('additional-voice-cancel').click();
  assert.equal(field('additional-voice-dialog').open, false);
  assert.equal(field('avoid-restricted-voices').checked, true);
  openPersonal();
  field('additional-voice-dialog').dispatchEvent(new dom.window.Event('cancel', {cancelable: true}));
  assert.equal(field('additional-voice-dialog').open, false);
  assert.equal(field('avoid-restricted-voices').checked, true);
  openPersonal();
  field('additional-use-personal').checked = true; change('additional-use-personal');
  for (const id of ['additional-use-confirm', 'additional-rules-confirm']) { field(id).checked = true; change(id); }
  field('additional-voice-accept').click();
  assert.equal(field('additional-voice-dialog').open, false);
  assert.equal(field('avoid-restricted-voices').checked, false);
  assert.equal(field('system-speaker').options.length, 132);
  field('system-speaker').value = '13';
  field('settings-form').dispatchEvent(new dom.window.Event('submit', {cancelable: true}));
  for (let i = 0; settingsUI.busy && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(saved.avoidRestrictedVoices, false);
  assert.equal(saved.additionalVoiceTermsAccepted, ADDITIONAL_VOICE_TERMS_REVISION);
  assert.equal(saved.additionalVoiceUse, 'personalNoncommercial');
  assert.equal(saved.systemSpeaker, 13);
  await settingsUI.refresh({settings: true});
  assert.equal(field('avoid-restricted-voices').checked, false);
  field('avoid-restricted-voices').checked = true; change('avoid-restricted-voices');
  assert.equal(field('system-speaker').options.length, 92);
  assert.equal(field('system-speaker').value, '0');
  field('settings-form').dispatchEvent(new dom.window.Event('submit', {cancelable: true}));
  for (let i = 0; settingsUI.busy && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(saved.avoidRestrictedVoices, true);
  assert.equal(saved.additionalVoiceTermsAccepted, '');
  assert.equal(saved.additionalVoiceUse, '');
  openPersonal();
  for (const id of ['additional-use-confirm', 'additional-rules-confirm']) { field(id).checked = true; change(id); }
  assert.equal(field('additional-voice-accept').disabled, true);
  field('additional-use-licensed').checked = true; change('additional-use-licensed');
  field('additional-voice-accept').click();
  assert.equal(field('system-speaker').options.length, 132);
  field('settings-form').dispatchEvent(new dom.window.Event('submit', {cancelable: true}));
  for (let i = 0; settingsUI.busy && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(saved.additionalVoiceUse, 'licensed');
  assert.equal(saved.avoidRestrictedVoices, false);
});

test('native reading state filters stale external voices without a network catalog request', async () => {
  const operations = [];
  const adapter = createNativeAdapter({call: async operation => {
    operations.push(operation);
    return {settings: DEFAULT_SETTINGS, runtime: {voices: [{id: 13, name: '以前の外部音声'}]}, manager: {sessions: []}};
  }});
  const state = await adapter.message({type: 'GET_STATE'});
  assert.equal(state.voices.length, 92);
  assert.equal(state.voices.some(v => v.id === 13), false);
  assert.deepEqual(operations, ['snapshot']);
});
