import {missingSpoonScopes} from './shared/spoon-permissions.js';

// Startup API selection uses the same native operations as Settings.
export function installSetup({adapter, document: doc = document, window: win = window, onSaved = async () => {}}) {
  const dialog = doc.createElement('dialog');
  dialog.id = 'native-setup'; dialog.className = 'native-setup';
  dialog.setAttribute('aria-labelledby', 'native-setup-heading');
  dialog.innerHTML = `<h2 id="native-setup-heading">API連携の設定</h2>
    <p>利用するAPIを選択してください。保存済みの設定はそのまま引き継ぎます。</p>
    <div data-setup-step="config">
      <label class="check-row"><input id="setup-spoon" type="checkbox" checked> Spoon公式APIと連携する</label>
      <label class="field"><span>読み上げに利用するAPI</span><select id="setup-provider"><option value="legacy">WEB版VOICEVOX（APIキー）</option><option value="engine">VOICEVOX ENGINE</option><option value="off">読み上げを使わない</option></select></label>
      <div id="setup-spoon-fields">
        <label class="field"><span>Client ID</span><input id="setup-client" autocomplete="off"></label>
        <label class="field"><span>Client Secret</span><input id="setup-secret" type="password" autocomplete="off"></label>
        <label class="field"><span>リージョン</span><select id="setup-region"><option value="jp">日本</option><option value="kr">韓国</option></select></label>
        <label class="field"><span>認証ポート</span><input id="setup-port" type="number" min="1024" max="65535"></label>
        <p id="setup-redirect" class="hint"></p>
      </div>
      <label id="setup-key-field" class="field"><span>音声APIキー</span><input id="setup-key" type="password" autocomplete="off"></label>
      <label id="setup-engine-field" class="field"><span>VOICEVOX ENGINEのURL</span><input id="setup-engine" type="url" placeholder="http://127.0.0.1:50021"></label>
      <label class="check-row"><input id="setup-startup" type="checkbox" checked> 起動時にこの選択画面を表示する</label>
      <label class="check-row"><input id="setup-return" type="checkbox" checked> 認証完了後にアプリへ戻る</label>
      <label class="check-row"><input id="setup-close-tab" type="checkbox" checked> 認証完了後に認証タブを閉じる</label>
      <p class="hint">ブラウザーが自動閉鎖を許可しない場合は、完了画面からタブを閉じてください。</p>
      <button id="setup-save" type="button" class="primary">保存して次へ</button>
    </div>
    <div data-setup-step="consent" hidden><p>設定を保存しました。DJの同意を取得してください。</p><button id="setup-authorize" type="button" class="primary">DJの同意画面を開く</button><button id="setup-back" type="button">設定に戻る</button></div>
    <p id="setup-status" class="result" role="status"></p>
    <div class="section-title"><button id="setup-finish" type="button" class="primary" hidden>設定を完了してアプリを開く</button><button id="setup-later" type="button">あとで設定する</button></div>`;
  doc.body.append(dialog);
  const find = id => doc.getElementById('setup-' + id);
  let original = {}, waiting = false, busy = false, timer, authorizationBaseline = 0, authorizationWasValid = false;
  const consentComplete = raw => raw._native?.authorized === true && missingSpoonScopes(raw._native.scopes).length === 0;
  const status = (text, error = false) => { find('status').textContent = text; find('status').classList.toggle('error', error); };
  const showFields = () => {
    find('spoon-fields').hidden = !find('spoon').checked;
    find('key-field').hidden = find('provider').value !== 'legacy';
    find('engine-field').hidden = find('provider').value !== 'engine';
    find('redirect').textContent = `登録するリダイレクトURI：http://localhost:${find('port').value}/oauth/callback`;
  };
  const step = name => { for (const node of dialog.querySelectorAll('[data-setup-step]')) node.hidden = node.dataset.setupStep !== name; };
  const close = () => { waiting = false; win.clearInterval(timer); if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open'); };
  async function finish() { close(); win.location.hash = 'overview'; await onSaved(); }
  async function run(button, action) {
    if (busy) return;
    busy = true; button.disabled = true;
    try { await action(); } catch (error) { status(error.message, true); }
    finally { busy = false; button.disabled = false; }
  }
  find('spoon').addEventListener('change', showFields);
  find('provider').addEventListener('change', showFields);
  find('port').addEventListener('input', showFields);
  find('later').addEventListener('click', close);
  dialog.addEventListener('close', () => { waiting = false; win.clearInterval(timer); });
  find('back').addEventListener('click', () => { waiting = false; step('config'); find('finish').hidden = true; });
  find('save').addEventListener('click', () => run(find('save'), async () => {
    const provider = find('provider').value;
    if (provider === 'legacy' && !find('key').value.trim()) throw new Error('音声APIキーを入力してください。');
    const config = {...original, clientId: find('client').value.trim(), clientSecret: find('secret').value.trim(),
      region: find('region').value, port: Number(find('port').value), returnToApp: find('return').checked, closeAuthTab: find('close-tab').checked};
    if (find('spoon').checked) {
      if (!config.clientId || !config.clientSecret || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error('SpoonのClient ID・Client Secret・認証ポートを確認してください。');
      if (JSON.stringify(config) !== JSON.stringify(original)) await adapter.configure(config);
      original = config;
    }
    const saved = await adapter.message({type: 'SAVE_SETTINGS', settings: {
      ...(provider !== 'off' ? {provider} : {}), enabled: provider !== 'off', apiKey: find('key').value.trim(),
      engineUrl: find('engine').value.trim(), useSpoonApi: find('spoon').checked, showSetupOnStartup: find('startup').checked, setupCompleted: true
    }});
    if (!saved.ok) throw new Error(saved.error);
    const state = await adapter.snapshot(true);
    step('consent');
    const authorized = consentComplete(state);
    find('authorize').hidden = !find('spoon').checked || authorized;
    find('finish').hidden = find('spoon').checked && !authorized;
    status(find('finish').hidden ? 'DJの同意画面を開いて認証を完了してください。' : '設定が完了しました。読み上げの出力先とテストは「設定 → 読み上げ」で確認できます。');
    await onSaved();
  }));
  find('authorize').addEventListener('click', () => run(find('authorize'), async () => {
    const raw = await adapter.snapshot(true);
    authorizationBaseline = Number(raw._native?.authorizationCompleted) || 0;
    authorizationWasValid = raw._native?.authorized === true;
    const result = await adapter.message({type: 'AUTHORIZE_SPOON'});
    if (!result.ok) throw new Error(result.error);
    waiting = true;
    status('ブラウザーでDJの同意を完了してください。完了するとアプリに戻ります。');
  }));
  find('finish').addEventListener('click', () => { void finish(); });
  return {
    async open() {
      const [raw, connection] = await Promise.all([adapter.snapshot(true), adapter.connection()]);
      const settings = raw.settings || {};
      original = connection || {}; waiting = false; step('config'); find('finish').hidden = true;
      find('spoon').checked = settings.useSpoonApi !== false;
      find('client').value = original.clientId || ''; find('secret').value = original.clientSecret || '';
      find('region').value = original.region || 'jp'; find('port').value = String(original.port || 17864);
      find('provider').value = settings.enabled === false ? 'off' : settings.provider || 'legacy';
      find('key').value = settings.apiKey || ''; find('engine').value = settings.engineUrl || 'http://127.0.0.1:50021';
      find('startup').checked = settings.showSetupOnStartup !== false;
      find('return').checked = original.returnToApp !== false; find('close-tab').checked = original.closeAuthTab !== false;
      showFields(); status(consentComplete(raw) ? 'Spoonとの連携は完了しています。利用するAPIや起動時の動作を変更できます。' : '利用するAPIと接続情報を確認してください。受信開始時に、すべてのSpoon権限の同意をまとめて取得します。');
      if (!dialog.open) { if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', ''); }
      win.clearInterval(timer);
      timer = win.setInterval(async () => {
        if (!waiting || busy) return;
        try {
          const raw = await adapter.snapshot(true);
          if (raw._native?.authorized && (!authorizationWasValid || Number(raw._native.authorizationCompleted) > authorizationBaseline)) {
            waiting = false;
            if (consentComplete(raw)) await finish();
            else status('同意に必要な権限が不足しています。開発者センターに全権限を登録して、もう一度DJの同意画面を開いてください。', true);
          }
        }
        catch { status('認証状態を確認できませんでした。もう一度お試しください。', true); }
      }, 1000);
    },
    close,
    destroy() { close(); dialog.remove(); }
  };
}
