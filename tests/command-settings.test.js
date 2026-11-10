import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {COMMAND_NAMES} from '../desktop/renderer/background/chat-commands.js';
import {createCommandSettings} from '../desktop/renderer/popup/command-settings.js';

test('individual command switches restore saved choices, retain other flags and default old settings to ON', t => {
  const dom = new JSDOM(readFileSync(new URL('../desktop/renderer/popup/popup.html', import.meta.url), 'utf8'));
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const container = doc.getElementById('command-toggles');
  assert.equal(container.closest('[data-settings-panel]').dataset.settingsPanel, 'commands');
  let changes = 0;
  const ui = createCommandSettings(container, {onChange: () => {changes++;}});
  const inputs = [...container.querySelectorAll('input[role="switch"]')];
  assert.equal(inputs.length, COMMAND_NAMES.length);
  ui.render({enabledByName: {dice: false, 天気: false, voice: false}});
  assert.equal(ui.collect().dice, false); assert.equal(ui.collect().weather, true);
  const dice = inputs.find(input => input.getAttribute('aria-label') === '/dice を使用する');
  assert.equal(dice.closest('label').lastElementChild.textContent, 'OFF');
  dice.click();
  assert.equal(changes, 1); assert.equal(ui.collect().dice, true);
  assert.equal(ui.collect().voice, false); assert.equal(ui.collect().天気, false);
  assert.equal(dice.closest('label').lastElementChild.textContent, 'ON');
  const saved = structuredClone(ui.collect());
  ui.render({}); assert.ok(inputs.every(input => input.checked));
  ui.render({enabledByName: saved}); assert.deepEqual(ui.collect(), saved);
});
