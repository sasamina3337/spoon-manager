import {japanDate} from '../shared/attendance.js';
import {node, time, download} from '../shared/ui.js';
import {csv} from '../shared/manager-utils.js';

export function createAttendancePanel(root, {now = Date.now, save = download} = {}) {
  root.className = 'card';
  const heading = node('h2', '日付別の来訪者');
  const select = node('select'); select.setAttribute('aria-label', '来訪者を表示する日付');
  const search = node('input'); search.type = 'search'; search.placeholder = '名前で検索'; search.setAttribute('aria-label', '日付別の来訪者を検索');
  const exportButton = node('button', '来訪者CSVを保存'); exportButton.type = 'button';
  const summary = node('p', '', 'hint');
  const table = node('table'), head = node('thead'), headers = node('tr'), body = node('tbody'), wrap = node('div', undefined, 'table-wrap');
  for (const text of ['名前', '最初の確認', '最後の確認', '入室通知', '配信数']) headers.append(node('th', text));
  head.append(headers); table.append(head, body); wrap.append(table);
  const controls = node('div', undefined, 'filters'); controls.append(select, search, exportButton);
  root.append(heading, controls, summary, wrap, node('p', '日本時間（0時区切り）。同じDJの保存済み配信をまとめ、同じ人は1人として表示します。入室通知・発言・贈り物・リスナー一覧で確認できた記録です。過去の未保存期間は補完できません。', 'hint'));
  let days = [], owner = '', signature = '';
  const date = () => select.value || japanDate(now());
  const people = () => days.find(day => day.date === date())?.users || [];
  function draw() {
    const users = people(), query = search.value.trim().toLocaleLowerCase();
    summary.textContent = `${date()} · ${users.length}人`;
    const rows = users.filter(user => user.name.toLocaleLowerCase().includes(query)).map(user => {
      const row = node('tr');
      for (const value of [user.name, time(user.firstSeen), time(user.lastSeen), user.entries, user.sessions]) row.append(node('td', value));
      row.firstChild.title = user.id; return row;
    });
    if (!rows.length) {const row = node('tr'), cell = node('td', 'この日付に該当する来訪記録はありません。'); cell.colSpan = 5; row.append(cell); rows.push(row);}
    body.replaceChildren(...rows);
  }
  select.addEventListener('change', draw); search.addEventListener('input', draw);
  exportButton.addEventListener('click', () => save(`spoon-manager-visitors-${date()}.csv`, csv([
    ['日付（日本時間）', 'ユーザーID', '名前', '最初の確認（UTC）', '最後の確認（UTC）', '入室通知', '配信数'],
    ...people().map(user => [date(), user.id, user.name, user.firstSeen, user.lastSeen, user.entries, user.sessions])])));
  return {render(state) {
    const nextOwner = state.session?.key?.slice(0, state.session.key.lastIndexOf(':')) || '';
    if (owner !== nextOwner) {owner = nextOwner; select.value = ''; search.value = ''; signature = '';}
    days = state.attendance || [];
    const next = JSON.stringify([days, japanDate(now())]);
    if (next === signature) return;
    signature = next;
    const previous = select.value, today = japanDate(now());
    const option = node('option', `今日（${today}）`); option.value = '';
    const options = days.map(day => {const item = node('option', `${day.date}（${day.users.length}人）`); item.value = day.date; return item;});
    select.replaceChildren(option, ...options); select.value = days.some(day => day.date === previous) ? previous : '';
    draw();
  }};
}
