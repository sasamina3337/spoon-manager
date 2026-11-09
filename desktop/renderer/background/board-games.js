import {newReversi, reversiMoves, moveReversi, reversiBot, newShogi, shogiMoves, moveShogi, shogiBot, shogiCheck, SHOGI_PIECES} from './board-rules.js';
import {BOARD_RANKS, boardFiles, boardCoordinate, parseBoardCoordinate, boardMoveText} from '../shared/board-coordinates.js';

export const BOARD_KINDS = ['reversi', 'shogi'];
export const BOARD_TITLES = {reversi: 'リバーシ', shogi: '将棋'};
export const BOARD_HELP = {
  reversi: 'リバーシ（●あなた・○ボット・□空き）\n/reversi start 開始\n/reversi 3四 着手\n/reversi 盤面・候補\n/reversi end 投了\n横1〜8は左から右、縦一〜八は上から下。置けない時は自動パス。',
  shogi: '将棋（▲あなた・▽ボット・□空き）\n/shogi start 開始\n/shogi 7七 7六 移動元→先\n/shogi 2二 3一 成 成り\n/shogi drop 歩 5五 持駒を打つ\n/shogi moves 7七 候補\n/shogi pieces 駒表\n/shogi 盤面 /shogi end 投了\n横9〜1は左から右、縦一〜九は上から下。盤面は上下2通。',
  pieces: '将棋の駒\n▲あなた・▽ボット・□空き\n歩 香 桂 銀 金 角 飛 玉\n成駒: と（成歩）杏（成香）圭（成桂）全（成銀）馬（成角）龍（成飛）\n/shogi drop 歩 5五 で持駒を打つ\n持駒番号も可: 1歩 2香 3桂 4銀 5金 6角 7飛'
};
const outcomeText = {win: 'あなたの勝ち', loss: 'ボットの勝ち', draw: '引き分け'};
const held = (game, side) => game.hands[side].map((count, index) => count ? `${SHOGI_PIECES[index + 1]}${count}` : '').filter(Boolean).join('') || 'なし';
const summaries = new WeakMap();

export function boardSummary(kind, game) {
  if (!game) return null;
  const cached = summaries.get(game);
  const last = boardMoveText(kind, game.last);
  if (cached?.ply === game.ply && cached.outcome === game.outcome && cached.last === last) return structuredClone(cached);
  const summary = {board: [...game.board], turn: game.turn, outcome: game.outcome, ply: game.ply, last,
    ...(kind === 'shogi' ? {hands: game.hands.map(hand => [...hand]), check: shogiCheck(game), legal: shogiMoves(game)}
      : {legal: game.outcome ? [] : reversiMoves(game), black: game.board.filter(value => value === 1).length, white: game.board.filter(value => value === -1).length})};
  summaries.set(game, summary); return structuredClone(summary);
}

export function boardMessages(kind, game, name) {
  const files = boardFiles(kind), width = files.length;
  const axis = (kind === 'shogi' ? '　' : '') + files.map(file => String.fromCharCode(0xff10 + file)).join(kind === 'shogi' ? '　' : '');
  const symbols = kind === 'shogi' ? game.board.map(value => value ? `${value > 0 ? '▲' : '▽'}${SHOGI_PIECES[Math.abs(value)]}` : '　□')
    : game.board.map(value => value === 1 ? '●' : value === -1 ? '○' : '□');
  const rows = Array.from({length: width}, (_, row) => `${symbols.slice(row * width, (row + 1) * width).join('')}　${BOARD_RANKS[row]}`);
  const state = outcomeText[game.outcome] || (kind === 'shogi' && shogiCheck(game) ? 'あなたの番・王手' : 'あなたの番');
  const label = [...name.replace(/[｜。：\r\n]/g, ' ')].slice(0, 4).join('');
  const last = boardMoveText(kind, game.last);
  const withLast = body => body + (last && body.length < 198 ? '\n' + last.slice(0, 199 - body.length) : '');
  if (kind === 'shogi') return [
    `将棋 ${label} 上段\n▲あなた ▽ボット □空き\n${axis}\n${rows.slice(0, 5).join('\n')}\n${axis}`,
    withLast(`将棋 ${label} 下段 ${state}\n${axis}\n${rows.slice(5).join('\n')}\n${axis}\n持駒 ▲${held(game, 0)} ▽${held(game, 1)}`)
  ];
  const candidates = game.outcome ? [] : reversiMoves(game, 1);
  return [withLast(`リバーシ ${label} ${state}\n${axis}\n${rows.join('\n')}\n${axis}\n●${game.board.filter(value => value === 1).length} ○${game.board.filter(value => value === -1).length} □空き\n候補 ${candidates.slice(0, 8).map(square => boardCoordinate(kind, square)).join(' ') || 'なし'}${candidates.length > 8 ? '…' : ''}`)];
}

