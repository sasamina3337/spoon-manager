import {node, notice} from '../shared/ui.js';

export function createParticipationPanel(container, {run}) {
  if (!window.desktop?.participation) return;
  container.className = 'card'; container.id = 'participation-panel';
  container.innerHTML = `<h2>リスナー用URL</h2><p class="hint">将棋・リバーシはリスナー同士／ボット対戦に対応。質問箱も別URLで開けます。参加ページの確認コードをSpoonチャットへ送ると、リスナーのIDと名前に紐づきます。</p>
    <div class="section-title"><button id="publish-participation" type="button">URLを発行（一時公開）</button><button id="stop-participation" type="button" disabled>公開を停止</button></div>
    <p id="participation-status" class="hint" role="status"></p><div id="participation-links"></div>
    <details><summary>固定URLを使う場合</summary><p class="hint">自分で用意したHTTPSの公開先を http://127.0.0.1:17865 へ接続してください。ここで入力するURLから管理APIには接続しません。</p><label>公開先HTTPS URL<input id="participation-origin" type="url" placeholder="https://example.com"></label><button id="publish-fixed-participation" type="button">固定URLで公開</button></details>
    <p class="hint">一時URLはCloudflare経由の試用向け公開です。アプリ終了・配信終了・公開停止で使えなくなります。公開し直した場合は新しいURLを共有してください。質問箱の受付は上の「質問・リクエスト受付」で開始します。</p>`;
  const $ = id => container.querySelector('#' + id);
  let last = '';
  async function update() {
    try {
      const status = await window.desktop.participation('status');
      $('stop-participation').disabled = !status.running;
      $('participation-status').textContent = status.running ? `公開中 · 紐づけ済み ${status.participants}人` : status.error || '未公開です。配信に接続してからURLを発行してください。';
      const signature = JSON.stringify(status.links); if (last === signature) return; last = signature;
      $('participation-links').replaceChildren(...status.links.map(link => {
        const row = node('div', undefined, 'share-link');
        const label = node('label', {shogi: '将棋の参加URL', reversi: 'リバーシの参加URL', question: '質問箱URL'}[link.kind]);
        const input = node('input'); input.readOnly = true; input.value = link.url; label.append(input);
        const copy = node('button', 'コピー'); copy.type = 'button'; copy.onclick = async () => {try {await navigator.clipboard.writeText(link.url); notice('URLをコピーしました。配信のリスナーへ共有してください。');} catch {input.select(); notice('Ctrl+Cでコピーしてください。');}};
        const open = node('button', '開く'); open.type = 'button'; open.onclick = () => run(open, () => window.desktop.participation('open', {url: link.url}));
        row.append(label, copy, open); return row;
      }));
    } catch (error) {$('participation-status').textContent = error.message;}
  }
  async function publish(publicOrigin = '') {await window.desktop.participation('start', {publicOrigin}); await update(); notice('参加URLを発行しました。リンクをコピーして共有してください。');}
  $('publish-participation').onclick = () => run($('publish-participation'), () => publish());
  $('publish-fixed-participation').onclick = () => run($('publish-fixed-participation'), () => {const origin = $('participation-origin').value.trim(); if (!origin) throw new Error('固定の公開先HTTPS URLを入力してください。'); return publish(origin);});
  $('stop-participation').onclick = () => run($('stop-participation'), async () => {await window.desktop.participation('stop'); await update(); notice('公開を停止しました。これまでの参加URLは無効です。');});
  void update(); const timer = setInterval(() => {if (!document.hidden) void update();}, 3000);
  window.addEventListener('pagehide', () => clearInterval(timer), {once: true});
}
