import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeAdapter} from '../desktop/renderer/native-entry.js';

test('speech diagnosis uses the native operation without sending API keys or output selection', async () => {
  const calls = [];
  const diagnostic = {ok: true, requests: [{stage: 'synthesis', status: 200}], checkedAt: 1};
  const adapter = createNativeAdapter({call: async (operation, input) => {calls.push({operation, input}); return diagnostic;}});
  assert.deepEqual(await adapter.message({type: 'DIAGNOSE_SPEECH', apiKey: 'ignored-key'}), {ok: true, diagnostic});
  assert.deepEqual(calls, [{operation: 'diagnose-speech', input: {}}]);
});

test('native state exposes the implemented voice-catalog operation', async () => {
  const adapter = createNativeAdapter({call: async () => ({settings: {}, _native: {}, manager: {sessions: []}})});
  assert.equal((await adapter.message({type: 'GET_STATE'})).capabilities.voiceCatalog, true);
});

test('gift history requests missing consent before calling the API and works after consent', async () => {
  const raw = {settings: {}, manager: {sessions: [], preferences: {features: {donations: true}}},
    _native: {activeKey: 'api:dj:1', receiving: true, scopes: 'me.read events.donation donations.read.extra'}};
  const calls = [];
  const adapter = createNativeAdapter({call: async (operation, input) => {
    calls.push({operation, input});
    if (operation === 'snapshot') return raw;
    if (operation === 'authorization-url') return 'https://developers.spooncast.net/jp/oauth/authorize?scope=donations.read';
    if (operation === 'manager-action') return {ok: true};
    throw new Error(operation);
  }});
  const request = {type: 'FETCH_MANAGER_DONATIONS', sessionKey: 'api:dj:1'};
  const consent = await adapter.message(request);
  assert.equal(consent.ok, true);
  assert.equal(consent.needsAuthorization, true);
  assert.equal(calls.filter(call => call.operation === 'manager-action').length, 0);
  assert.equal(calls.filter(call => call.operation === 'authorization-url').length, 1);
  raw._native.scopes += ' donations.read';
  assert.equal((await adapter.message(request)).ok, true);
  assert.deepEqual(calls.find(call => call.operation === 'manager-action').input,
    {action: 'donations', sessionKey: 'api:dj:1', payload: {}});
});

test('gift history does not open consent for a disabled feature or a different broadcast', async () => {
  const raw = {manager: {preferences: {features: {donations: false}}}, _native: {activeKey: 'api:dj:1', receiving: true, scopes: ''}};
  const adapter = createNativeAdapter({call: async operation => {assert.equal(operation, 'snapshot'); return raw;}});
  assert.match((await adapter.message({type: 'FETCH_MANAGER_DONATIONS'})).error, /有効/);
  raw.manager.preferences.features.donations = true;
  assert.match((await adapter.message({type: 'FETCH_MANAGER_DONATIONS', sessionKey: 'api:dj:2'})).error, /現在の配信/);
});
