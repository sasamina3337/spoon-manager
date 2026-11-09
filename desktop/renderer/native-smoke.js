// Called explicitly by a host using an isolated --data-dir. No self-starting test,
// live connection, authorization, chat, network requests or audio synthesis.
export async function runNativeSmoke(context) {
  if (window.spoonNative?.smoke !== true) return {ok: false, error: 'Smoke requires the host smoke flag and an isolated --data-dir.', checks: [], passed: 0, failed: 0};
  const {adapter, calls} = context;
  const checks = [];
  const report = extra => ({checks, passed: checks.filter(item => item.passed).length, failed: checks.filter(item => !item.passed).length, ...extra});
  const check = (name, passed) => { checks.push({name, passed: Boolean(passed)}); if (!passed) throw new Error(name); };
  const find = id => document.getElementById(id);
  const wait = async predicate => {
    for (let attempt = 0; attempt < 150; attempt++) { if (predicate()) return; await new Promise(resolve => window.setTimeout(resolve, 20)); }
    throw new Error('Timed out waiting for the original UI.');
  };
  const input = (id, value) => { const node = find(id); node.value = value; node.dispatchEvent(new window.Event('input', {bubbles: true})); };
  const originalHash = window.location.hash;
  let original = null, saved = false;
  const callOffset = calls.length;
  try {
    await window.spoonNativeReady;
    original = await adapter.snapshot(true);
    const manager = await adapter.manager({});
    check('original popup initialized', document.documentElement.dataset.nativeReady === 'true');
    check('demo participants from facade', manager.session?.users.length > 0);
    check('demo events from facade', manager.session?.events.length > 0);
    for (const view of ['overview', 'records', 'tools', 'analysis', 'settings', 'help']) {
      window.location.hash = view; window.dispatchEvent(new window.Event('hashchange'));
      check(`original ${view} view visible`, find(`view-${view}`)?.hidden === false);
    }
    check('participant name rendered', find('users').textContent.includes(manager.session.users[0].name));
    check('event text rendered', find('events').textContent.includes(manager.session.events.at(-1).text));
    input('user-search', '__no_native_smoke_person__'); check('participant search excludes', !find('users').textContent.includes(manager.session.users[0].name));
    input('user-search', manager.session.users[0].name); check('participant search matches', find('users').textContent.includes(manager.session.users[0].name)); input('user-search', '');
    input('event-search', '__no_native_smoke_event__'); check('log search excludes', !find('events').querySelector('.event')); input('event-search', '');
    const goal = String((Number(find('heart-goal').value) || 100) + 1);
    input('heart-goal', goal);
    window.location.hash = 'settings/voice'; window.dispatchEvent(new window.Event('hashchange'));
    window.location.hash = 'settings/goals'; window.dispatchEvent(new window.Event('hashchange'));
    check('draft survives navigation', find('heart-goal').value === goal);
    await adapter.message({type: 'GET_MANAGER_STATE'}); check('poll preserves draft', find('heart-goal').value === goal);
    const draftValue = {fields: {'heart-goal': goal}, view: 'goals'};
    await adapter.message({type: 'SAVE_UI_DRAFT', draft: draftValue});
    check('draft round trip', (await adapter.message({type: 'GET_UI_DRAFT'})).draft.fields['heart-goal'] === goal);
    await adapter.message({type: 'CLEAR_UI_DRAFT'});
    check('draft cleared', (await adapter.message({type: 'GET_UI_DRAFT'})).draft === null);
    // Never enable playback in the isolated save exercise.
    find('v-enabled').checked = false; find('v-enabled').dispatchEvent(new window.Event('input', {bubbles: true}));
    find('v-settings-form').dispatchEvent(new window.Event('submit', {bubbles: true, cancelable: true}));
    await wait(() => calls.slice(callOffset).some(call => call.operation === 'save-settings') && !find('v-save').disabled);
    const persisted = await adapter.snapshot(true);
    check('original form saved through facade', Number(persisted.manager?.preferences?.heartGoal ?? persisted.preferences?.heartGoal) === Number(goal)); saved = true;
    check('save status visible', find('notice').textContent.includes('保存'));
    await wait(() => find('v-output-device').options.length > 0);
    check('Windows default output separate', find('v-output-device').options[0].value === '');
    const inbox = await adapter.message({type: 'MANAGER_REQUESTS', sessionKey: manager.session.key, action: '受付', open: true});
    check('request reception persists through native facade', inbox.ok && inbox.session.requests.open === true);
    const closedInbox = await adapter.message({type: 'MANAGER_REQUESTS', sessionKey: manager.session.key, action: '受付', open: false});
    check('request reception closes through native facade', closedInbox.ok && closedInbox.session.requests.open === false);
    // In --smoke the host writes actual exports inside its isolated data directory.
    // No renderer-selected path and no save dialog are involved.
    const exports = () => calls.slice(callOffset).filter(call => call.operation === 'export-csv');
    for (const id of ['export-users', 'export-events']) {
      find(id).click(); await wait(() => !find(id).disabled && exports().length >= ['export-users', 'export-events'].indexOf(id) + 1);
    }
    find('export-analysis').click(); await wait(() => calls.slice(callOffset).some(call => call.operation === 'save-csv' && call.completed));
    check('native participant and log CSV routes', exports().map(call => call.input.kind).join(',') === 'participants,logs');
    check('analysis exports the displayed rows through the native save dialog', calls.slice(callOffset).some(call => call.operation === 'save-csv' && call.input.name === 'spoon-manager-analysis.csv' && call.input.content.includes('配信ID')));
    check('CSV never supplies renderer paths', exports().every(call => Object.keys(call.input).sort().join(',') === 'kind,sessionKey'));
    check('host confirmed isolated CSV exports', exports().every(call => call.result?.cancelled === false));
    check('native export completion displayed', find('notice').textContent.includes('書き出しました'));
    // Click stop in the same turn while settings.js still has its test guard set.
    // Synthesis is explicitly rejected by the smoke safety gate, never simulated.
    find('v-test').click(); find('v-stop').click();
    await wait(() => !find('v-test').disabled && calls.slice(callOffset).some(call => call.operation === 'stop-audio' && call.completed));
    check('smoke blocks voice synthesis', calls.slice(callOffset).some(call => call.operation === 'test-voice' && call.blocked));
    check('voice stop bypasses busy test', calls.slice(callOffset).some(call => call.operation === 'stop-audio' && !call.blocked && call.completed));
    check('voice controls sit in relevant setting footers', find('v-test').closest('.control-footer') && find('v-diagnose-speech').closest('.control-footer'));
    check('header contains ordered receive, stop audio and refresh actions', [...document.querySelectorAll('.header-actions button')].map(node => node.id).join(',') === 'connect,v-stop,refresh');
    check('discard is adjacent to save', find('discard-changes').nextElementSibling === find('v-save'));
    find('v-diagnose-speech').click();
    await wait(() => !find('v-diagnose-speech').disabled);
    check('diagnostic reaches native safety gate', calls.slice(callOffset).some(call => call.operation === 'diagnose-speech' && call.blocked));
    await window.desktop.openSetup();
    check('startup API selector opens', find('native-setup')?.open && find('setup-provider') && find('setup-close-tab'));
    find('setup-later').click();
    check('startup API selector closes', !find('native-setup').open);
    const malformed = await adapter.message({type: 'MANAGER_REQUESTS', sessionKey: manager.session.key, action: 'status', id: -1, status: 'invalid'});
    check('invalid request changes are rejected', !malformed.ok);
    check('no live network or synthesis operations', !calls.slice(callOffset).some(call => !call.blocked && ['start-receiving', 'authorization-url', 'open-authorization', 'send-chat', 'test-voice', 'diagnose-speech'].includes(call.operation)));
    return report({ok: true, audioDevices: await window.desktop.listAudioOutputs(), nativeSaveVerified: true, nativeExportsVerified: true, synthesisBlocked: true});
  } catch (error) { return report({ok: false, error: error.message}); }
  finally {
    // Restore the isolated fixture, including every unknown settings/prefs key.
    if (saved && original) await window.spoonNative.call('save-settings', {settings: original.settings || {}, preferences: original.manager?.preferences || original.preferences || {}}).catch(() => {});
    adapter.invalidate();
    window.location.hash = originalHash; window.dispatchEvent(new window.Event('hashchange'));
  }
}
