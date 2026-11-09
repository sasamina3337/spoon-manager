export function randomInt(length) {
  if (!Number.isSafeInteger(length) || length < 1 || length > 0x100000000) throw new Error('乱数の範囲が不正です。');
  const values = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / length) * length;
  do { crypto.getRandomValues(values); } while (values[0] >= limit);
  return values[0] % length;
}
