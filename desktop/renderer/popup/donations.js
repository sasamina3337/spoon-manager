import {node, time, download} from '../shared/ui.js';
import {csv} from '../shared/manager-utils.js';

export function createDonationsPanel(root, {refresh, authorize, save = download}) {
  root.className = 'card';
  const title = node('div', undefined, 'section-title'), button = node('button', 'ギフト履歴を更新'), exportButton = node('button', '履歴CSVを保存');
  button.id = 'refresh-donations';
  button.type = exportButton.type = 'button';
  const actions = node('div', undefined, 'section-actions');
  actions.append(button, exportButton); title.append(node('h2', '公式ギフト履歴'), actions);
  const summary = node('p', '', 'hint'), list = node('ol'), more = node('button', 'さらに100件を表示'); more.type = 'button';
  root.append(title, summary, list, more, node('p', '利用する機能で「ギフト履歴」を有効にして、DJの追加同意を取得してください。受信開始前・切断中も含む現在の配信の履歴を保存します。履歴と通知には共通のギフトIDがないため、履歴の合計を受信分の集計に加算せず、お礼の再送も行いません。', 'hint'));
  const consent = node('p', undefined, 'hint');
  const authorizeButton = node('button', 'DJの追加同意を取得', 'text-button');
  authorizeButton.type = 'button';
  consent.append('権限エラーが出る場合は、開発者センターで donations.read を登録してから同意を更新してください。 ', authorizeButton);
  consent.hidden = !authorize;
  root.append(consent);
  authorizeButton.addEventListener('click', () => authorize?.(authorizeButton));
  let state, limit = 100, key = '', signature = '';
  function draw() {
    const history = state.session?.donationHistory;
    summary.textContent = history ? `${history.items.length}件 · 履歴の合計 ${history.total.toLocaleString('ja-JP')}スプーン · 取得 ${time(history.fetchedAt)}` : 'ギフト履歴はまだ取得していません。';
    const items = (history?.items || []).slice(0, limit).map(item => node('li', `${time(item.time)} · ${item.user.name} · ${item.stickerName} · ${item.amount}スプーン`));
    list.replaceChildren(...items); more.hidden = (history?.items.length || 0) <= limit;
    exportButton.disabled = !history;
  }
  more.addEventListener('click', () => {limit += 100; draw();});
  button.addEventListener('click', () => refresh(button));
  exportButton.addEventListener('click', () => {
    if (!state.session?.donationHistory) return;
    save(`spoon-manager-${state.session.live.liveId}-donations.csv`, csv([
      ['時刻（UTC）', 'ユーザーID', '名前', 'ステッカー', 'スプーン'],
      ...state.session.donationHistory.items.map(item => [item.time, item.user.id, item.user.name, item.stickerName, item.amount])]));
  });
  return {render(input) {
    state = input;
    if (key !== state.session?.key) {key = state.session?.key; limit = 100; signature = '';}
    button.disabled = !state.preferences.features.donations || !key || key !== state.activeKey || Boolean(state.session?.endedAt);
    authorizeButton.disabled = !state.preferences.features.donations;
    const missingScope = typeof state.native?.scopes === 'string' && !state.native.scopes.split(/\s+/).includes('donations.read');
    button.title = missingScope ? 'ギフト履歴の追加同意をブラウザーで開きます。同意後、もう一度更新してください。' : '';
    const next = JSON.stringify(state.session?.donationHistory);
    if (signature !== next) {signature = next; draw();}
  }};
}
