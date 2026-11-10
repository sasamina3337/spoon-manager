import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {initializeWorkspace} from '../desktop/renderer/shared/workspace.js';
import {COMMANDS} from '../desktop/renderer/background/chat-commands.js';

const applications = ['desktop/renderer'];
for (const base of applications) {
  const html = readFileSync(new URL(`../${base}/popup/popup.html`, import.meta.url), 'utf8');
  function workspace(t, hash = '') {
    const dom = new JSDOM(html, {url: 'https://app.test/' + hash});
    dom.window.scrollTo = () => {};
    t.after(() => dom.window.close());
    const changes = [];
    const navigation = initializeWorkspace({window: dom.window, onSettingsChange: name => changes.push(name)});
    return {dom, doc: dom.window.document, navigation, changes};
  }

  test(`${base}: links reach existing views and sections; controls and accessible labels remain unique`, t => {
    const {doc, dom, navigation} = workspace(t);
    const ids = [...doc.querySelectorAll('[id]')].map(item => item.id);
    assert.equal(ids.length, new Set(ids).size);
    for (const element of doc.querySelectorAll('[for], [aria-labelledby], [aria-describedby]')) {
      for (const attr of ['for', 'aria-labelledby', 'aria-describedby']) {
        for (const id of (element.getAttribute(attr) || '').split(/\s+/).filter(Boolean)) assert.ok(doc.getElementById(id), id);
      }
    }
    for (const link of doc.querySelectorAll('a[href^="#"]')) {
      const [name, panel] = link.hash.slice(1).split('/');
      assert.ok(doc.getElementById('view-' + name), link.outerHTML);
      if (panel) assert.ok(doc.querySelector(name === 'settings' ? `[data-settings-panel="${panel}"]` : `[data-section-group="${name}"][data-section-panel="${panel}"]`), link.outerHTML);
      dom.window.location.hash = link.hash;
      navigation.showView();
      assert.equal(doc.querySelectorAll('.view:not([hidden])').length, 1);
      assert.equal(doc.getElementById('view-' + name).hidden, false);
      if (panel) assert.equal(doc.querySelector(name === 'settings' ? `[data-settings-panel="${panel}"]` : `[data-section-group="${name}"][data-section-panel="${panel}"]`).hidden, false);
    }
    assert.equal(doc.querySelectorAll('form').length, 1);
    assert.equal(doc.querySelectorAll('button[type="submit"]').length, 1);
  });

  test(`${base}: deep links, back navigation, invalid routes and setting drafts survive section changes`, async t => {
    const {doc, dom, navigation, changes} = workspace(t, '#settings/voice');
    assert.equal(doc.querySelector('[data-settings-panel=voice]').hidden, false);
    assert.equal(doc.querySelector('.session-picker').hidden, true);
    doc.getElementById('heart-goal').value = '456';
    doc.querySelector('[data-settings-tab=goals]').click();
    assert.equal(dom.window.location.hash, '#settings/goals');
    assert.equal(doc.querySelector('[data-settings-tab=goals]').getAttribute('aria-pressed'), 'true');
    assert.equal(changes.at(-1), 'goals');
    dom.window.location.hash = 'analysis/logs'; navigation.showView(true);
    assert.equal(doc.getElementById('events').closest('[data-section-panel]').hidden, false);
    assert.equal(doc.querySelector('.session-picker').hidden, false);
    assert.equal(doc.activeElement.id, 'analysis-heading');
    dom.window.location.hash = 'settings/voice'; navigation.showView();
    await new Promise(resolve => dom.window.setTimeout(resolve, 10));
    dom.window.history.back();
    await new Promise(resolve => dom.window.setTimeout(resolve, 20));
    assert.equal(doc.getElementById('view-analysis').hidden, false);
    assert.equal(doc.getElementById('heart-goal').value, '456');
    dom.window.location.hash = 'help/unknown'; navigation.showView();
    assert.equal(doc.querySelector('[data-section-group=help][data-section-panel=start]').hidden, false);
    dom.window.location.hash = 'unknown'; navigation.showView();
    assert.equal(doc.getElementById('view-overview').hidden, false);
    navigation.showSettings('unknown');
    assert.equal(doc.querySelector('[data-settings-panel=connection]').hidden, false);
  });

  test(`${base}: configuration controls are grouped under settings, separate from active features`, t => {
    const {doc} = workspace(t);
    assert.equal(doc.querySelector('#v-participants').closest('[data-settings-panel]').dataset.settingsPanel, 'voice');
    assert.equal(doc.querySelector('#view-records #v-participants'), null);
    assert.equal(doc.querySelector('#theme-mode').closest('[data-settings-panel]').dataset.settingsPanel, 'display');
    assert.equal(doc.querySelector('[data-view="tools"]').textContent.trim(), '機能');
    assert.ok(doc.querySelector('#view-tools [data-section-panel="chat"]'));
  });

  test(`${base}: feature search handles matching, no results and clearing without removing links`, t => {
    const {doc} = workspace(t, '#help/features');
    const search = doc.getElementById('help-search');
    const query = text => {search.value = text; search.dispatchEvent(new doc.defaultView.Event('input'));};
    query('CSV');
    const visible = [...doc.querySelectorAll('[data-help-feature]:not([hidden])')];
    assert.ok(visible.length >= 2);
    assert.ok(visible.every(card => /CSV/.test(card.textContent)));
    query('<script>no results</script>');
    assert.equal(doc.getElementById('help-empty').hidden, false);
    query('');
    assert.equal(doc.querySelectorAll('[data-help-feature][hidden]').length, 0);
    assert.equal(doc.getElementById('help-empty').hidden, true);
  });
}

test('desktop: command guide filters the actual command registry by purpose and DJ operations', t => {
  const dom = new JSDOM(readFileSync(new URL('../desktop/renderer/popup/popup.html', import.meta.url), 'utf8'), {url:'https://app.test/#help/commands'});
  dom.window.scrollTo = () => {}; t.after(() => dom.window.close());
  const doc = dom.window.document;
  for (const command of COMMANDS) {
    const row = doc.createElement('tr');
    for (const text of [command.usage, command.description, command.audience]) {const cell = doc.createElement('td'); cell.textContent = text; row.append(cell);}
    doc.getElementById('command-list').append(row);
  }
  initializeWorkspace({window: dom.window});
  const search = doc.getElementById('command-search'), audience = doc.getElementById('command-audience');
  search.value = '天気'; search.dispatchEvent(new dom.window.Event('input'));
  assert.equal(doc.querySelectorAll('#command-list tr:not([hidden])').length, 2);
  audience.value = 'dj'; audience.dispatchEvent(new dom.window.Event('change'));
  assert.equal(doc.getElementById('command-empty').hidden, false);
  search.value = ''; search.dispatchEvent(new dom.window.Event('input'));
  assert.ok([...doc.querySelectorAll('#command-list tr:not([hidden])')].every(row => row.lastElementChild.textContent.includes('DJ')));
  assert.equal(doc.getElementById('command-empty').hidden, true);
});

