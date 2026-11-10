import {initializeWorkspace} from '../shared/workspace.js';
import {csv, drawListeners} from '../shared/manager-utils.js';
import {COMMANDS, isCommandEnabled} from '../background/chat-commands.js';
import {createCommandSettings} from './command-settings.js';
import {$, send, notice, node, time, download, poll} from '../shared/ui.js';
import {settingsUI} from './settings.js';
import {renderDashboard} from './dashboard.js';
import {createBoardViewer} from './board-viewer.js';
import {createRequestInbox} from './request-inbox.js';
import {createParticipationPanel} from './participation.js';
import {createAttendancePanel} from './attendance.js';
import {createDonationsPanel} from './donations.js';

const boardContainer = document.createElement('div');
document.getElementById('board-viewer-slot').append(boardContainer);
const boardViewer = createBoardViewer(boardContainer);
const requestContainer = document.createElement('section');
requestContainer.id = 'request-inbox';
document.getElementById('request-inbox-slot').append(requestContainer);
const requestInbox = createRequestInbox(requestContainer, {run: action, update: apply});
const participationContainer = document.createElement('section');
document.getElementById('participation-slot').append(participationContainer);
createParticipationPanel(participationContainer, {run: action});
const attendance = createAttendancePanel($('attendance-slot'));
const donations = createDonationsPanel($('donations-slot'), {refresh: button => action(button, async () => {
  const result = await send('FETCH_MANAGER_DONATIONS', {sessionKey: sessionKey()});
  if (result.needsAuthorization) {
    notice('ブラウザーでギフト履歴の追加同意を完了してから、もう一度「ギフト履歴を更新」を押してください。donations.read が表示されない場合は、開発者センターで権限を登録してください。');
    return;
  }
  apply(result);
  notice('ギフト履歴を保存しました。');
}), authorize: button => action(button, async () => {
  await send('AUTHORIZE_SPOON');
  notice('ブラウザーでDJの追加同意を完了してから、ギフト履歴を更新してください。開発者センターへの donations.read の登録も必要です。');
})});

const types = {comment: 'コメント', entry: '入室', heart: 'ハート', spoon: 'スプーン', follow: 'フォロー', question: '質問箱', automatic: '自動コメント', automaticError: '自動コメント失敗', bot: 'ボット送信', botError: 'ボット送信失敗'};
const features = ['fans', 'follow', 'chat', 'djFollow', 'donations'];
let state, selected = '', busy = false, prefsDirty = false, prefsSignature = '', sessionSignature = '';
let profileSignature = '';
let prefsRevision = 0, settingView = 'connection';
let usersSignature = '', eventsSignature = '', eventsLimit = 100;
const eventsMore = node('button', 'さらに100件を表示'); eventsMore.type = 'button';
$('events').after(eventsMore);
eventsMore.addEventListener('click', () => {eventsLimit += 100; renderEvents();});
const managerRequest = () => ({sessionKey: selected || undefined, analysisLimit: Number($('analysis-limit').value)});

async function setSession(key) {
  eventsLimit = 100;
  selected = key;
  apply(await send('GET_MANAGER_STATE', managerRequest()));
  $('session').value = selected;
  $('fans').replaceChildren(node('li', '配信を変更しました。現在の配信で再取得してください。'));
  $('draw-result').textContent = '抽選結果はここに表示します。';
}

const {showSettings} = initializeWorkspace({onSettingsChange: name => {settingView = name;}});
const commandSettings = createCommandSettings($('command-toggles'), {onChange: markDirty});

function markDirty() {
  prefsDirty = true; prefsRevision++; updateSaveBar();
}

function updateSaveBar() {
  const dirty = prefsDirty || settingsUI.dirty;
  $('unsaved').hidden = !dirty;
  $('prefs-state').textContent = dirty ? '未保存の変更があります。' : '保存済み';
  document.body.classList.toggle('has-unsaved', dirty);
}

