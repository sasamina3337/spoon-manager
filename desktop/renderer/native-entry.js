import {DEFAULT_SETTINGS, LEGACY_VOICES} from './shared/settings.js';
import {analyzeSessions, sessionOwner, STAT_FIELDS} from './shared/analytics.js';
import {dailyAttendance} from './shared/attendance.js';
import {installSetup} from './setup.js';
import {missingSpoonScopes} from './shared/spoon-permissions.js';
import {NativeRuntime, runtimeSession, pollView, runtimeBoards, assignedSpeaker} from './runtime.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const array = value => Array.isArray(value) ? value : [];
const copy = value => structuredClone(value);
const defaults = {
  heartGoal: 100, spoonGoal: 100,
  features: {fans: false, follow: false, chat: false, djFollow: false, donations: false},
  commands: {enabled: true, cooldownSeconds: 10}, templates: []
};

// Merge the original form's known fields into the full C++ document, retaining
// unknown settings and nested preferences. Templates also retain unknown fields.
export function mergeNativeFields(base, patch, path = '') {
  const result = copy(object(base));
  for (const [key, value] of Object.entries(object(patch))) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    if (Array.isArray(value)) {
      result[key] = key === 'templates' ? value.map((item, index) => mergeNativeFields(array(result[key])[index], item)) : copy(value);
    } else if (value && typeof value === 'object') result[key] = mergeNativeFields(result[key], value, `${path}/${key}`);
    else result[key] = value;
  }
  return result;
}

function settingsForPopup(raw) {
  return mergeNativeFields(DEFAULT_SETTINGS, {...object(raw), spoonSource: 'api'});
}
function preferencesForPopup(raw) { return mergeNativeFields(defaults, raw); }
function preferencesOf(raw) { return object(raw.manager?.preferences ?? raw.preferences); }
function sessionsOf(raw) {
  return array(raw.manager?.sessions).map(saved => ({...saved, live: object(saved.live), users: array(saved.users), events: array(saved.events),
    totals: Object.fromEntries(STAT_FIELDS.map(field => [field, Number(saved.totals?.[field]) || 0])),
    requests: Array.isArray(saved.requests) ? {open: false, items: saved.requests} : {...object(saved.requests), items: array(saved.requests?.items)}}));
}

export function managerFromSnapshot(raw, {sessionKey, analysisLimit = 10, now = Date.now()} = {}) {
  const sessions = sessionsOf(raw), native = object(raw._native);
  const key = sessionKey || native.activeKey || sessions[0]?.key || '';
  let session = sessions.find(item => item.key === key) || null;
  if (session) {session = runtimeSession(raw, key); session.poll = pollView(session.poll);}
  const owner = sessionOwner(session?.key || '');
  const relevant = sessions.filter(item => sessionOwner(item.key) === owner);
  const profiles = (session?.users || []).map(user => {
    const total = Object.fromEntries(STAT_FIELDS.map(field => [field, 0])); total.sessions = 0;
    for (const saved of relevant) {
      const person = saved.users.find(item => item.id === user.id); if (!person) continue;
      total.sessions++;
      for (const field of STAT_FIELDS) total[field] += Number(person[field]) || 0;
    }
    return {id: user.id, name: user.name, current: Object.fromEntries(STAT_FIELDS.map(field => [field, Number(user[field]) || 0])),
      total, quantityUnknown: user.quantityUnknown, games: raw.runtime?.profiles?.[user.id] || null};
  });
  return {ok: true, session, sessions, preferences: preferencesForPopup(preferencesOf(raw)), activeKey: native.activeKey || '',
    profiles, attendance: dailyAttendance(sessions, owner, sessionOwner), boards: runtimeBoards(raw, key),
    listeners: array(native.listeners), listenersAt: native.lastActivity || now,
    analytics: analyzeSessions(sessions, {key, activeKey: native.receiving ? native.activeKey : '', limit: Number(analysisLimit), now}),
    spoonStatus: {state: native.connectionState || (native.receiving ? 'connecting' : 'stopped'), receiving: native.receiving === true, message: native.message || '配信の受信は停止中です。', authorized: native.authorized === true},
    commandStatus: {message: 'コマンドを待っています。'},
    automationStatus: {paused: session?.automationPaused === true, message: '有効にした自動コメントを待っています。'},
    limits: {sessions: 100, users: 1000, events: 10000}, native};
}

