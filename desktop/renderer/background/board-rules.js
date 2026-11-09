import {boardCoordinate} from '../shared/board-coordinates.js';

// Internal squares remain row-major so existing saved games keep their position.
// These pure rules are shared by chat commands and the numbered board viewer.
const directions = [-1, 0, 1].flatMap(row => [-1, 0, 1].map(col => [row, col])).filter(([r, c]) => r || c);
const inside = (row, col, size) => row >= 0 && row < size && col >= 0 && col < size;

export function newReversi() {
  const board = Array(64).fill(0);
  board[27] = board[36] = -1; board[28] = board[35] = 1;
  return {board, turn: 1, outcome: '', ply: 0, last: ''};
}

export function reversiFlips(board, square, side) {
  if (!Number.isInteger(square) || square < 1 || square > 64 || board[square - 1]) return [];
  const row = Math.floor((square - 1) / 8), col = (square - 1) % 8, flips = [];
  for (const [dr, dc] of directions) {
    let r = row + dr, c = col + dc;
    const line = [];
    while (inside(r, c, 8) && board[r * 8 + c] === -side) {line.push(r * 8 + c); r += dr; c += dc;}
    if (line.length && inside(r, c, 8) && board[r * 8 + c] === side) flips.push(...line);
  }
  return flips;
}

export function reversiMoves(game, side = game.turn) {
  return game.board.flatMap((_, index) => reversiFlips(game.board, index + 1, side).length ? [index + 1] : []);
}

export function moveReversi(game, square) {
  if (game.outcome) throw new Error('対局は終了しています。');
  const flips = reversiFlips(game.board, square, game.turn);
  if (!flips.length) throw new Error('そのマスには置けません。候補の座標を選んでください。');
  const side = game.turn;
  game.board[square - 1] = side;
  for (const index of flips) game.board[index] = side;
  game.ply++; game.last = `${side === 1 ? 'あなた' : 'ボット'} ${boardCoordinate('reversi', square)}`;
  game.turn = -side;
  if (!reversiMoves(game).length) {
    game.turn = side;
    if (!reversiMoves(game).length) {
      const score = game.board.reduce((sum, value) => sum + value, 0);
      game.outcome = score > 0 ? 'win' : score < 0 ? 'loss' : 'draw';
    } else game.last += `（${side === 1 ? 'ボット' : 'あなた'}はパス）`;
  }
}

export function reversiBot(game, random) {
  const moves = reversiMoves(game);
  const score = square => {
    const copy = structuredClone(game); moveReversi(copy, square);
    const r = Math.floor((square - 1) / 8), c = (square - 1) % 8;
    const corner = [1, 8, 57, 64].includes(square);
    const nearCorner = [0, 7].some(row => [0, 7].some(col => Math.abs(r - row) <= 1 && Math.abs(c - col) <= 1 && !game.board[row * 8 + col]));
    return (corner ? 1000 : nearCorner ? -100 : 0) - reversiMoves(copy, -game.turn).length * 3 + reversiFlips(game.board, square, game.turn).length;
  };
  const scores = moves.map(score), best = Math.max(...scores), choices = moves.filter((_, index) => scores[index] === best);
  return choices[random(choices.length)];
}

// Positive pieces belong to the player (moving up), negative pieces to the bot.
// P,L,N,S,G,B,R,K = 1..8; promoted P,L,N,S,B,R = 9,10,11,12,14,15.
export const SHOGI_PIECES = ['', '歩', '香', '桂', '銀', '金', '角', '飛', '玉', 'と', '杏', '圭', '全', '', '馬', '龍'];
const values = [0, 100, 300, 320, 450, 550, 800, 1000, 20000, 570, 560, 560, 560, 0, 1100, 1300];
const base = piece => Math.abs(piece) > 8 ? Math.abs(piece) - 8 : Math.abs(piece);
const handIndex = side => side === 1 ? 0 : 1;
const zone = (row, side) => side === 1 ? row < 3 : row > 5;
const dead = (piece, row, side) => [1, 2].includes(piece) ? row === (side === 1 ? 0 : 8) : piece === 3 && (side === 1 ? row < 2 : row > 6);

export function newShogi() {
  const board = Array(81).fill(0), back = [2, 3, 4, 5, 8, 5, 4, 3, 2];
  for (let c = 0; c < 9; c++) {board[c] = -back[c]; board[18 + c] = -1; board[54 + c] = 1; board[72 + c] = back[c];}
  board[10] = -7; board[16] = -6; board[64] = 6; board[70] = 7;
  const game = {board, hands: [Array(7).fill(0), Array(7).fill(0)], turn: 1, outcome: '', ply: 0, last: '', history: []};
  game.history.push({key: shogiPosition(game), mover: 0, check: false});
  return game;
}

