import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {AudioOutputUI} from '../desktop/renderer/popup/audio-output.js';

test('full endpoint names survive refresh and are readable below the selection', async t => {
  const dom = new JSDOM('<select></select><button></button><p id="status"></p><p id="name"></p>');
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const fullName = 'Voicemeeter Input (VB-Audio Voicemeeter VAIO)';
  const ui = new AudioOutputUI({select: doc.querySelector('select'), refresh: doc.querySelector('button'),
    status: doc.getElementById('status'), name: doc.getElementById('name'), supported: true,
    mediaDevices: {enumerateDevices: async () => [{kind: 'audiooutput', deviceId: 'winmm:vaio', label: fullName}]}});
  ui.render({outputDeviceId: 'winmm:vaio', outputDeviceLabel: 'Voicemeeter Input (VB-Audio Voi'});
  await ui.refresh();
  assert.equal(ui.selection.outputDeviceLabel, fullName);
  assert.equal(doc.querySelector('select').title, fullName);
  assert.equal(doc.getElementById('name').textContent, `選択中：${fullName}`);
  assert.equal(doc.getElementById('status').classList.contains('error'), false);
  ui.render({outputDeviceId: 'missing', outputDeviceLabel: 'Missing output'});
  assert.equal(ui.selection.outputDeviceId, 'missing');
  assert.equal(doc.getElementById('status').classList.contains('error'), true);
});