function availability() {
  if (!state || busy) return;
  const running = state.spoonStatus?.receiving === true;
  $('connect').disabled = false;
  $('connect').textContent = running ? '受信停止' : '受信開始';
  $('connect').setAttribute('aria-pressed', String(running));
  $('connect').classList.toggle('receiving', running);
  $('refresh').disabled = !running || !state.activeKey;
  const current = Boolean(state.session) && state.session.key === state.activeKey && !state.session.endedAt;
  for (const [id, feature] of [['send-chat', 'chat'], ['follow-dj', 'djFollow'], ['refresh-fans', 'fans']]) {
    $(id).disabled = !current || !state.preferences.features[feature];
    $(id).title = !state.preferences.features[feature] ? '管理設定で機能を有効にし、DJの追加同意を得てください。' : !current ? '現在の配信を選択してください。' : '';
  }
  $('draw').disabled = false;
  donations.render(state);
  $('start-poll').disabled = !current || Boolean(state.session?.poll?.open) || !state.preferences.features.chat;
  $('end-poll').disabled = !current || !state.session?.poll?.open || !state.preferences.features.chat;
  requestInbox.render(state);
}


async function action(button, operation) {
  if (busy) return;
  busy = true; button.disabled = true;
  try { await operation(); } catch (error) { notice(error.message, true); }
  finally { busy = false; button.disabled = false; availability(); }
}


function templateRow(value = {label: '', text: ''}) {
  const row = node('div', undefined, 'template-row');
  const label = node('input'); label.value = value.label; label.maxLength = 40; label.placeholder = '定型文の名前'; label.setAttribute('aria-label', '定型文の名前');
  const text = node('textarea'); text.value = value.text; text.maxLength = 200; text.rows = 2; text.placeholder = '本文（200文字まで）'; text.setAttribute('aria-label', '定型文の本文');
  const remove = node('button', '削除'); remove.type = 'button'; remove.addEventListener('click', () => { row.remove(); markDirty(); saveDraft(); });
  row.append(label, text, remove); return row;
}

function renderPreferences() {
  const prefs = state.preferences;
  const signature = JSON.stringify(prefs);
  if (prefsDirty || prefsSignature === signature) return;
  prefsSignature = signature;
  $('heart-goal').value = prefs.heartGoal; $('spoon-goal').value = prefs.spoonGoal;
  $('commands-enabled').checked = prefs.commands.enabled;
  $('commands-cooldown').value = prefs.commands.cooldownSeconds;
  commandSettings.render(prefs.commands);
  for (const feature of features) $('feature-' + feature).checked = prefs.features[feature];
  $('templates').replaceChildren(...prefs.templates.map(templateRow));
  const previous = $('template-select').value;
  const options = [node('option', '定型文を選択')]; options[0].value = '';
  prefs.templates.forEach((item, index) => { const option = node('option', item.label); option.value = index; options.push(option); });
  $('template-select').replaceChildren(...options); $('template-select').value = previous;
  updateSaveBar();
}

function renderSessions() {
  const signature = JSON.stringify(state.sessions.map(item => [item.key, item.live.title, item.endedAt]));
  if (signature === sessionSignature) return;
  sessionSignature = signature;
  const options = [node('option', '現在の受信')]; options[0].value = '';
  for (const session of state.sessions) {
    const option = node('option', `${session.live.title || '配信'} · ${time(session.observedAt)}${session.endedAt ? '（終了）' : ''}`);
    option.value = session.key; options.push(option);
  }
  $('session').replaceChildren(...options); $('session').value = selected;
}

function renderCounters() {
  const session = state?.session;
  $('live-title').textContent = session?.live.title || '配信に接続してください';
  const live = session?.live;
  if (session) {
    const current = session.key === state.activeKey;
    const end = session.endedAt ? Date.parse(session.endedAt) : current ? Date.now() : Date.parse(session.updatedAt || session.observedAt);
    const elapsed = Math.max(0, Math.floor((end - Date.parse(live.startedAt || session.observedAt)) / 60000));
    $('live-info').textContent = `配信 #${live.liveId} · ${session.endedAt ? '終了' : current ? '経過' : '記録時点'} ${elapsed}分 · リスナー ${live.listenerCount ?? '—'}人 / 累計 ${live.totalListenerCount ?? '—'}人 · ${live.isChatFrozen ? 'チャット凍結中' : 'チャット受付'} · 情報取得 ${time(session.liveUpdatedAt || session.observedAt)}`;
  } else $('live-info').textContent = '設定でDJの同意後に受信を開始してください。';
  $('count-scope').textContent = '受信できた範囲の集計です。DJの発言と、切断中・権限のないイベントはコメント数に含みません。';
  const unknown = session?.quantityUnknown;
  $('quantity-unknown').hidden = !unknown || !(unknown.hearts || unknown.spoons);
  $('quantity-unknown').textContent = `数量不明の通知：ハート ${unknown?.hearts || 0}件 ／ スプーン ${unknown?.spoons || 0}件。表示が0でも送信がなかったとは限りません。`;
  $('welcome').textContent = live?.welcomeMessage || '';
  for (const field of ['comments', 'entries', 'hearts', 'spoons', 'follows']) $(field).textContent = (session?.totals[field] || 0).toLocaleString('ja-JP');
  $('people').textContent = session?.users.length || 0;
  for (const [type, field] of [['heart', 'hearts'], ['spoon', 'spoons']]) {
    const goal = state.preferences[type + 'Goal'];
    const actual = session?.totals[field] || 0;
    $(type + '-progress').value = goal ? Math.min(100, actual / goal * 100) : 0;
    $(type + '-progress-text').textContent = goal ? `${actual.toLocaleString()} / ${goal.toLocaleString()}${actual >= goal ? ' 達成！' : ''}` : '目標なし';
  }
}

