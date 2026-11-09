const $ = id => document.getElementById(id), kind = location.pathname.split('/').at(-1);
const path = location.pathname.slice(0, location.pathname.lastIndexOf('/') + 1);
const key = 'spoon-participant:' + path;
let client = localStorage.getItem(key);
if (!/^[a-f0-9]{32}$/.test(client || '')) {client = [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join(''); localStorage.setItem(key, client);}
let state, selected = null, drop = null, game, busy = false, lastResult = '', pending = '';
const pieces = ['', '歩', '香', '桂', '銀', '金', '角', '飛', '玉', 'と', '杏', '圭', '全', '', '馬', '龍'];
async function api(route, input) {
  const response = await fetch(path + route, {method: input === undefined ? 'GET' : 'POST', headers: {'X-Participant': client, ...(input === undefined ? {} : {'Content-Type': 'application/json'})}, body: input === undefined ? undefined : JSON.stringify(input)});
  if (!response.ok) throw Error(({401:'Spoonチャットで確認コードを送信してください。',409:'現在、質問の受付を停止しています。',429:'少し待ってから操作してください。'})[response.status] || '接続できませんでした。配信や公開が終了していないか確認してください。');
  return response.json();
}
async function action(input) {
  if (busy) return; busy = true;
  try { const result = await api('action', {kind, ...input}); pending = result.id; $('status').textContent = '操作を確認しています…'; }
  catch (error) {$('status').textContent = error.message;} finally {busy = false;}
}
function renderGame() {
  game = state.games?.filter(item => item.kind === kind).at(-1);
  $('end').disabled = !game || Boolean(game.outcome) || game.waiting;
  $('start').disabled = Boolean(game && !game.outcome);
  $('promotion').hidden = kind !== 'shogi';
  if (!game) {$('game-status').textContent = '対戦相手を選んで開始してください。'; $('board').replaceChildren(); return;}
  if (game.waiting) {$('game-status').textContent = '対戦相手の参加を待っています。'; return;}
  const side = game.userIds.indexOf(state.user.id) === 1 ? -1 : 1;
  const myTurn = game.turn === side && !game.outcome;
  $('game-status').textContent = `${game.names?.join(' vs ') || 'ボット対戦'}\n${game.outcome ? game.outcome === 'draw' ? '引き分け' : (game.outcome === 'win' ? 1 : -1) === side ? 'あなたの勝ち' : 'あなたの負け' : myTurn ? 'あなたの番です' : '相手の番です'} · ${game.ply}手`;
  const width = kind === 'shogi' ? 9 : 8, board = $('board'); board.style.setProperty('--width', width);
  const cells = [], axis = text => {const node = document.createElement('span'); node.className = 'axis'; node.textContent = text; return node;};
  cells.push(axis(''), ...Array.from({length: width}, (_, i) => axis(kind === 'shogi' ? 9 - i : i + 1)));
  const legal = game.legal || [];
  game.board.forEach((piece, index) => {
    if (index % width === 0) cells.push(axis('一二三四五六七八九'[Math.floor(index / width)]));
    const square = index + 1, node = document.createElement('button'); node.textContent = kind === 'reversi' ? piece === 1 ? '●' : piece === -1 ? '○' : '' : pieces[Math.abs(piece)];
    node.classList.toggle('negative', piece < 0); node.classList.toggle('selected', selected === square);
    const moves = kind === 'reversi' ? legal : legal.filter(move => move.to === square && (drop ? move.drop === drop : move.from === selected));
    node.classList.toggle('possible', kind === 'reversi' ? legal.includes(square) : moves.length > 0); node.disabled = !myTurn || Boolean(pending);
    node.onclick = () => {
      if (kind === 'reversi') {if (legal.includes(square)) void action({action:'move', move:square}); return;}
      if (piece * side > 0) {selected = square; drop = null; renderGame(); return;}
      const move = moves.find(item => Boolean(item.promote) === $('promote').checked) || moves[0];
      if (move) {selected = drop = null; void action({action:'move', move});}
    };
    cells.push(node);
  }); board.replaceChildren(...cells);
  $('hands').replaceChildren();
  if (kind === 'shogi') (game.hands?.[side === 1 ? 0 : 1] || []).forEach((count, i) => {if (!count) return; const button = document.createElement('button'); button.textContent = `${pieces[i + 1]}×${count}`; button.disabled = !myTurn; button.onclick = () => {drop = i + 1; selected = null; renderGame();}; $('hands').append(button);});
}
async function refresh() {
  try {
    state = await api('state'); $('title').textContent = state.title; $('identify').hidden = Boolean(state.user);
    $('question').hidden = kind !== 'question' || !state.user; $('game').hidden = kind === 'question' || !state.user;
    if (state.result && state.result.id !== lastResult) {lastResult = state.result.id; pending = ''; $('status').textContent = state.result.message; if (state.result.ok && kind === 'question') $('text').value = '';}
    if (kind === 'question') {$('question').querySelector('button').disabled = !state.requestsOpen || Boolean(pending);}
    else if (state.user) renderGame();
  } catch (error) {$('status').textContent = error.message;}
}
const joined = await api('join', {}); $('code').textContent = '/参加 ' + joined.code;
$('copy').onclick = async () => {try {await navigator.clipboard.writeText($('code').textContent); $('status').textContent = 'コピーしました。Spoonチャットに貼り付けて送信してください。';} catch {$('status').textContent = '確認コードを選択してコピーしてください。';}};
$('question').querySelector('form').onsubmit = event => {event.preventDefault(); void action({action:'question', requestKind:$('request-kind').value, text:$('text').value});};
$('start').onclick = () => action({action:'start', mode:$('mode').value}); $('end').onclick = () => action({action:'end'});
await refresh(); setInterval(refresh, 1200);
