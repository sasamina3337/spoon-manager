import {randomInt} from './random.js';

export function csv(rows) {
  const cell = input => {
    let text = String(input ?? '');
    // Prevent spreadsheet formula execution when exporting listener-controlled content.
    if (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return '\ufeff' + rows.map(row => row.map(cell).join(',')).join('\r\n');
}

export function drawListeners(listeners, count, random = randomInt) {
  const unique = [...new Map(listeners.filter(user => typeof user.id === 'string').map(user => [user.id, user])).values()];
  if (!Number.isInteger(count) || count < 1 || count > 20 || count > unique.length) throw new Error('抽選人数は現在のリスナー数以内で、1〜20人にしてください。');
  const winners = [];
  while (winners.length < count) winners.push(unique.splice(random(unique.length), 1)[0]);
  return winners;
}
