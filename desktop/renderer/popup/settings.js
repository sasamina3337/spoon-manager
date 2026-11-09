import { DEFAULT_SETTINGS, LEGACY_VOICES, normalizeSettings, notificationVoiceIds } from '../shared/settings.js';
import {send, notice as showNotice} from '../shared/ui.js';
import {AudioOutputUI} from './audio-output.js';
import {nativeAudioDevices} from '../services/audio.js';

const $ = (id) => document.getElementById('v-' + id);
const nativeOutputs = nativeAudioDevices();
const audioOutput = new AudioOutputUI({select: $('output-device'), refresh: $('refresh-outputs'), status: $('output-status'), name: $('output-name'),
  ...(nativeOutputs ? {mediaDevices: nativeOutputs, supported: true} : {})});
let integration;
let catalogSupported = true;
export const settingsUI = {
  initialize(options) { integration = options; return initialize(); },
  refresh: refreshState,
  get dirty() { return dirty; },
  get busy() { return busy; },
  pool: selectedPool,
  reset() { editRevision++; renderSettings(savedSettings); },
  restoreDraft(pool) {
    if (pool) for (const input of $('voice-pool').querySelectorAll('input')) input.checked = !input.disabled && pool.includes(Number(input.value));
    showProvider(); showSpoonSource(); updateRanges(); updatePoolCount(); updateGreeting(); markDirty();
  }
};
const eventTypes = Object.keys(DEFAULT_SETTINGS.eventEnabled);
let tabId;
let voices = LEGACY_VOICES;
let savedSettings = normalizeSettings(DEFAULT_SETTINGS);
let dirty = false;
let busy = false;
let editRevision = 0;
let catalogFetched = false;
let lastParticipants = [];
let participantSignature = '';
let displayedApiError = '';

function markDirty() {
  editRevision++;
  dirty = true;
  $('save-status').textContent = '未保存の変更があります。';
  $('save-status').classList.add('unsaved');
  integration?.onDirty();
}

function showProvider() {
  const engine = $('provider').value === 'engine';
  $('engine-fields').hidden = !engine;
  $('legacy-fields').hidden = engine;
  $('engine-url').disabled = !engine;
}

function showSpoonSource() {
  $('spoon-api-fields').hidden = $('spoon-source').value !== 'api';

  document.getElementById('api-permissions').hidden = $('spoon-source').value !== 'api';
  $('greeting-heading').closest('section').hidden = $('spoon-source').value !== 'api';
}

function updateGreeting() {
  $('greeting-preview').textContent = $('greeting-template').value.replaceAll('{name}', 'リスナー');
  $('greeting-status').textContent = savedSettings.autoGreeting.enabled ? '保存済み：自動コメントは ON です。' : '保存済み：自動コメントは OFF です。';
  for (const type of ['heart', 'spoon']) {
    $('auto-' + type + '-preview').textContent = $('auto-' + type + '-template').value.replaceAll('{name}', 'リスナー').replaceAll('{amount}', '10').replaceAll('{title}', '配信タイトル');
  }
  $('small-gift-preview').textContent = $('small-gift-template').value.replaceAll('{name}', 'リスナー').replaceAll('{amount}', '0').replaceAll('{title}', '配信タイトル');
  $('announcement-preview').textContent = $('announcement-template').value.replaceAll('{title}', '配信タイトル');
}

function renderSpoonStatus(status) {
  $('spoon-status').textContent = status?.message || 'API受信は停止中です。';
  $('spoon-status').classList.toggle('error', status?.state === 'error');
}

function updateRanges() {
  $('speed-value').textContent = `${Number($('speed').value).toFixed(1)} 倍`;
  $('volume-value').textContent = `${Math.round(Number($('volume').value) * 100)}%`;
}

function selectedPool() {
  return [...$('voice-pool').querySelectorAll('input:checked')].map((input) => Number(input.value));
}

function updatePoolCount() {
  $('pool-count').textContent = `${selectedPool().length} 声`;
}

function voiceOption(voice) {
  const option = document.createElement('option');
  option.value = String(voice.id);
  option.textContent = voice.name;
  return option;
}