function renderUsers() {
  const query = $('user-search').value.toLocaleLowerCase();
  const field = $('user-sort').value;
  const signature = JSON.stringify([state?.session?.users, query, field]);
  if (signature === usersSignature) return;
  usersSignature = signature;
  const users = (state?.session?.users || []).filter(user => user.name.toLocaleLowerCase().includes(query)).sort((a, b) => b[field] - a[field] || a.name.localeCompare(b.name, 'ja'));
  const rows = users.map(user => {
    const row = node('tr');
    for (const [index, value] of [user.name, user.comments, user.entries, user.hearts, user.spoons,
      user.subscription?.plan || (user.subscription === null ? 'なし' : '未取得')].entries()) {
      const field = index === 3 ? 'hearts' : index === 4 ? 'spoons' : null;
      row.append(node('td', field && user.quantityUnknown?.[field] ? `${value}（数量不明${user.quantityUnknown[field]}件）` : value));
    }
    row.firstChild.title = user.id;
    const button = node('button', user.name, 'name-button'); button.type = 'button';
    button.addEventListener('click', () => { $('profile-user').value = user.id; renderProfile(); $('profile-card').scrollIntoView({behavior: 'smooth', block: 'center'}); });
    row.firstChild.replaceChildren(button);
    return row;
  });
  if (!rows.length) { const row = node('tr'); const cell = node('td', '参加者が見つかりません。'); cell.colSpan = 6; row.append(cell); rows.push(row); }
  $('users').replaceChildren(...rows);
}

function renderProfile() {
  const profiles = state?.profiles || [];
  const signature = JSON.stringify(profiles.map(item => [item.id, item.name]));
  if (signature !== profileSignature) {
    const previous = $('profile-user').value;
    const options = [node('option', '参加者を選択')]; options[0].value = '';
    const names = new Map(); for (const profile of profiles) names.set(profile.name, (names.get(profile.name) || 0) + 1);
    for (const profile of profiles) {
      const option = node('option', profile.name + (names.get(profile.name) > 1 ? `（…${profile.id.slice(-6)}）` : ''));
      option.value = profile.id; options.push(option);
    }
    $('profile-user').replaceChildren(...options); $('profile-user').value = profiles.some(item => item.id === previous) ? previous : '';
    profileSignature = signature;
  }
  const profile = profiles.find(item => item.id === $('profile-user').value);
  for (const field of ['spoons', 'hearts', 'comments', 'entries']) $('profile-' + field).textContent = profile ? (profile.current[field] || 0).toLocaleString('ja-JP') + (profile.quantityUnknown?.[field] ? ` ＋数量不明${profile.quantityUnknown[field]}件` : '') : '—';
  $('profile-hint').textContent = profile ? `${profile.name} さんの記録` : '一覧の名前を押すか、参加者を選択してください。チャットの /status 応答は公式APIモード専用です。';
  $('profile-total').textContent = profile ? `保存${profile.total.sessions}配信の合計：スプーン ${profile.total.spoons.toLocaleString()} ／ ハート ${profile.total.hearts.toLocaleString()} ／ コメント ${profile.total.comments.toLocaleString()} ／ 入室 ${profile.total.entries.toLocaleString()}` : '';
  $('profile-total').textContent = $('profile-total').textContent.replace(/ ／ /g, '\n');
  const counters = profile?.games?.counters || {};
  $('profile-games').textContent = profile ? `保存したゲーム成績：サイコロ ${counters.diceRolls || 0}個 ／ じゃんけん ${counters.jankenWins || 0}勝 ${counters.jankenLosses || 0}敗 ${counters.jankenDraws || 0}分 ／ 数当て ${counters.guessCleared || 0}クリア・${counters.guessPlayed || 0}回挑戦${profile.games?.guess ? `（進行中：残り${profile.games.guess.remaining}回）` : ''}` : '';
  if (profile) $('profile-games').textContent += `\nリバーシ ${counters.reversiWins || 0}勝 ${counters.reversiLosses || 0}敗 ${counters.reversiDraws || 0}分\n将棋 ${counters.shogiWins || 0}勝 ${counters.shogiLosses || 0}敗 ${counters.shogiDraws || 0}分`;
  const fortune = profile?.games?.fortune;
  $('profile-fortune').textContent = fortune ? `今日のおみくじ：${fortune.result} ／ ${fortune.color} ／ ラッキーナンバー ${fortune.number}` : '';
}
$('profile-user').addEventListener('change', renderProfile);

