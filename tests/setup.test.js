import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {installSetup} from '../desktop/renderer/setup.js';
import {SPOON_SCOPES} from '../desktop/renderer/shared/spoon-permissions.js';

test('startup API selection preserves saved keys and persists startup and authorization options', async t => {
  const dom = new JSDOM('', {url: 'https://spoon-manager.example/popup/popup.html'});
  const calls = [];
  const raw = {settings: {provider: 'legacy', enabled: true, apiKey: 'saved-key'}, _native: {authorized: true, scopes: SPOON_SCOPES.join(' ')}};
  const adapter = {snapshot: async () => raw, connection: async () => ({clientId: 'client', clientSecret: 'saved-secret', port: 17864}),
    configure: async config => calls.push({operation: 'configure', config}),
    message: async input => {calls.push(input); return {ok: true};}};
  const setup = installSetup({adapter, document: dom.window.document, window: dom.window});
  t.after(() => {setup.destroy(); dom.window.close();});
  await setup.open();
  const doc = dom.window.document;
  assert.equal(doc.getElementById('native-setup').open, true);
  assert.equal(doc.getElementById('setup-key').value, 'saved-key');
  assert.equal(doc.getElementById('setup-secret').value, 'saved-secret');
  doc.getElementById('setup-startup').checked = false;
  doc.getElementById('setup-close-tab').checked = false;
  doc.getElementById('setup-save').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls[0].config.closeAuthTab, false);
  assert.equal(calls[0].config.returnToApp, true);
  assert.equal(calls[1].settings.showSetupOnStartup, false);
  assert.equal(calls[1].settings.apiKey, 'saved-key');
  assert.equal(doc.getElementById('setup-finish').hidden, false);
  doc.getElementById('setup-finish').click();
  assert.equal(doc.getElementById('native-setup').open, false);
  assert.equal(dom.window.location.hash, '#overview');
});

test('invalid setup stays open without saving credentials or contacting OAuth', async t => {
  const dom = new JSDOM('', {url: 'https://spoon-manager.example/popup/popup.html'});
  const calls = [];
  const setup = installSetup({document: dom.window.document, window: dom.window, adapter: {
    snapshot: async () => ({settings: {enabled: false}}), connection: async () => ({}),
    configure: async config => calls.push(config), message: async input => calls.push(input)}});
  t.after(() => {setup.destroy(); dom.window.close();});
  await setup.open();
  dom.window.document.getElementById('setup-save').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(calls, []);
  assert.match(dom.window.document.getElementById('setup-status').textContent, /Client ID/);
  assert.equal(dom.window.document.getElementById('native-setup').open, true);
});

test('setup waits for new complete consent instead of accepting an existing partial grant', async t => {
  const dom = new JSDOM('', {url: 'https://spoon-manager.example/popup/popup.html'});
  let pulse;
  dom.window.setInterval = callback => {pulse = callback; return 1;};
  dom.window.clearInterval = () => {};
  const raw = {settings: {enabled: false}, _native: {authorized: true, scopes: 'me.read live.read', authorizationCompleted: 4}};
  const calls = [];
  const setup = installSetup({document: dom.window.document, window: dom.window, adapter: {
    snapshot: async () => raw,
    connection: async () => ({clientId: 'client', clientSecret: 'secret', port: 17864}),
    configure: async () => {}, message: async input => {calls.push(input); return {ok: true};}
  }});
  t.after(() => {setup.destroy(); dom.window.close();});
  await setup.open();
  const doc = dom.window.document;
  doc.getElementById('setup-save').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(doc.getElementById('setup-authorize').hidden, false);
  assert.equal(doc.getElementById('setup-finish').hidden, true);
  doc.getElementById('setup-authorize').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  await pulse();
  assert.equal(doc.getElementById('native-setup').open, true);
  raw._native.authorizationCompleted = 5;
  await pulse();
  assert.equal(doc.getElementById('native-setup').open, true);
  assert.match(doc.getElementById('setup-status').textContent, /権限が不足/);
  doc.getElementById('setup-authorize').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  raw._native.authorizationCompleted = 6;
  raw._native.scopes = SPOON_SCOPES.join(' ');
  await pulse();
  assert.equal(doc.getElementById('native-setup').open, false);
  assert.equal(dom.window.location.hash, '#overview');
  assert.equal(calls.filter(call => call.type === 'AUTHORIZE_SPOON').length, 2);
});