function vectors(piece) {
  const gold = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, 0]];
  const bishop = [[-1, -1, true], [-1, 1, true], [1, -1, true], [1, 1, true]];
  const rook = [[-1, 0, true], [1, 0, true], [0, -1, true], [0, 1, true]];
  if (piece === 1) return [[-1, 0]];
  if (piece === 2) return [[-1, 0, true]];
  if (piece === 3) return [[-2, -1], [-2, 1]];
  if (piece === 4) return [[-1, -1], [-1, 0], [-1, 1], [1, -1], [1, 1]];
  if ([5, 9, 10, 11, 12].includes(piece)) return gold;
  if (piece === 6) return bishop;
  if (piece === 7) return rook;
  if (piece === 8) return directions;
  if (piece === 14) return [...bishop, [-1, 0], [1, 0], [0, -1], [0, 1]];
  if (piece === 15) return [...rook, [-1, -1], [-1, 1], [1, -1], [1, 1]];
  return [];
}

function targets(board, from) {
  const own = board[from], side = Math.sign(own), result = [];
  for (const [dr, dc, ray] of vectors(Math.abs(own))) {
    let r = Math.floor(from / 9) + dr * side, c = from % 9 + dc * side;
    while (inside(r, c, 9)) {
      const index = r * 9 + c, target = board[index];
      if (Math.sign(target) === side) break;
      result.push(index);
      if (target || !ray) break;
      r += dr * side; c += dc * side;
    }
  }
  return result;
}

export function shogiCheck(game, side = game.turn) {
  const king = game.board.indexOf(side * 8);
  if (king < 0) return true;
  return game.board.some((piece, from) => Math.sign(piece) === -side && targets(game.board, from).includes(king));
}

function applyShogi(game, move) {
  const copy = {board: [...game.board], hands: game.hands.map(hand => [...hand]), turn: -game.turn};
  const hand = copy.hands[handIndex(game.turn)], to = move.to - 1;
  if (move.drop) {hand[move.drop - 1]--; copy.board[to] = game.turn * move.drop;}
  else {
    const from = move.from - 1;
    if (copy.board[to]) hand[base(copy.board[to]) - 1]++;
    copy.board[to] = copy.board[from] + (move.promote ? game.turn * 8 : 0); copy.board[from] = 0;
  }
  return copy;
}

function* pseudoShogi(game) {
  const side = game.turn;
  for (let from = 0; from < 81; from++) {
    if (Math.sign(game.board[from]) !== side) continue;
    const piece = Math.abs(game.board[from]), row = Math.floor(from / 9);
    for (const to of targets(game.board, from)) {
      if (Math.abs(game.board[to]) === 8) continue; // Win by mate, never by taking a king.
      const targetRow = Math.floor(to / 9), canPromote = [1, 2, 3, 4, 6, 7].includes(piece) && (zone(row, side) || zone(targetRow, side));
      if (!dead(piece, targetRow, side)) yield {from: from + 1, to: to + 1, promote: false};
      if (canPromote) yield {from: from + 1, to: to + 1, promote: true};
    }
  }
  const hand = game.hands[handIndex(side)];
  for (let piece = 1; piece <= 7; piece++) {
    if (!hand[piece - 1]) continue;
    for (let to = 0; to < 81; to++) {
      if (game.board[to] || dead(piece, Math.floor(to / 9), side)) continue;
      if (piece === 1 && game.board.some((value, index) => index % 9 === to % 9 && value === side)) continue;
      yield {drop: piece, to: to + 1};
    }
  }
}

function legalShogi(game, move, pawnMate) {
  const copy = applyShogi(game, move);
  if (shogiCheck(copy, game.turn)) return false;
  // A dropped pawn checks the adjacent king. A legal evasion cannot itself be
  // a pawn drop, so the reply search does not need recursive pawn-mate checks.
  if (pawnMate && move.drop === 1 && shogiCheck(copy) && !hasShogiMove(copy, false)) return false;
  return true;
}

function hasShogiMove(game, pawnMate = true) {
  for (const move of pseudoShogi(game)) if (legalShogi(game, move, pawnMate)) return true;
  return false;
}

export function shogiMoves(game) {
  if (game.outcome) return [];
  return [...pseudoShogi(game)].filter(move => legalShogi(game, move, true));
}

export function shogiPosition(game) {return `${game.board.join(',')}/${game.hands.map(hand => hand.join(',')).join('/')}/${game.turn}`;}