function renderEvents() {
  const query = $('event-search').value.toLocaleLowerCase(), type = $('event-type').value;
  const signature = JSON.stringify([state?.session?.key, state?.session?.events, query, type, eventsLimit]);
  if (signature === eventsSignature) return;
  eventsSignature = signature;
  const filtered = (state?.session?.events || []).filter(event => (!type || event.type === type) && `${event.user?.name || ''} ${event.text}`.toLocaleLowerCase().includes(query)).reverse();
  eventsMore.hidden = filtered.length <= eventsLimit;
  const rows = filtered.slice(0, eventsLimit).map(event => {
    const row = node('div', undefined, 'event');
    const date = new Date(event.time);
    row.append(node('span', Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('ja-JP')), node('span', types[event.type] || event.type),
      node('p', `${event.user?.name || (/^(automatic|bot)/.test(event.type) ? 'ボット' : '匿名')}${event.isDj ? '（DJ）' : ''}\n${event.text}`));
    return row;
  });
  $('events').replaceChildren(...(rows.length ? rows : [node('p', '該当する受信ログはありません。', 'empty')]));
}

function apply(result) {
  state = result;
  const automatic = state.automationStatus || {};
  $('automation-status').textContent = `${automatic.paused ? '一時停止中' : '有効な設定を監視中'}\n送信 ${automatic.sent || 0}件 ／ 失敗 ${automatic.failed || 0}件\n${automatic.message || '有効にした自動コメントを待っています。'}`;
  $('pause-automation').textContent = automatic.paused ? '自動コメントを再開' : '自動コメントを一時停止';
  const vote = state.session?.poll;
  $('poll-result').textContent = vote ? `${vote.open ? '投票受付中' : '投票結果'}\n${vote.question}\n${vote.options.map((item, index) => `${index + 1}. ${item.text}：${item.count}票`).join('\n')}\n合計 ${vote.total}票` : '投票はまだありません。';
  const currentLive = state.sessions.find(session => session.key === state.activeKey);
  $('connection').textContent = state.spoonStatus?.state === 'connected' ? `API接続中・${currentLive?.live.title || '配信を受信中'}`
    : state.spoonStatus?.state === 'connecting' ? 'API接続中…' : state.spoonStatus?.state === 'waiting' ? 'API接続中・配信開始待ち'
    : state.spoonStatus?.state === 'error' || state.spoonStatus?.state === 'unauthorized' ? state.spoonStatus.message : 'API未接続';
  $('connection-dot').classList.toggle('active', state.spoonStatus?.state === 'connected');
  $('connection-dot').classList.toggle('error', state.spoonStatus?.state === 'error');
  $('receive-detail').textContent = state.native?.lastEvent ? `最終イベント ${time(state.native.lastEvent)}` : state.spoonStatus?.receiving ? 'コメントの受信を待っています' : '受信開始で接続します';
  $('entry-reception').hidden = state.spoonStatus?.state !== 'connected' || Number(state.session?.totals?.entries) > 0;
  $('entry-reception-status').textContent = state.spoonStatus?.entryReceived > 0
    ? `入室通知：今回の受信開始から${state.spoonStatus.entryReceived}件受信しました。`
    : '入室通知はまだ受信していません。通常コメントだけ届く場合は、Spoonでボットをマネージャーに指定してください。';
  $('setup-guide').hidden = Boolean(state.activeKey) || state.spoonStatus?.receiving;
  $('setup-text').textContent = state.spoonStatus?.authorized ? 'ヘッダーの「受信開始」を押すとコメントを取得します。読み上げの確認は「設定 → 読み上げ」で行えます。' : 'ヘッダーの「受信開始」からSpoonにログインしてください。連携後、自動で受信を開始します。';
  $('commands-badge').textContent = state.preferences.commands.enabled ? '応答する設定' : '無効';
  for (const cell of document.querySelectorAll('[data-command-enabled]')) {
    cell.textContent = isCommandEnabled(state.preferences.commands, cell.dataset.commandEnabled) ? 'ON' : 'OFF';
  }
  $('command-status').textContent = !state.preferences.commands.enabled ? '管理設定でコマンド応答を有効にできます。'
    : `${state.commandStatus?.message || 'コマンドを待っています。'} 同じ人の応答間隔：${state.preferences.commands.cooldownSeconds}秒（将棋6秒・リバーシ3秒）。将棋盤は上下2通を3秒間隔で表示します。応答にはチャット送信の追加同意が必要です。`;
  renderSessions(); renderPreferences(); renderCounters(); renderUsers(); renderProfile(); renderEvents();
  attendance.render(state); donations.render(state);
  boardViewer.render(state);
  requestInbox.render(state);
  renderDashboard(state.analytics, key => action($('session'), () => setSession(key)));
  const feed = $('live-comments');
  if (feed) {
    const comments = (state.session?.events || []).filter(event => event.type === 'comment').slice(-20).reverse();
    feed.replaceChildren(...(comments.length ? comments.map(event => {const row = node('li'); row.append(node('strong', event.user?.name || '匿名'), node('span', event.text), node('time', new Date(event.time).toLocaleTimeString('ja-JP'))); return row;}) : [node('li', state.spoonStatus?.receiving ? '受信したコメントがここに表示されます。' : '受信開始後にコメントを表示します。', 'empty')]));
  }
  availability();
}

