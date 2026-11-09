export const BOARD_RANKS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
export const boardWidth = kind => kind === 'shogi' ? 9 : 8;

export function boardFiles(kind) {
  const width = boardWidth(kind);
  return Array.from({length: width}, (_, col) => kind === 'shogi' ? width - col : col + 1);
}

export function boardCoordinate(kind, square) {
  const width = boardWidth(kind);
  if (!Number.isInteger(square) || square < 1 || square > width * width) return '';
  const row = Math.floor((square - 1) / width), col = (square - 1) % width;
  return `${kind === 'shogi' ? width - col : col + 1}${BOARD_RANKS[row]}`;
}

export function parseBoardCoordinate(kind, text) {
  if (typeof text !== 'string') return null;
  const normalized = text.normalize('NFKC'), width = boardWidth(kind);
  const match = /^([1-9])([一二三四五六七八九])$/.exec(normalized);
  if (match) {
    const file = Number(match[1]), row = BOARD_RANKS.indexOf(match[2]);
    if (file > width || row >= width) return null;
    return row * width + (kind === 'shogi' ? width - file : file - 1) + 1;
  }
  // Keep previously copied linear-square commands usable after updating.
  if (/^\d{1,2}$/.test(normalized) && Number(normalized) >= 1 && Number(normalized) <= width * width) return Number(normalized);
  return null;
}

export function boardMoveText(kind, text) {
  if (kind === 'reversi') return String(text || '').replace(/(あなた|ボット) (\d{1,2})(?![\d一二三四五六七八九])/g,
    (match, actor, square) => boardCoordinate(kind, Number(square)) ? `${actor} ${boardCoordinate(kind, Number(square))}` : match);
  return String(text || '').replace(/(\d{1,2})→(\d{1,2})(?![\d一二三四五六七八九])/g,
    (match, from, to) => boardCoordinate(kind, Number(from)) && boardCoordinate(kind, Number(to)) ? `${boardCoordinate(kind, Number(from))}→${boardCoordinate(kind, Number(to))}` : match)
    .replace(/([歩香桂銀金角飛])打(\d{1,2})(?![\d一二三四五六七八九])/g,
      (match, piece, square) => boardCoordinate(kind, Number(square)) ? `${boardCoordinate(kind, Number(square))}${piece}打` : match);
}
