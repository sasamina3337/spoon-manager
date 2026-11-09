import {node, time, send, notice} from '../shared/ui.js';
import {REQUEST_KINDS, REQUEST_STATUSES, REQUEST_LIMIT} from '../background/requests.js';

export function createRequestInbox(container, {run, update}) {
  container.className = 'card';
  const heading = node('div', undefined, 'section-title');
  const toggle = node('button', '受付を開始'); toggle.type = 'button';
  heading.append(node('h2', '質問・リクエスト受付'), toggle);
  const summary = node('p', '', 'result'); summary.setAttribute('role', 'status');
  const guide = node('p', '配信チャットで /質問 内容 または /リクエスト 内容。/question・/request も使えます。受付内容はチャット返信の連投制限にかかわらず保存します。', 'hint');
  const filters = node('div', undefined, 'filters');
  const search = node('input'); search.type = 'search'; search.placeholder = '名前・本文を検索'; search.setAttribute('aria-label', '質問・リクエストを検索');
  const kind = node('select'), status = node('select');
  kind.setAttribute('aria-label', '受付の種類'); status.setAttribute('aria-label', '受付の対応状況');
  for (const [select, labels, all] of [[kind, REQUEST_KINDS, 'すべての種類'], [status, REQUEST_STATUSES, 'すべての対応状況']]) {
    for (const [value, label] of [['', all], ...Object.entries(labels)]) { const option = node('option', label); option.value = value; select.append(option); }
  }
  filters.append(search, kind, status);
  const list = node('div'); list.className = 'request-list';
  const more = node('button', 'さらに100件を表示'); more.type = 'button';
  const scope = node('p', `配信ごとに最大${REQUEST_LIMIT}件。対応状況は自動保存します。終了後も変更できます。次の配信は受付停止から始まります。`, 'hint');
  container.append(heading, summary, guide, filters, list, more, scope);
  let state, signature = '', limit = 100, lastKey;
  toggle.addEventListener('click', () => {
    const session = state?.session; if (!session) return;
    const open = !session.requests?.open;
    run(toggle, async () => {
      update(await send('MANAGER_REQUESTS', {sessionKey: session.key, action: '受付', open}));
      notice(open ? '受付を開始しました。リスナーへ /質問・/リクエスト の使い方を案内してください。' : '受付を停止しました。');
    });
  });
  for (const input of [search, kind, status]) input.addEventListener('input', () => {limit = 100; render(state);});
  more.addEventListener('click', () => {limit += 100; render(state);});

  function render(next) {
    state = next;
    const session = state?.session, inbox = session?.requests;
    if (lastKey !== session?.key) {limit = 100; lastKey = session?.key;}
    toggle.disabled = !session || session.key !== state.activeKey || Boolean(session.endedAt);
    toggle.textContent = inbox?.open ? '受付を停止' : '受付を開始';
    const items = inbox?.items || [];
    summary.textContent = `${inbox?.open ? '受付中' : '受付停止中'} · 全${items.length}件\n${Object.entries(REQUEST_STATUSES).map(([key, label]) => `${label} ${items.filter(item => item.status === key).length}件`).join(' ／ ')}`;
    const query = search.value.toLocaleLowerCase();
    const nextSignature = JSON.stringify([session?.key, items, query, kind.value, status.value, limit]);
    if (signature === nextSignature) return;
    signature = nextSignature;
    const filtered = items.filter(item => (!kind.value || item.kind === kind.value) && (!status.value || item.status === status.value) &&
      `${item.user.name} ${item.text}`.toLocaleLowerCase().includes(query));
    const rows = filtered.slice(0, limit).map(item => {
      const row = node('article', undefined, 'request-item');
      row.append(node('h3', `#${item.id} ${REQUEST_KINDS[item.kind]} · ${item.user.name}`), node('p', time(item.time), 'hint'), node('p', item.text, 'request-text'));
      const label = node('label', '対応状況 '), select = node('select');
      select.setAttribute('aria-label', `受付 #${item.id} の対応状況`);
      for (const [value, text] of Object.entries(REQUEST_STATUSES)) { const option = node('option', text); option.value = value; select.append(option); }
      select.value = item.status;
      select.addEventListener('change', () => {
        const value = select.value, key = session.key;
        run(select, async () => {
          try { update(await send('MANAGER_REQUESTS', {sessionKey: key, action: 'status', id: item.id, status: value})); }
          catch (error) {select.value = item.status; throw error;}
        });
      });
      label.append(select); row.append(label); return row;
    });
    list.replaceChildren(...(rows.length ? rows : [node('p', '該当する質問・リクエストはありません。', 'empty')]));
    more.hidden = filtered.length <= limit;
  }
  return {render};
}