async function refresh() {
  selected = '';
  const result = await send('REFRESH_MANAGER');
  await settingsUI.refresh();
  $('listeners-info').textContent = `${result.listeners.length}人を ${time(result.listenersAt)} に取得。人の出入りにより、ページ取得中も一覧は変化します。`;
  apply(result); $('session').value = ''; return result;
}

function sessionKey() {
  if (!state?.session || state.session.key !== state.activeKey || state.session.endedAt) throw new Error('現在の配信情報を更新してください。');
  return state.session.key;
}

$('setup-settings').addEventListener('click', () => { showSettings('connection'); });
$('refresh').addEventListener('click', () => action($('refresh'), async () => { await refresh(); notice('配信情報と現在のリスナーを更新しました。'); }));
$('connect').addEventListener('click', () => action($('connect'), async () => {
  const result = await send(state.spoonStatus?.receiving ? 'DISCONNECT_SPOON' : 'CONNECT_SPOON');
  if (result.needsSetup) await window.desktop.openSetup();
  if (result.needsAuthorization) notice('ブラウザーでSpoonにログインし、全機能の権限に同意してください。認証が完了すると受信を開始します。認証後のアプリへの復帰・タブの自動閉鎖は起動時の設定に従います。');
  apply(await send('GET_MANAGER_STATE', managerRequest()));
}));
$('session').addEventListener('change', () => action($('session'), () => setSession($('session').value)));
$('analysis-limit').addEventListener('change', () => action($('analysis-limit'), () => setSession(selected)));
$('trend-metric').addEventListener('change', () => renderDashboard(state.analytics, key => action($('session'), () => setSession(key))));
for (const id of ['user-search', 'user-sort']) $(id).addEventListener('input', renderUsers);
for (const id of ['event-search', 'event-type']) $(id).addEventListener('input', () => {eventsLimit = 100; renderEvents();});
for (const id of ['heart-goal', 'spoon-goal', 'commands-enabled', 'commands-cooldown', 'templates', ...features.map(feature => 'feature-' + feature)]) $(id).addEventListener('input', markDirty);
$('add-template').addEventListener('click', () => {
  if ($('templates').children.length >= 8) return notice('定型文は8件までです。', true);
  $('templates').append(templateRow()); markDirty(); saveDraft();
});
function collectPreferences() {
  return {heartGoal: Number($('heart-goal').value), spoonGoal: Number($('spoon-goal').value),
    commands: {enabled: $('commands-enabled').checked, cooldownSeconds: Number($('commands-cooldown').value), enabledByName: commandSettings.collect()},
    features: Object.fromEntries(features.map(feature => [feature, $('feature-' + feature).checked])),
    templates: [...$('templates').children].map(row => ({label: row.querySelector('input').value, text: row.querySelector('textarea').value}))};
}
$('setup-reopen').addEventListener('click', () => action($('setup-reopen'), async () => {
  if (prefsDirty || settingsUI.dirty) throw new Error('先に設定を保存してください。');
  await window.desktop.openSetup();
}));
$('pause-automation').addEventListener('click', () => action($('pause-automation'), async () => {
  apply(await send('SET_AUTOMATION_PAUSED', {paused: !state.automationStatus?.paused, sessionKey: selected || undefined}));
}));
for (const [id, operation] of [['start-poll', 'start'], ['end-poll', 'end']]) $(id).addEventListener('click', () => action($(id), async () => {
  const result = await send('MANAGER_POLL', {action: operation, sessionKey: sessionKey(), question: $('poll-question').value,
    options: $('poll-options').value.split(/\r?\n/).map(text => text.trim()).filter(Boolean)});
  apply(result); notice(operation === 'start' ? '投票を開始しました。\nチャットに案内を送信しました。' : '投票を締め切り、結果を投稿しました。');
}));
$('refresh-fans').addEventListener('click', () => action($('refresh-fans'), async () => {
  const result = await send('FETCH_MANAGER_FANS', {sessionKey: sessionKey()});
  if (result.sessionKey !== state.session?.key) throw new Error('表示する配信が変わりました。もう一度取得してください。');
  $('fans').replaceChildren(...(result.fans.length ? result.fans.map(fan => node('li', `${fan.rank}位 ${fan.nickname ?? '匿名'} · ${fan.spoonCount == null ? '不明' : fan.spoonCount} スプーン`)) : [node('li', '現在のランキングは空です。')]));
  $('fans-info').textContent = `${time(Date.now())} 取得 · 今部屋にいる人の上位30名です。退出した人は含まれません。`;
}));
$('draw').addEventListener('click', () => action($('draw'), async () => {
  const result = await refresh(); const winners = drawListeners(result.listeners, Number($('draw-count').value));
  $('draw-result').textContent = winners.map((user, index) => `${index + 1}. ${user.name}`).join('\n');
  notice('抽選しました。結果はこの画面だけに表示しています。');
}));
$('template-select').addEventListener('change', () => {
  const template = state.preferences.templates[Number($('template-select').value)];
  if ($('template-select').value !== '' && template) $('chat').value = template.text;
  $('chat').dispatchEvent(new Event('input'));
});
$('chat').addEventListener('input', () => { $('chat-count').textContent = `${$('chat').value.length} / 200`; });
$('send-chat').addEventListener('click', () => action($('send-chat'), async () => {
  await send('SEND_MANAGER_CHAT', {sessionKey: sessionKey(), text: $('chat').value}); notice('ボット名でチャットを送信しました。');
}));
$('follow-dj').addEventListener('click', () => action($('follow-dj'), async () => {
  await send('FOLLOW_MANAGER_DJ', {sessionKey: sessionKey()}); notice('ボットからDJをフォローしました。固定マネージャーの指定は配信後にSpoonアプリで行ってください。');
}));
for (const [id, kind] of [['export-users', 'users'], ['export-events', 'events']]) $(id).addEventListener('click', () => action($(id), async () => {
  const session = state?.session; if (!session) throw new Error('書き出す配信がありません。');
  const rows = kind === 'users' ? [['配信ID', 'ユーザーID', '名前', '初回検出', '最終検出', 'コメント', '入室', 'ハート', 'スプーン', 'フォロー', 'ハート数量不明の通知数', 'スプーン数量不明の通知数', '取得方式', 'サブスクプラン'],
    ...session.users.map(user => [session.live.liveId, user.id, user.name, user.firstSeen, user.lastSeen, user.comments, user.entries, user.hearts, user.spoons, user.follows, user.quantityUnknown?.hearts || 0, user.quantityUnknown?.spoons || 0, session.source || 'api', user.subscription?.plan || (user.subscription === null ? 'なし' : '未取得')])]
    : [['配信ID', 'イベントID', '時刻', '種類', 'ユーザーID', '名前', '本文', '数量', 'DJ'],
      ...session.events.map(event => [session.live.liveId, event.id, event.time, types[event.type], event.user?.id, event.user?.name, event.text, event.amount, event.isDj])];
  download(`spoon-manager-${session.live.liveId}-${kind}.csv`, csv(rows)); notice('CSVを書き出しました。');
}));

