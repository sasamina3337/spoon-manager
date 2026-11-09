import {$, node, time} from '../shared/ui.js';

const names = {spoons: 'スプーン', hearts: 'ハート', comments: 'コメント', participants: '参加者'};
const number = value => value.toLocaleString('ja-JP', {maximumFractionDigits: 1});
let chartSignature = '';

export function renderDashboard(analysis, selectSession) {
  for (const field of ['spoons', 'hearts', 'comments']) $('analysis-' + field).textContent = number(analysis.totals[field]);
  $('analysis-unique').textContent = number(analysis.unique);
  $('analysis-scope').textContent = analysis.count ? `選択した配信と同じDJ・保存${analysis.count}配信 ／ 観測期間 合計${number(analysis.minutes)}分` : '配信情報を取得すると、ここに配信の実績がたまります。';
  $('analysis-returning').textContent = analysis.returningRate === null ? '—' : `${analysis.returning}人（${Math.round(analysis.returningRate)}%）`;
  $('returning-detail').textContent = analysis.hasEarlier ? `以前の保存記録で確認できなかった参加者：${analysis.newcomers}人` : '同じDJの過去の記録がまだありません。';
  $('analysis-rate').textContent = analysis.current?.commentsPerMinute == null ? '—' : number(analysis.current.commentsPerMinute);
  $('comparison-label').textContent = analysis.previous ? `${analysis.previous.title} ／ ${time(analysis.previous.date)} と比較` : '直前の保存済み配信がありません。';
  $('comparison').replaceChildren(...(analysis.previous && analysis.current ? ['spoons', 'hearts', 'comments'].map(field => {
    const current = analysis.current.totals[field], previous = analysis.previous.totals[field], diff = current - previous;
    const change = previous ? `${diff > 0 ? '+' : ''}${Math.round(diff / previous * 100)}%` : diff ? '比較元 0' : '変化なし';
    const row = node('div'); row.append(node('span', names[field]), node('strong', `${diff > 0 ? '+' : ''}${number(diff)}`), node('small', change)); return row;
  }) : [node('p', '2配信目から差分を表示します。', 'hint')]));

  const metric = $('trend-metric').value;
  const value = row => metric === 'participants' ? row.participants : row.totals[metric];
  const signature = JSON.stringify([metric, analysis.current?.key, analysis.contributors, analysis.rows.map(row => [row.key, row.title, row.date, row.totals, row.participants])]);
  if (signature === chartSignature) return;
  chartSignature = signature;
  const max = Math.max(1, ...analysis.rows.map(value));
  const chart = analysis.rows.map((row, index) => {
    const button = node('button', undefined, 'chart-column' + (row.key === analysis.current?.key ? ' selected' : ''));
    button.type = 'button'; button.title = `${row.title}・${time(row.date)}・${names[metric]} ${number(value(row))}`;
    button.setAttribute('aria-label', button.title); button.setAttribute('aria-pressed', String(row.key === analysis.current?.key));
    const track = node('span', undefined, 'bar-track'), bar = node('span', undefined, 'bar');
    bar.style.height = `${value(row) / max * 100}%`; track.append(bar);
    const date = new Date(row.date);
    button.append(node('strong', number(value(row))), track, node('span', Number.isFinite(date.getTime()) ? date.toLocaleDateString('ja-JP', {timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric'}) : String(index + 1)));
    button.addEventListener('click', () => selectSession(row.key)); return button;
  });
  $('trend-chart').replaceChildren(...(chart.length ? chart : [node('p', 'まだ配信記録がありません。', 'empty')]));
  $('trend-chart').setAttribute('aria-label', `${names[metric]}の推移。保存${analysis.count}配信。`);
  const rows = analysis.rows.toReversed().map(item => {
    const row = node('tr'), title = node('td'), button = node('button', item.title, 'name-button'); button.type = 'button';
    button.title = time(item.date); button.addEventListener('click', () => selectSession(item.key));
    title.append(button, node('small', time(item.date))); row.append(title);
    for (const val of [item.totals.comments, item.totals.hearts, item.totals.spoons, item.participants]) row.append(node('td', number(val)));
    return row;
  });
  $('analysis-rows').replaceChildren(...(rows.length ? rows : [node('tr')]));
  $('contributors').replaceChildren(...(analysis.contributors.length ? analysis.contributors.map(person => {
    const item = node('li'), info = node('div'); info.append(node('strong', person.name), node('small', `${person.sessions}配信で検出`));
    item.append(info, node('span', `${number(person.spoons)} スプーン / ${number(person.hearts)} ハート / ${number(person.comments)} コメント`)); return item;
  }) : [node('li', '参加者の記録がありません。', 'empty')]));
}