export function createNativeAdapter({call, now = () => Date.now(), onSnapshot = () => {}}) {
  if (typeof call !== 'function') throw new Error('アプリとの接続 がありません。');
  let cached = null, cachedAt = 0, pending = null, epoch = 0, draft = null, selection = {};
  let voiceTesting = false, pendingConnection = false, authorizationBaseline = 0, authorizationWasValid = false;
  const invalidate = () => { epoch++; cached = null; cachedAt = 0; };
  const runtime = new NativeRuntime({call, snapshot, invalidate, now});
  async function snapshot(fresh = false) {
    if (fresh) { if (pending) await pending; invalidate(); }
    if (cached && now() - cachedAt < 650) return cached;
    if (!pending) {
      const version = epoch;
      pending = Promise.resolve().then(() => call('snapshot', {})).then(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('保存データの形式が不正です。');
        if (version === epoch) { cached = copy(value); cachedAt = now(); onSnapshot(cached); }
        return value;
      }).finally(() => { pending = null; });
    }
    return pending;
  }
  async function manager(input = {}, fresh = false) {
    selection = {sessionKey: input.sessionKey, analysisLimit: input.analysisLimit ?? selection.analysisLimit ?? 10};
    const result = managerFromSnapshot(await snapshot(fresh), {...selection, now: now()});
    result.commandStatus = runtime.commands.status;
    result.automationStatus = {...runtime.automation, paused: result.session?.automationPaused === true};
    return result;
  }
  function readingState(raw) {
    const settings = settingsForPopup(raw.settings), native = object(raw._native);
    const voices = array(raw.runtime?.voices || raw.voices).filter(voice => Number.isSafeInteger(voice?.id) && typeof voice.name === 'string');
    // The bundled catalog is an explicitly labelled offline list, never an API response.
    const ids = new Map((voices.length ? voices : LEGACY_VOICES).map(voice => [voice.id, copy(voice)]));
    for (const id of [settings.systemSpeaker, ...array(settings.commentSpeakers)]) if (Number.isSafeInteger(id) && !ids.has(id)) ids.set(id, {id, name: `保存済み話者 ID ${id}`});
    const current = array(raw.manager?.sessions).find(session => session.key === native.activeKey);
    const participants = array(current?.users).map(user => ({...user, speaker: assignedSpeaker({...raw, settings}, user.id)}));
    return {ok: true, capabilities: {voiceCatalog: true}, settings, voices: [...ids.values()], participants, roomKey: native.activeKey || '',
      spoonStatus: managerFromSnapshot(raw, {now: now()}).spoonStatus,
      status: {enabled: settings.enabled, playing: voiceTesting, queued: Number(native.pendingSpeech) || 0, lastError: native.audioError || null}};
  }
  async function save(input) {
    const raw = await snapshot(true);
    const settings = mergeNativeFields(raw.settings, object(input.settings));
    const preferences = mergeNativeFields(preferencesOf(raw), input.preferences || {});
    await call('save-settings', {settings, preferences}); invalidate();
    const saved = await snapshot();
    return {...readingState(saved), manager: managerFromSnapshot(saved, {...selection, sessionKey: input.sessionKey, now: now()})};
  }
  async function authorizationURL() {
    // The host opens this URL. The renderer never navigates or calls window.open.
    const url = await call('authorization-url', {});
    const value = new URL(url);
    if (value.origin !== 'https://developers.spooncast.net' || value.username || value.password || value.hash || !/^\/(jp|kr)\/oauth\/authorize$/.test(value.pathname)) throw new Error('認証URLが不正です。');
    return value.href;
  }
  async function message(input = {}) {
    try {
      switch (input.type) {
        case 'GET_STATE': return readingState(await snapshot());
        case 'GET_MANAGER_STATE': return await manager(input);
        case 'GET_UI_DRAFT': return {ok: true, draft: copy(draft)};
        case 'SAVE_UI_DRAFT': draft = copy(input.draft ?? null); return {ok: true};
        case 'CLEAR_UI_DRAFT': draft = null; return {ok: true};
        case 'SAVE_APP_SETTINGS': case 'SAVE_SETTINGS': return await save(input);
        case 'SAVE_MANAGER_PREFS': return (await save({preferences: input.preferences})).manager;
        case 'AUTHORIZE_SPOON': return {ok: true, url: await authorizationURL()};
        case 'CONNECT_SPOON': {
          const raw = await snapshot(true);
          if (!raw._native?.authorized || raw._native?.connectionState === 'unauthorized' || missingSpoonScopes(raw._native?.scopes).length) {
            pendingConnection = true;
            authorizationBaseline = Number(raw._native?.authorizationCompleted) || 0;
            authorizationWasValid = raw._native?.authorized === true;
            const config = await call('connection', {});
            if (!config?.clientId || !config?.clientSecret) return {ok: true, needsSetup: true};
            return {ok: true, needsAuthorization: true, url: await authorizationURL()};
          }
          pendingConnection = false; runtime.prime(raw); await call('start-receiving', {}); invalidate(); return readingState(await snapshot());
        }
        case 'DISCONNECT_SPOON': pendingConnection = false; runtime.cancel(); await call('stop-audio', {}); await call('stop-receiving', {}); invalidate(); return readingState(await snapshot());
        case 'STOP': await call('stop-audio', {}); return {ok: true};
        case 'TEST_VOICE':
          voiceTesting = true;
          try { await call('test-voice', {}); return {ok: true}; }
          finally { voiceTesting = false; invalidate(); }
        case 'DIAGNOSE_SPEECH': return {ok: true, diagnostic: await call('diagnose-speech', {})};
        case 'SEND_MANAGER_CHAT': {
          const raw = await snapshot(true), native = object(raw._native);
          if (!input.sessionKey || input.sessionKey !== native.activeKey || !native.receiving) throw new Error('受信中の現在の配信を選択してください。');
          await call('send-chat', {text: String(input.text || '')}); invalidate(); return {ok: true};
        }
        case 'REFRESH_MANAGER': case 'FETCH_MANAGER_FANS': case 'FETCH_MANAGER_DONATIONS': case 'FOLLOW_MANAGER_DJ': {
          const raw = await snapshot(true), sessionKey = input.sessionKey || raw._native?.activeKey;
          if (input.type === 'FETCH_MANAGER_DONATIONS') {
            if (!preferencesForPopup(preferencesOf(raw)).features.donations) throw new Error('設定 → 連携で「ギフト履歴」を有効にして保存してください。');
            if (!sessionKey || sessionKey !== raw._native?.activeKey || !raw._native?.receiving) throw new Error('受信中の現在の配信を選択してください。');
            if (typeof raw._native.scopes === 'string' && !raw._native.scopes.split(/\s+/).includes('donations.read')) {
              return {ok: true, needsAuthorization: true, url: await authorizationURL()};
            }
          }
          const action = {REFRESH_MANAGER: 'refresh', FETCH_MANAGER_FANS: 'fans', FETCH_MANAGER_DONATIONS: 'donations', FOLLOW_MANAGER_DJ: 'follow'}[input.type];
          const result = await call('manager-action', {action, sessionKey, payload: {}}); invalidate();
          return input.type === 'FETCH_MANAGER_FANS' ? {ok: true, ...result} : await manager({sessionKey}, true);
        }
        case 'SET_AUTOMATION_PAUSED': case 'MANAGER_POLL': case 'MANAGER_REQUESTS': case 'SET_ASSIGNMENT': case 'RESET_ASSIGNMENTS': case 'REFRESH_VOICES':
          await runtime.action(input); invalidate();
          return ['SET_ASSIGNMENT', 'RESET_ASSIGNMENTS', 'REFRESH_VOICES'].includes(input.type) ? readingState(await snapshot()) : await manager({sessionKey: input.sessionKey}, true);
        default: throw new Error('操作を確認してください。');
      }
    } catch (error) { return {ok: false, error: error instanceof Error ? error.message : String(error)}; }
  }
  return {message, manager, snapshot, invalidate, runtime,
    async pump() {
      const raw = await snapshot(true);
      if (pendingConnection && raw._native?.authorized && (!authorizationWasValid || Number(raw._native.authorizationCompleted) > authorizationBaseline)) {
        pendingConnection = false;
        const missing = missingSpoonScopes(raw._native.scopes);
        if (missing.length) throw new Error(`Spoonの同意に必要な権限が不足しています（${missing.join('、')}）。開発者センターに全権限を登録し、受信開始からもう一度同意してください。`);
        const result = await message({type: 'CONNECT_SPOON'});
        if (!result.ok) throw new Error(result.error);
      }
      await runtime.tick();
    },
    async configure(config) { await call('configure', {config: copy(config)}); invalidate(); },
    connection: () => call('connection', {}),
    async audioDevices() {
      const devices = await call('audio-devices', {});
      return array(devices).filter(device => typeof device?.id === 'string' && device.id && typeof device.name === 'string')
        .map(device => ({kind: 'audiooutput', deviceId: device.id, label: device.name, groupId: ''}));
    },
    async exportCSV(kind, sessionKey) {
      if (!['participants', 'logs', 'analytics'].includes(kind)) throw new Error('CSV形式を確認してください。');
      if (!sessionKey) throw new Error('書き出す配信を選択してください。');
      return call('export-csv', {kind, sessionKey});
    }
  };
}