$('export-analysis').addEventListener('click', () => {
  const rows = [['配信ID', 'タイトル', '受信開始（UTC）', '観測期間（分）', 'コメント', 'ハート', 'スプーン', '参加者', 'コメント/分'],
    ...state.analytics.rows.map(row => [row.key, row.title, row.date, row.minutes.toFixed(1), row.totals.comments, row.totals.hearts, row.totals.spoons, row.participants, row.commentsPerMinute?.toFixed(2) ?? ''])];
  download('spoon-manager-analysis.csv', csv(rows)); notice('表示中の分析をCSVに保存しました。');
});

// Keep unfinished settings in the background page's memory when a popup closes.
function saveDraft() {
  if (!state) return;
  const fields = Object.fromEntries([...$('v-settings-form').elements].filter(item => item.id && !item.readOnly && !['button', 'submit'].includes(item.type))
    .map(item => [item.id, item.type === 'checkbox' ? item.checked : item.value]));
  void send('SAVE_UI_DRAFT', {draft: {fields, pool: settingsUI.pool(), templates: collectPreferences().templates, view: settingView}}).catch(() => {});
}

$('discard-changes').addEventListener('click', () => action($('discard-changes'), async () => {
  if (settingsUI.busy) return;
  await send('CLEAR_UI_DRAFT');
  prefsDirty = false; prefsSignature = ''; prefsRevision++;
  settingsUI.reset(); apply(await send('GET_MANAGER_STATE', managerRequest()));
  updateSaveBar(); notice('未保存の変更を破棄しました。');
}));