export function executeBoard(profile, kind, args, key, random) {
  const active = profile[kind]?.key === key ? profile[kind] : null;
  if (args.length === 1 && args[0] === 'help') return BOARD_HELP[kind];
  if (kind === 'shogi' && args.length === 1 && args[0] === 'pieces') return BOARD_HELP.pieces;
  if (args.length === 1 && args[0] === 'start') {
    if (active && !active.outcome) return `対局中です。/${kind} で盤面、/${kind} end で投了できます。`;
    profile[kind] = {...(kind === 'shogi' ? newShogi() : newReversi()), key};
    profile.counters[kind + 'Played']++;
    return boardMessages(kind, profile[kind], profile.name);
  }
  if (!active) return BOARD_HELP[kind];
  if (!args.length) return boardMessages(kind, active, profile.name);
  if (active.outcome) return `対局終了（${outcomeText[active.outcome]}）。\n/${kind} start で再戦できます。`;
  if (args.length === 1 && args[0] === 'end') {
    active.outcome = 'loss'; active.last = 'あなたが投了'; profile.counters[kind + 'Losses']++;
    return `${BOARD_TITLES[kind]}：投了しました。\n/${kind} start で再戦できます。`;
  }
  if (kind === 'shogi' && args[0] === 'moves') {
    const from = parseBoardCoordinate(kind, args[1]);
    if (args.length !== 2 || !from) return '使い方：/shogi moves 7七（移動元の座標）';
    const moves = shogiMoves(active).filter(move => move.from === from);
    return `${boardCoordinate(kind, from)}からの候補\n${moves.map(move => `${boardCoordinate(kind, move.to)}${move.promote ? '成' : ''}`).join(' ') || 'なし'}\n/shogi 移動元 移動先 [成]`;
  }
  let requested;
  if (kind === 'reversi') {
    requested = parseBoardCoordinate(kind, args[0]);
    if (args.length !== 1 || !requested) return BOARD_HELP.reversi;
  } else if (['drop', '打'].includes(args[0])) {
    const piece = /^[1-7]$/.test(args[1] || '') ? Number(args[1]) : SHOGI_PIECES.slice(1, 8).indexOf(args[1]) + 1;
    const to = parseBoardCoordinate(kind, args[2]);
    if (args.length !== 3 || !piece || !to) return '使い方：/shogi drop 歩 5五（駒の漢字と座標。持駒番号1〜7も可）';
    requested = {drop: piece, to};
  } else {
    const from = parseBoardCoordinate(kind, args[0]), to = parseBoardCoordinate(kind, args[1]);
    if (args.length < 2 || args.length > 3 || !from || !to || (args[2] && !['成', '+', '不成', '-'].includes(args[2]))) return BOARD_HELP.shogi;
    requested = {from, to, ...(args[2] ? {promote: ['成', '+'].includes(args[2])} : {})};
  }
  try {
    const move = kind === 'shogi' ? moveShogi : moveReversi, bot = kind === 'shogi' ? shogiBot : reversiBot;
    move(active, requested);
    const playerMove = active.last, replies = [];
    while (!active.outcome && active.turn === -1) {move(active, bot(active, random)); replies.push(active.last);}
    active.last = replies.length ? `${playerMove} / ${replies.at(-1)}` : playerMove;
    if (active.outcome) profile.counters[kind + ({win: 'Wins', loss: 'Losses', draw: 'Draws'}[active.outcome])]++;
    return boardMessages(kind, active, profile.name);
  } catch (error) {return `${error.message}\n/${kind} で盤面を確認できます。`;}
}
