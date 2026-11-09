import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeAudioDevices, playNativeAudio} from '../desktop/renderer/services/audio.js';

test('native audio devices and payloads preserve output selection without browser microphone access', async () => {
  let payload;
  const devices = [{kind: 'audiooutput', deviceId: 'wasapi:test', label: 'VoiceMeeter Input'}];
  const api = {listAudioOutputs: async () => devices, playAudio: async input => {payload = input;}, stopAudio: async () => {}};
  assert.equal(await nativeAudioDevices(api).enumerateDevices(), devices);
  await playNativeAudio(api, new Blob([new Uint8Array([0, 255, 127, 1])]), undefined, 0, 'wasapi:test');
  assert.equal(payload.outputDeviceId, 'wasapi:test'); assert.equal(payload.volume, 0);
  assert.deepEqual([...Buffer.from(payload.data, 'base64')], [0, 255, 127, 1]);
});

test('native playback cancellation stops the same job and device errors never fall back', async () => {
  let payload, release;
  const stopped = [];
  const pending = new Promise(resolve => {release = resolve;});
  const api = {playAudio: input => {payload = input; return pending;}, stopAudio: async id => stopped.push(id)};
  const controller = new AbortController();
  const playing = playNativeAudio(api, new Blob(['audio']), controller.signal, 0.5, 'selected');
  while (!payload) await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort(); release(); await assert.rejects(playing, {name: 'AbortError'});
  assert.deepEqual(stopped, [payload.id]);
  let calls = 0;
  await assert.rejects(playNativeAudio({playAudio: async () => {calls++; throw '選択した出力先が見つかりません。';}}, new Blob(['audio']), undefined, 1, 'missing'), /選択した出力先/);
  assert.equal(calls, 1);
});