async function initialize() {
  document.documentElement.dataset.surface = 'tab';
  $('command-list').replaceChildren(...COMMANDS.map(command => {
    const row = node('tr'); const usage = node('td'); usage.append(node('code', command.usage));
    const enabled = node('td'); enabled.dataset.commandEnabled = command.name;
    row.append(usage, node('td', command.description), node('td', command.audience), enabled); return row;
  }));
  try { apply(await send('GET_MANAGER_STATE')); }
  catch (error) { notice(error.message, true); }
  await settingsUI.initialize({collectPreferences, sessionKey: () => selected || undefined, preferencesRevision: () => prefsRevision,
    onDirty() { updateSaveBar(); if (settingsUI.dirty) saveDraft(); },
    onSaved(result, previousRevision) {
      if (prefsRevision === previousRevision) { prefsDirty = false; prefsSignature = ''; }
      apply(result); updateSaveBar();
      if (!prefsDirty && !settingsUI.dirty) void send('CLEAR_UI_DRAFT'); else saveDraft();
    }});
  const {draft} = await send('GET_UI_DRAFT');
  if (draft) {
    for (const [id, value] of Object.entries(draft.fields || {})) {
      const input = $(id); if (!input || !$('v-settings-form').contains(input)) continue;
      if (input.type === 'checkbox') input.checked = value === true; else input.value = value;
    }
    if (Array.isArray(draft.templates)) $('templates').replaceChildren(...draft.templates.map(templateRow));
    settingsUI.restoreDraft(draft.pool); markDirty();
    showSettings(draft.view === 'automation' && !document.querySelector('[data-settings-panel=automation]') ? 'goals' : draft.view);
  }
  poll(async () => {
    if (busy || settingsUI.busy) return;
    const [result] = await Promise.all([send('GET_MANAGER_STATE', managerRequest()), settingsUI.refresh()]);
    apply(result);
  });
}
initialize();
