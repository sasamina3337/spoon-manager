// Device refreshes preserve unsaved selection, including a disconnected device.
export class AudioOutputUI {
  constructor({select, refresh, status, name, mediaDevices = globalThis.navigator?.mediaDevices,
    supported = typeof globalThis.HTMLMediaElement?.prototype.setSinkId === 'function'}) {
    Object.assign(this, {select, button: refresh, status, name, mediaDevices});
    this.supported = supported && typeof mediaDevices?.enumerateDevices === 'function';
    this.devices = [];
    this.loaded = false;
    this.error = '';
    select.disabled = refresh.disabled = !this.supported;
    refresh.addEventListener('click', () => { void this.refresh(); });
    select.addEventListener('change', () => this.showStatus());
    mediaDevices?.addEventListener?.('devicechange', () => { void this.refresh(); });
    this.showStatus();
  }

  get selection() {
    return {outputDeviceId: this.select.value, outputDeviceLabel: this.select.selectedOptions[0]?.dataset.label || ''};
  }

  render({outputDeviceId = '', outputDeviceLabel = ''} = this.selection) {
    const document = this.select.ownerDocument;
    const option = (id, label, text = label) => {
      const node = document.createElement('option');
      node.value = id;
      node.textContent = text;
      node.title = text;
      node.dataset.label = label;
      return node;
    };
    const options = [option('', '', 'Windows の既定の出力先')];
    for (const [index, device] of this.devices.entries()) {
      options.push(option(device.deviceId, device.label || `出力デバイス ${index + 1}`));
    }
    if (outputDeviceId && !this.devices.some(device => device.deviceId === outputDeviceId)) {
      options.push(option(outputDeviceId, outputDeviceLabel, `${outputDeviceLabel || '保存済みの出力先'}（${this.loaded ? '未接続' : '確認待ち'}）`));
    }
    this.select.replaceChildren(...options);
    this.select.value = outputDeviceId;
    this.showStatus();
  }

  showStatus() {
    const fullName = this.select.selectedOptions[0]?.textContent || 'Windows の既定の出力先';
    this.select.title = fullName;
    if (this.name) this.name.textContent = `選択中：${fullName}`;
    const missing = this.loaded && this.select.value && !this.devices.some(device => device.deviceId === this.select.value);
    this.status.textContent = !this.supported ? 'この環境では出力先を選択できません。Windows のサウンド設定でアプリの出力先を指定してください。'
      : this.error || (missing ? '選択した出力先が見つかりません。デバイスを接続して一覧を更新するか、別の出力先を選んで保存してください。'
        : this.loaded ? '出力先を変更したら、設定を保存して「読み上げテスト」で確認してください。' : '出力先を確認しています…');
    this.status.classList.toggle('error', Boolean(this.error || missing));
  }

  async refresh() {
    if (!this.supported || this.refreshing) return;
    this.refreshing = true;
    this.button.disabled = true;
    try {
      const devices = await this.mediaDevices.enumerateDevices();
      this.devices = devices.filter(device => device.kind === 'audiooutput' && device.deviceId && !['default', 'communications'].includes(device.deviceId));
      this.loaded = true;
      this.error = '';
      this.render();
    } catch {
      this.error = '出力先を取得できませんでした。「出力先を更新」で再試行してください。';
      this.showStatus();
    } finally {
      this.refreshing = false;
      this.button.disabled = false;
    }
  }
}