function availableVoices(extraIds = []) {
  const result = [...voices];
  const known = new Set(result.map((voice) => Number(voice.id)));
  for (const id of extraIds) {
    if (Number.isFinite(Number(id)) && !known.has(Number(id))) {
      result.push({ id: Number(id), name: `話者 ID ${id}` });
      known.add(Number(id));
    }
  }
  return result;
}

function renderVoices(systemSpeaker, commentSpeakers) {
  const list = availableVoices([systemSpeaker, ...commentSpeakers]);
  $('system-speaker').replaceChildren(...list.map(voiceOption));
  $('system-speaker').value = String(systemSpeaker);
  const selected = new Set(commentSpeakers.map(Number));
  const reserved = notificationVoiceIds(list, systemSpeaker);
  const fragment = document.createDocumentFragment();
  for (const voice of list) {
    const label = document.createElement('label');
    label.className = 'check-row';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = String(voice.id);
    input.disabled = reserved.includes(voice.id);
    input.checked = !input.disabled && selected.has(Number(voice.id));
    const text = document.createElement('span');
    text.textContent = voice.name + (input.disabled ? '（通知専用）' : '');
    label.append(input, text);
    fragment.append(label);
  }
  $('voice-pool').replaceChildren(fragment);
  updatePoolCount();
}

function renderSettings(settings) {
  savedSettings = normalizeSettings(settings);
  $('provider').value = savedSettings.provider;
  $('api-key').value = savedSettings.apiKey;
  $('engine-url').value = savedSettings.engineUrl;
  $('enabled').checked = savedSettings.enabled;
  $('spoon-source').value = savedSettings.spoonSource;
  $('spoon-bridge-url').value = savedSettings.spoonBridgeUrl;
  $('spoon-bridge-key').value = savedSettings.spoonBridgeKey;
  $('greeting-enabled').checked = savedSettings.autoGreeting.enabled;
  $('greeting-template').value = savedSettings.autoGreeting.template;
  $('greeting-cooldown').value = savedSettings.autoGreeting.cooldownSeconds;
  $('small-gift-template').value = savedSettings.autoReplies.heart.smallGiftTemplate;
  for (const type of ['heart', 'spoon']) {
    for (const field of ['template', 'minAmount']) $('auto-' + type + '-' + ({minAmount: 'minimum'}[field] || field)).value = savedSettings.autoReplies[type][field];
    $('auto-' + type + '-enabled').checked = savedSettings.autoReplies[type].enabled;
  }
  $('announcement-enabled').checked = savedSettings.announcements.enabled;
  $('announcement-template').value = savedSettings.announcements.template;
  $('announcement-interval').value = savedSettings.announcements.intervalMinutes;
  $('read-names').checked = savedSettings.readNames;
  for (const type of ['weather', 'other']) $('command-speech-' + type).checked = savedSettings.commandSpeech[type];
  $('speed').value = savedSettings.speed;
  $('volume').value = savedSettings.volume;
  audioOutput.render(savedSettings);
  for (const type of eventTypes) $('event-' + type).checked = savedSettings.eventEnabled[type];
  renderVoices(savedSettings.systemSpeaker, savedSettings.commentSpeakers);
  showProvider();
  showSpoonSource();
  updateGreeting();
  updateRanges();
  dirty = false;
  $('save-status').textContent = 'すべての設定をまとめて保存します。';
  $('save-status').classList.remove('unsaved');
}

function applySavedState(state, revisionAtStart) {
  if (Array.isArray(state.voices) && state.voices.length) voices = state.voices;
  if (state.settings) savedSettings = normalizeSettings(state.settings);
  if (editRevision === revisionAtStart) renderSettings(savedSettings);
  else renderVoices(Number($('system-speaker').value), selectedPool());
  renderStatus(state.status);
  renderSpoonStatus(state.spoonStatus);
  renderParticipants(state.participants, state.roomKey);
}