const byId = id => document.getElementById(id);
function showNotice(message, error = false) {
  const notice = byId('notice'); if (!notice) return;
  notice.textContent = String(message || ''); notice.hidden = !message; notice.classList.toggle('error', error);
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function field(parent, title, id, type = 'text') {
  const label = element('label', undefined, 'field'), input = element('input');
  label.append(element('span', title), input); input.id = id; input.type = type;
  input.autocomplete = 'off'; parent.append(label); return input;
}

function installConnectionForm(adapter) {
  const panel = document.querySelector('[data-settings-panel="connection"]');
  const section = element('section', undefined, 'card'); section.id = 'native-connection';
  section.append(element('h2', 'Spoon API接続設定'), element('p', '接続情報を保存してからDJの同意を取得します。', 'hint'));
  const client = field(section, 'Client ID', 'native-client-id');
  const secret = field(section, 'Client Secret', 'native-client-secret', 'password');
  const regionLabel = element('label', undefined, 'field'), region = element('select'); region.id = 'native-region';
  regionLabel.append(element('span', 'リージョン'), region);
  for (const [value, text] of [['jp', '日本'], ['kr', '韓国']]) { const option = element('option', text); option.value = value; region.append(option); }
  section.append(regionLabel);
  const port = field(section, 'ローカル認証ポート', 'native-port', 'number'); port.min = '1024'; port.max = '65535'; port.value = '17864';
  const redirect = element('p', '', 'hint'); section.append(redirect);
  const updateRedirect = () => { redirect.textContent = `登録するリダイレクトURI：http://localhost:${port.value}/oauth/callback`; };
  port.addEventListener('input', updateRedirect); updateRedirect();
  const credentials = element('details', undefined, 'connection-details');
  credentials.append(element('summary', '接続情報を編集'));
  for (const control of [client, secret, region, port]) credentials.append(control.closest('label'));
  credentials.append(redirect); section.append(credentials);
  const actions = element('div', undefined, 'control-footer');
  const save = element('button', '接続情報を保存'), authorize = element('button', 'Spoonにログイン'), prepare = element('button', '同意URLを表示');
  save.id = 'native-save-connection'; authorize.id = 'native-authorize'; prepare.id = 'native-prepare-authorization';
  for (const button of [save, authorize]) {button.type = 'button'; actions.append(button);}
  section.append(actions);
  const advanced = element('details'); advanced.append(element('summary', '同意URLを確認する')); section.append(advanced);
  const url = field(advanced, '作成した同意URL', 'native-authorization-url'); url.readOnly = true;
  prepare.type = 'button'; advanced.append(prepare);
  const status = element('p', '接続情報を読み込み中…', 'hint'); status.id = 'native-connection-status'; status.setAttribute('role', 'status'); section.append(status);
  panel.prepend(section);
  let original = {}, dirty = false, busy = false;
  for (const input of [client, secret, region, port]) input.addEventListener('input', () => { dirty = true; status.textContent = '接続情報に未保存の変更があります。専用の保存ボタンで保存してください。'; });
  async function run(button, task) {
    if (busy) return; busy = true; button.disabled = true;
    try { await task(); } catch (error) { status.textContent = error.message; showNotice(error.message, true); }
    finally { busy = false; button.disabled = false; }
  }
  save.addEventListener('click', () => run(save, async () => {
    const config = {...original, clientId: client.value.trim(), clientSecret: secret.value.trim(), region: region.value, port: Number(port.value)};
    if (!config.clientId || !config.clientSecret || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error('Client ID・Client Secret・ポート番号を確認してください。');
    await adapter.configure(config); original = config; dirty = false; status.textContent = '接続情報を保存しました。DJの同意を取得してください。'; showNotice(status.textContent);
  }));
  async function prepareURL() {
    if (dirty) throw new Error('接続情報を保存してから同意URLを作成してください。');
    const reply = await adapter.message({type: 'AUTHORIZE_SPOON'}); if (!reply.ok) throw new Error(reply.error);
    url.value = reply.url; return reply.url;
  }
  prepare.addEventListener('click', () => run(prepare, async () => { await prepareURL(); status.textContent = '外部ブラウザーで同意画面を開きました。作成したURLも表示しています。'; }));
  authorize.addEventListener('click', () => run(authorize, async () => { await prepareURL(); status.textContent = '外部ブラウザーでDJの同意を完了してください。認証状態は自動更新します。'; }));
  return {
    async load() {
      original = object(await adapter.connection());
      client.value = original.clientId || ''; secret.value = original.clientSecret || '';
      region.value = original.region || 'jp'; port.value = String(original.port || 17864); updateRedirect();
      credentials.open = !original.clientId;
      status.textContent = original.clientId ? '保存済みの接続情報です。変更した場合は保存してください。' : '接続情報を入力してください。';
    },
    open() { window.location.hash = 'settings/connection'; section.scrollIntoView?.({block: 'start'}); client.focus(); }
  };
}

function installNativeGuidance() {
  const legacy = byId('v-spoon-heading')?.closest('section');
  if (legacy) legacy.hidden = true;
  for (const id of ['v-spoon-source', 'v-spoon-bridge-url', 'v-spoon-bridge-key']) {
    const label = byId(id)?.closest('label'); if (label) label.hidden = true;
  }
  byId('v-test').title = '保存済みの声・速度・音量・出力先で再生します。変更した設定は保存してから試してください。';
}

export async function initializeNative() {
  if (window.location.origin !== 'https://spoon-manager.example' || window.location.pathname !== '/popup/popup.html') throw new Error('画面は信頼済みのローカルURLから開いてください。');
  const bridge = window.spoonNative;
  const calls = [];
  const nativeCall = async (operation, input = {}) => {
    const blocked = bridge.smoke === true && ['start-receiving', 'authorization-url', 'open-authorization', 'send-chat', 'send-generated', 'manager-action', 'voice-catalog', 'weather', 'participation', 'test-voice', 'diagnose-speech'].includes(operation);
    const record = {operation, input: ['configure', 'save-settings'].includes(operation) ? undefined : copy(input), blocked};
    calls.push(record);
    if (calls.length > 200) calls.shift();
    if (blocked) throw new Error('スモークテストでは通信・認証・音声合成を実行しません。');
    const result = await bridge.call(operation, input);
    record.completed = true;
    if (operation === 'export-csv') record.result = {cancelled: result?.cancelled};
    return result;
  };
  const adapter = createNativeAdapter({call: nativeCall});
  let popupReady;
  const popupStarted = new Promise(resolve => { popupReady = resolve; });
  const root = new URL('./', import.meta.url);
  const connectionForm = installConnectionForm(adapter);
  const setup = installSetup({adapter, onSaved: async () => {
    const {settingsUI} = await import('./popup/settings.js');
    await Promise.all([settingsUI.refresh({settings: true}), connectionForm.load()]);
  }});
  window.desktop = {
    listAudioOutputs: () => adapter.audioDevices(),
    participation: (action, payload = {}) => adapter.runtime.participation(action, payload),
    saveCSV: (name, content) => nativeCall('save-csv', {name, content}),
    openSetup: () => setup.open()
  };
  globalThis.browser = {
    runtime: {getURL: path => new URL(path, root).href,
      async sendMessage(input) {
        const result = await adapter.message(input);
        if (input?.type === 'GET_UI_DRAFT') window.setTimeout(popupReady, 0);
        return result;
      }},
    tabs: {query: async () => []}
  };
  // Intercept only actions whose original handlers download blobs or assume
  // capabilities missing from Application. Ordinary popup rendering stays intact.
  let exporting = false;
  document.addEventListener('click', async event => {
    const button = event.target.closest?.('button'); if (!button) return;
    const kind = {'export-users': 'participants', 'export-events': 'logs'}[button.id];
    if (kind) {
      event.preventDefault(); event.stopImmediatePropagation(); if (exporting) return;
      exporting = true; button.disabled = true;
      try {
        const manager = await adapter.manager({sessionKey: byId('session').value || undefined});
        const result = await adapter.exportCSV(kind, manager.session?.key);
        showNotice(result?.cancelled ? 'CSVの保存をキャンセルしました。'
          : result?.cancelled === false ? 'CSVを書き出しました。' : 'CSVの保存を開始しました。');
      } catch (error) { showNotice(error.message, true); }
      finally { exporting = false; button.disabled = false; }
      return;
    }
    if (button.id === 'v-stop') {
      // Bypass settings.js's busy guard so a voice test can always be cancelled.
      event.preventDefault(); event.stopImmediatePropagation();
      const result = await adapter.message({type: 'STOP'}); showNotice(result.ok ? '再生と待機中の読み上げを停止しました。' : result.error, !result.ok);
    }
  }, true);
  installNativeGuidance();
  await Promise.all([adapter.snapshot(), connectionForm.load(), import('./popup/popup.js')]);
  await Promise.race([popupStarted, new Promise((_, reject) => window.setTimeout(() => reject(new Error('元の画面の初期化が完了しませんでした。')), 10000))]);
  document.documentElement.dataset.nativeReady = 'true';
  if (bridge.smoke === true) {
    const {runNativeSmoke} = await import('./native-smoke.js');
    window.spoonNativeSmoke = () => runNativeSmoke({adapter, calls});
  }
  adapter.runtime.prime(await adapter.snapshot(true));
  if (!bridge.smoke) {
    let pumping = false;
    window.spoonNativePulse = async () => {
      adapter.runtime.wake();
      if (pumping) return;
      pumping = true;
      try {await adapter.pump();} catch(error) {showNotice(error.message, true);} finally {pumping = false;}
    };
    // Normal Windows launches use WM_TIMER/ExecuteScript, which continues while
    // minimized. The interval is only a browser-preview fallback.
    if (!bridge.pulse) {
      const pump = window.setInterval(window.spoonNativePulse, 1000);
      window.addEventListener('pagehide', () => window.clearInterval(pump), {once: true});
    }
  }
  await nativeCall('ready', {});
  if (!bridge.smoke && (await adapter.snapshot()).settings?.showSetupOnStartup !== false) await setup.open();
  return adapter;
}

if (globalThis.window?.spoonNative) {
  window.spoonNativeReady = initializeNative();
  window.spoonNativeReady.catch(error => { document.documentElement.dataset.nativeError = error.message; showNotice(`画面の初期化に失敗しました：${error.message}`, true); });
}