export function moveShogi(game, requested) {
  if (game.outcome) throw new Error('対局は終了しています。');
  const candidates = shogiMoves(game).filter(move => move.to === requested.to && (requested.drop ? move.drop === requested.drop : !move.drop && move.from === requested.from));
  const move = requested.promote === undefined ? candidates.find(item => !item.promote) || candidates[0] : candidates.find(item => Boolean(item.promote) === requested.promote);
  if (!move) throw new Error('その手は指せません。王手・二歩・駒の動きを確認してください。');
  const pieceName = SHOGI_PIECES[move.drop || Math.abs(game.board[move.from - 1])];
  const side = game.turn, copy = applyShogi(game, move);
  Object.assign(game, copy); game.ply++;
  game.last = `${side === 1 ? 'あなた' : 'ボット'} ${move.drop ? '' : boardCoordinate('shogi', move.from) + '→'}${boardCoordinate('shogi', move.to)}${pieceName}${move.drop ? '打' : move.promote ? '成' : ''}`;
  game.history.push({key: shogiPosition(game), mover: side, check: shogiCheck(game)});
  if (!hasShogiMove(game)) game.outcome = side === 1 ? 'win' : 'loss';
  else {
    const same = game.history.map((item, index) => item.key === game.history.at(-1).key ? index : -1).filter(index => index >= 0);
    if (same.length >= 4) {
      const sequence = game.history.slice(same.at(-4) + 1);
      const checking = [1, -1].find(player => sequence.some(item => item.mover === player) && sequence.filter(item => item.mover === player).every(item => item.check));
      game.outcome = checking === 1 ? 'loss' : checking === -1 ? 'win' : 'draw';
      game.last += checking ? '（連続王手の千日手）' : '（千日手）';
    } else if (game.ply >= 512) {game.outcome = 'draw'; game.last += '（512手の上限）';}
  }
  return move;
}

export function shogiBot(game, random) {
  const moves = shogiMoves(game);
  const scores = moves.map(move => {
    const copy = applyShogi(game, move), piece = move.drop || Math.abs(game.board[move.from - 1]);
    const enemy = {...copy, turn: -game.turn};
    const attacked = enemy.board.some((value, from) => Math.sign(value) === enemy.turn && targets(enemy.board, from).includes(move.to - 1));
    return values[Math.abs(game.board[move.to - 1])] * 1.5 + (move.promote ? values[piece + 8] - values[piece] : 0)
      - (attacked ? values[piece] : 0) + (shogiCheck(copy) ? 35 : 0) - Math.abs((move.to - 1) % 9 - 4) * 2;
  });
  const best = Math.max(...scores), choices = moves.filter((_, index) => scores[index] === best);
  return choices[random(choices.length)];
}

export function restoreBoardGame(kind, saved, {allowOpponentTurn = false} = {}) {
  const size = kind === 'shogi' ? 81 : 64;
  if (!saved || typeof saved.key !== 'string' || !Array.isArray(saved.board) || saved.board.length !== size ||
    ![1, -1].includes(saved.turn) || !['', 'win', 'loss', 'draw'].includes(saved.outcome) ||
    !Number.isInteger(saved.ply) || saved.ply < 0 || saved.ply > (kind === 'shogi' ? 512 : 60) || (!allowOpponentTurn && !saved.outcome && saved.turn !== 1)) return null;
  const pieces = kind === 'shogi' ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15] : [0, 1];
  if (!saved.board.every(value => Number.isInteger(value) && pieces.includes(Math.abs(value)))) return null;
  if (kind === 'shogi') {
    if (saved.board.filter(value => value === 8).length !== 1 || saved.board.filter(value => value === -8).length !== 1 ||
      !Array.isArray(saved.hands) || saved.hands.length !== 2 || !saved.hands.every(hand => Array.isArray(hand) && hand.length === 7 && hand.every(count => Number.isInteger(count) && count >= 0 && count <= 18))) return null;
    const limits = [18, 4, 4, 4, 4, 2, 2];
    if (limits.some((limit, index) => saved.hands[0][index] + saved.hands[1][index] + saved.board.filter(piece => base(piece) === index + 1).length > limit)) return null;
    if (!Array.isArray(saved.history) || saved.history.length !== saved.ply + 1 || saved.history.some(item => typeof item?.key !== 'string' || item.key.length > 400 || ![0, 1, -1].includes(item.mover) || typeof item.check !== 'boolean') || saved.history.at(-1).key !== shogiPosition(saved)) return null;
  }
  return structuredClone({...saved, last: String(saved.last || '').slice(0, 100)});
}