function collectSettings() {
  if (selectedPool().length === 0) throw new Error('コメントに使う声を 1 つ以上選んでください。');
  const engineUrl = $('provider').value === 'engine' ? $('engine-url').value.trim() : savedSettings.engineUrl;
  if ($('provider').value === 'engine') {
    let url;
    try { url = new URL(engineUrl); } catch { throw new Error('エンジンの URL を正しく入力してください。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('エンジンには認証情報を含まない http / https の URL を指定してください。');
    }
  }
  return normalizeSettings({
    ...savedSettings,
    provider: $('provider').value,
    apiKey: $('api-key').value.trim(),
    engineUrl,
    systemSpeaker: Number($('system-speaker').value),
    commentSpeakers: selectedPool(),
    speed: Number($('speed').value),
    volume: Number($('volume').value),
    ...audioOutput.selection,
    enabled: $('enabled').checked,
    spoonSource: $('spoon-source').value,
    spoonBridgeUrl: $('spoon-bridge-url').value,
    spoonBridgeKey: $('spoon-bridge-key').value,
    autoGreeting: {enabled: $('greeting-enabled').checked, template: $('greeting-template').value,
      cooldownSeconds: Number($('greeting-cooldown').value)},
    autoReplies: Object.fromEntries(['heart', 'spoon'].map(type => [type, {enabled: $('auto-' + type + '-enabled').checked,
      ...(type === 'heart' ? {smallGiftTemplate: $('small-gift-template').value} : {}),
      template: $('auto-' + type + '-template').value, minAmount: Number($('auto-' + type + '-minimum').value)}])),
    announcements: {enabled: $('announcement-enabled').checked, template: $('announcement-template').value, intervalMinutes: Number($('announcement-interval').value)},
    readNames: $('read-names').checked,
    commandSpeech: Object.fromEntries(['weather', 'other'].map(type => [type, $('command-speech-' + type).checked])),
    eventEnabled: Object.fromEntries(eventTypes.map((type) => [type, $('event-' + type).checked])),
  });
}

function renderStatus(status = {}) {
  const queued = Number(status.queued) || 0;
  const unconfigured = savedSettings.provider === 'legacy' && !savedSettings.apiKey;
  $('playback-status').textContent = status.lastError ? (/HTTP 5\d\d/.test(status.lastError) ? '音声サービスでエラー' : '接続を確認してください') : status.enabled === false ? '読み上げは無効です' : unconfigured ? '「読み上げ」で音声APIキーを設定' : status.playing ? `読み上げ中${queued ? ` · 待機 ${queued} 件` : ''}` : queued ? `${queued} 件の読み上げを待機中` : 'コメントを待っています';
  $('status-dot').classList.toggle('active', status.enabled !== false && !status.lastError && !unconfigured);
  $('status-dot').classList.toggle('error', Boolean(status.lastError));
  if (status.lastError && displayedApiError !== status.lastError) showNotice(String(status.lastError), true);
  if (!status.lastError && displayedApiError && document.getElementById('notice').textContent === displayedApiError) showNotice('音声の読み上げが復旧しました。');
  displayedApiError = status.lastError || '';
}

function renderParticipants(participants = [], roomKey) {
  participantSignature = JSON.stringify([participants, roomKey]);
  lastParticipants = participants;
  $('participant-count').textContent = String(participants.length);
  $('room-hint').textContent = savedSettings.spoonSource === 'api' ? '同意した DJ の配信で検出した参加者です。声は個別に変更できます。' : roomKey ? 'このページで検出した参加者です。声は個別に変更できます。' : 'Spoon の配信ページを開いて「更新」を押してください。';
  $('reset-assignments').disabled = !participants.length;
  if (!participants.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = roomKey ? 'まだ参加者を検出していません。\nコメントや入室通知を待っています。' : '配信に接続すると、ここに参加者が表示されます。';
    $('participants').replaceChildren(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const participant of participants) {
    const row = document.createElement('div');
    row.className = 'participant-row';
    const name = document.createElement('span');
    name.className = 'participant-name';
    name.textContent = participant.name;
    name.title = participant.name;
    const select = document.createElement('select');
    select.setAttribute('aria-label', `${participant.name} さんの声`);
    const reserved = notificationVoiceIds(voices, savedSettings.systemSpeaker);
    select.append(...availableVoices([participant.speaker]).filter(voice => !reserved.includes(voice.id)).map(voiceOption));
    select.disabled = !select.options.length;
    select.value = String(participant.speaker);
    select.addEventListener('change', async () => {
      select.disabled = true;
      try {
        await send('SET_ASSIGNMENT', { tabId, userId: participant.id, speaker: Number(select.value) });
        participant.speaker = Number(select.value);
        showNotice(`${participant.name} さんの声を変更しました。`);
      } catch (error) {
        select.value = String(participant.speaker);
        showNotice(error.message, true);
      } finally { select.disabled = false; }
    });
    row.append(name, select);
    fragment.append(row);
  }
  $('participants').replaceChildren(fragment);
}

async function refreshState({ settings = false } = {}) {
  const state = await send('GET_STATE', { tabId });
  catalogSupported = state.capabilities?.voiceCatalog !== false;
  if (Array.isArray(state.voices) && state.voices.length) voices = state.voices;
  if (settings && state.settings) renderSettings(state.settings);
  renderStatus(state.status);
  renderSpoonStatus(state.spoonStatus);
  if (JSON.stringify([state.participants || [], state.roomKey]) !== participantSignature) renderParticipants(state.participants, state.roomKey);
  return state;
}

async function runAction(button, action) {
  if (busy) return;
  busy = true;
  button.disabled = true;
  try { await action(); } catch (error) { showNotice(error.message, true); }
  finally { busy = false; button.disabled = false; }
}

$('settings-form').addEventListener('input', () => { markDirty(); updateRanges(); updatePoolCount(); updateGreeting(); });
$('enabled').addEventListener('change', markDirty);
$('provider').addEventListener('change', showProvider);
$('spoon-source').addEventListener('change', showSpoonSource);
$('system-speaker').addEventListener('change', () => {
  renderVoices(Number($('system-speaker').value), selectedPool());
  markDirty();
});
$('show-key').addEventListener('click', () => {
  const visible = $('api-key').type === 'password';
  $('api-key').type = visible ? 'text' : 'password';
  $('show-key').textContent = visible ? '隠す' : '表示';
  $('show-key').setAttribute('aria-pressed', String(visible));
  $('show-key').setAttribute('aria-label', visible ? 'API キーを隠す' : 'API キーを表示');
});
$('select-all-voices').addEventListener('click', () => {
  for (const input of $('voice-pool').querySelectorAll('input')) input.checked = !input.disabled;
  updatePoolCount();
  markDirty();
});

$('settings-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (busy) return;
  let settings;
  const revisionAtStart = editRevision;
  let shouldFetch;
  let preferences, preferencesRevision;
  try {
    settings = collectSettings();
    preferences = integration.collectPreferences();
    preferencesRevision = integration.preferencesRevision();
    shouldFetch = catalogSupported && settings.enabled && (settings.provider === 'engine' || Boolean(settings.apiKey)) && (!catalogFetched || settings.provider !== savedSettings.provider ||
      settings.apiKey !== savedSettings.apiKey || settings.engineUrl !== savedSettings.engineUrl);
  } catch (error) { showNotice(error.message, true); return; }
  runAction($('save'), async () => {
    const result = await send('SAVE_APP_SETTINGS', { settings, preferences, tabId, sessionKey: integration.sessionKey() });
    applySavedState({ ...result, settings: result.settings || settings }, revisionAtStart);
    integration.onSaved(result.manager, preferencesRevision);
    let fetchError = '';
    if (shouldFetch) {
      showNotice('設定を保存しました。利用できる声を取得しています…');
      try {
        const refreshed = await send('REFRESH_VOICES', { tabId });
        if (!Array.isArray(refreshed.voices) || !refreshed.voices.length) throw new Error('利用できる声が見つかりませんでした。');
        catalogFetched = true;
        applySavedState(refreshed, revisionAtStart);
      } catch (error) { catalogFetched = false; fetchError = error.message; }
    }
    if (fetchError) showNotice(`設定は保存しました。声の一覧を取得できませんでした：${fetchError}「保存済み API から声を取得」で再試行できます。`, true);
    else showNotice(dirty ? '設定を保存しました。その後の変更はまだ保存されていません。' : '設定を保存しました。');
    integration.onDirty();
  });
});

$('test').addEventListener('click', () => runAction($('test'), async () => {
  const status = $('test-status');
  status.classList.remove('error');
  status.textContent = dirty ? '保存済みの設定でテストしています。未保存の変更は反映されません。' : '保存済みの声・出力先で音声を再生しています…';
  try {
    await send('TEST_VOICE', { text: '音声の接続テストです。' });
    status.textContent = '読み上げテストが完了しました。聞こえない場合は、選択中の出力先と音量を確認してください。';
    showNotice(status.textContent);
    await refreshState();
  } catch (error) { status.textContent = error.message; status.classList.add('error'); throw error; }
}));
$('diagnose-speech').addEventListener('click', () => runAction($('diagnose-speech'), async () => {
  $('speech-diagnostic').hidden = false;
  $('speech-diagnostic').textContent = '保存済み設定で音声APIへの接続と短文の音声合成を確認しています…';
  try {
    const {diagnostic} = await send('DIAGNOSE_SPEECH');
    const stages = {voices: '声の一覧', query: '音声クエリ', audio_query: '音声クエリ', synthesis: '音声合成'};
    const checks = diagnostic.requests.map(item => `${stages[item.stage] || '音声API'}：${item.status ? `HTTP ${item.status}` : '通信失敗'}`).join('\n');
    $('speech-diagnostic').textContent = `${new Date(diagnostic.checkedAt).toLocaleString('ja-JP', {timeZone: 'Asia/Tokyo'})}\n${diagnostic.message}${checks ? `\n${checks}` : ''}`;
    $('speech-diagnostic').classList.toggle('error', !diagnostic.ok);
    showNotice(diagnostic.ok ? '現在の音声APIは正常に応答しました。' : diagnostic.message, !diagnostic.ok);
  } catch (error) {
    $('speech-diagnostic').textContent = '診断を完了できませんでした。もう一度お試しください。';
    throw error;
  }
}));
$('stop').addEventListener('click', () => runAction($('stop'), async () => {
  await send('STOP');
  await refreshState();
  showNotice('再生と待機中の読み上げを停止しました。次の通知から再開します。');
}));
$('refresh-room').addEventListener('click', () => runAction($('refresh-room'), () => refreshState()));
$('reset-assignments').addEventListener('click', () => runAction($('reset-assignments'), async () => {
  await send('RESET_ASSIGNMENTS', { tabId });
  await refreshState();
  showNotice('保存済みの候補から声を自動で割り当て直しました。');
}));
$('refresh-voices').addEventListener('click', () => runAction($('refresh-voices'), async () => {
  const revisionAtStart = editRevision;
  const wasDirty = dirty;
  const result = await send('REFRESH_VOICES', { tabId });
  const speaker = Number($('system-speaker').value);
  const pool = selectedPool();
  if (!Array.isArray(result.voices) || !result.voices.length) throw new Error('利用できる声が見つかりませんでした。API の設定を確認してください。');
  catalogFetched = true;
  voices = result.voices;
  if (result.settings) savedSettings = normalizeSettings(result.settings);
  if (!wasDirty && editRevision === revisionAtStart) renderSettings(savedSettings);
  else renderVoices(speaker, pool);
  renderParticipants(result.participants || lastParticipants, result.roomKey);
  showNotice(`${voices.length} 件の声を取得しました。使いたい声を選んで保存してください。`);
}));

async function initialize() {
  try {
    await refreshState({ settings: true });
    // Native device enumeration can take seconds with virtual audio drivers.
    // Show the saved selection immediately and populate devices in the background.
    const outputs = audioOutput.refresh();
    if (!globalThis.window?.spoonNative) await outputs;
  } catch (error) {
    renderSettings(savedSettings);
    showNotice(error.message, true);
    $('playback-status').textContent = '設定を読み込めませんでした';
  }
}

