import {node, notice} from '../shared/ui.js';
import {BOARD_TITLES, BOARD_HELP, boardSummary} from '../background/board-games.js';
import {newReversi, newShogi, SHOGI_PIECES} from '../background/board-rules.js';
import {BOARD_RANKS, boardFiles, boardCoordinate} from '../shared/board-coordinates.js';

export function createBoardViewer(container) {
  const card = node('section', undefined, 'card board-card'); card.id = 'board-games';
  card.innerHTML = `<h2>将棋・リバーシ</h2>
    <p class="hint">ブラウザーで遊ぶURLは「配信ツール → 質問・参加URL」で発行します。<a href="#tools/requests">リスナー用URLを開く</a>。この盤面はチャット対局の確認用です。チャットでは「7七」「3四」のような縦横の座標を使います。</p>
    <div class="board-selectors"><label>ゲーム <select id="board-kind"><option value="reversi">リバーシ</option><option value="shogi">将棋</option></select></label>
    <label>対局 <select id="board-player" aria-label="表示する対局"></select></label></div>
    <p id="board-status" class="hint" aria-live="polite"></p>
    <div id="numbered-board" class="numbered-board" role="group" aria-label="座標付き盤面"></div>
    <div id="board-hands" class="board-hands"></div>
    <p id="board-last" class="hint"></p>
    <label class="board-promote"><input id="board-promote" type="checkbox">成る</label>
    <div class="board-command"><label>チャットに入力するコマンド <input id="board-command" readonly></label><button id="copy-board-command" type="button">コピー</button></div>
    <div class="board-actions"><button id="board-start" type="button">開始コマンド</button><button id="board-show" type="button">盤面コマンド</button><button id="board-resign" type="button">投了コマンド</button></div>
    <details><summary>操作方法・ルール</summary><p id="board-instructions"></p><p id="board-pieces"></p>
    <p class="hint">横の数字と縦の漢数字でマスを指定します。将棋の横は左から9〜1、リバーシは左から1〜8です。縦は上から一、二、三…です。□は空きマス。チャットの▲はあなた、▽はボットの駒です。将棋盤は上下2通で表示します。簡易ボット対戦で持ち時間はなく、将棋は512手で引き分け。持将棋の宣言には対応していません。</p></details>`;
  container.append(card);
  const find = id => card.querySelector('#' + id);
  let boards = [], game, kind = 'reversi', selected = '', source = null, destination = null, drop = null, signature = '';
  const command = text => {find('board-command').value = text;};
  const showSelection = () => {
    for (const cell of find('numbered-board').querySelectorAll('.board-square')) {
      const square = Number(cell.dataset.square);
      const moves = kind === 'shogi' ? game.legal.filter(move => drop ? move.drop === drop : move.from === source) : [];
      cell.classList.toggle('selected', square === source);
      cell.classList.toggle('possible', kind === 'reversi' ? game.legal.includes(square) : moves.some(move => move.to === square));
      cell.setAttribute('aria-pressed', String(square === source));
    }
  };
  const selectSquare = square => {
    if (!selected || game.outcome) return;
    if (kind === 'reversi') {
      if (game.legal.includes(square)) command(`/reversi ${boardCoordinate(kind, square)}`);
      return;
    }
    if (game.board[square - 1] > 0) {
      source = square; destination = drop = null; command(`/shogi moves ${boardCoordinate(kind, square)}`); showSelection(); return;
    }
    const moves = game.legal.filter(move => move.to === square && (drop ? move.drop === drop : !move.drop && move.from === source));
    if (!moves.length) return;
    destination = square;
    const promote = find('board-promote').checked;
    const move = moves.find(item => Boolean(item.promote) === promote) || moves[0];
    command(drop ? `/shogi drop ${SHOGI_PIECES[drop]} ${boardCoordinate(kind, square)}` : `/shogi ${boardCoordinate(kind, source)} ${boardCoordinate(kind, square)}${move.promote ? ' 成' : ''}`);
  };
  function renderBoard() {
    kind = find('board-kind').value;
    selected = find('board-player').value;
    const saved = boards.find(item => item.kind === kind && item.id === selected);
    game = saved || boardSummary(kind, kind === 'shogi' ? newShogi() : newReversi());
    const next = JSON.stringify([kind, selected, game]);
    if (signature === next) return;
    signature = next; source = destination = drop = null;
    find('board-promote').checked = false;
    find('board-promote').closest('label').hidden = kind !== 'shogi';
    find('board-status').textContent = !saved ? '対局はまだありません。Spoonのチャットに開始コマンドを入力してください。'
      : `${saved.name}さん vs ボット\n${({win: 'あなたの勝ち', loss: 'ボットの勝ち', draw: '引き分け'})[game.outcome] || `あなたの番${game.check ? '（王手）' : ''}`} · ${game.ply}手${kind === 'reversi' ? ` · 黒${game.black} / 白${game.white}` : ''}`;
    find('board-last').textContent = game.last || '';
    find('board-instructions').textContent = BOARD_HELP[kind];
    find('board-pieces').textContent = kind === 'shogi' ? BOARD_HELP.pieces : '● 黒=あなた　○ 白=ボット。置けるマスを色で示します。置けない場合は自動パス、両者置けなければ終了します。';
    find('numbered-board').dataset.kind = kind;
    find('numbered-board').setAttribute('aria-label', `${BOARD_TITLES[kind]} 座標付き盤面`);
    const files = boardFiles(kind), width = files.length;
    const axis = text => {const label = node('span', text, 'board-axis'); label.setAttribute('aria-hidden', 'true'); return label;};
    const cells = [axis(''), ...files.map(file => axis(file)), axis('')];
    game.board.forEach((piece, index) => {
      const row = Math.floor(index / width);
      if (index % width === 0) cells.push(axis(BOARD_RANKS[row]));
      const button = node('button', undefined, 'board-square'); button.type = 'button'; button.dataset.square = index + 1;
      const coordinate = boardCoordinate(kind, index + 1); button.dataset.coordinate = coordinate; button.title = coordinate;
      button.classList.toggle('opponent', piece < 0);
      const label = kind === 'shogi' ? SHOGI_PIECES[Math.abs(piece)] || '' : piece === 1 ? '黒' : piece === -1 ? '白' : '';
      button.setAttribute('aria-label', `${coordinate} ${label || '空き'}${piece ? piece > 0 ? ' あなた' : ' ボット' : ''}`);
      button.disabled = !saved || Boolean(game.outcome);
      button.append(node('span', label || '□', !piece ? 'square-empty' : kind === 'shogi' ? 'square-piece' : `square-disc ${piece === 1 ? 'black' : 'white'}`));
      button.addEventListener('click', () => selectSquare(index + 1)); cells.push(button);
      if (index % width === width - 1) cells.push(axis(BOARD_RANKS[row]));
    });
    cells.push(axis(''), ...files.map(file => axis(file)), axis(''));
    find('numbered-board').replaceChildren(...cells);
    const hands = [];
    if (kind === 'shogi') for (const [side, hand] of game.hands.entries()) {
      const row = node('div', undefined, 'hand-row'); row.append(node('span', side ? 'ボットの持駒 ' : 'あなたの持駒 '));
      hand.forEach((count, index) => {
        if (!count) return;
        const button = node('button', `${SHOGI_PIECES[index + 1]}×${count}`); button.type = 'button';
        button.disabled = Boolean(side) || !saved || Boolean(game.outcome);
        button.addEventListener('click', () => {drop = index + 1; source = destination = null; command(`/shogi drop ${SHOGI_PIECES[drop]} 座標`); showSelection();}); row.append(button);
      });
      if (!hand.some(Boolean)) row.append(node('span', 'なし'));
      hands.push(row);
    }
    find('board-hands').replaceChildren(...hands);
    command(`/${kind}${!saved || game.outcome ? ' start' : ''}`); showSelection();
  }
  function render(state) {
    boards = state.boards || [];
    const previous = find('board-player').value;
    const games = boards.filter(item => item.kind === find('board-kind').value);
    const optionsSignature = JSON.stringify(games.map(item => [item.id, item.name, item.outcome]));
    if (find('board-player').dataset.options !== optionsSignature) {
      find('board-player').dataset.options = optionsSignature;
      const options = games.map(item => {const option = node('option', `${item.name}${item.outcome ? '（終了）' : ''} …${item.id.slice(-6)}`); option.value = item.id; return option;});
      if (!options.length) {const option = node('option', '開始前の盤面'); option.value = ''; options.push(option);}
      find('board-player').replaceChildren(...options);
      if (games.some(item => item.id === previous)) find('board-player').value = previous;
    }
    renderBoard();
  }
  find('board-kind').addEventListener('change', () => render({boards}));
  find('board-player').addEventListener('change', renderBoard);
  find('board-promote').addEventListener('change', () => {if (destination) selectSquare(destination);});
  for (const [id, suffix] of [['board-start', ' start'], ['board-show', ''], ['board-resign', ' end']]) find(id).addEventListener('click', () => command(`/${kind}${suffix}`));
  find('copy-board-command').addEventListener('click', async () => {
    try {await navigator.clipboard.writeText(find('board-command').value); notice('コピーしました。自分のSpoonチャットに貼り付けて送信してください。');}
    catch {find('board-command').select(); notice('コマンドを選択しました。Ctrl+Cでコピーしてください。');}
  });
  return {render};
}
