export const $ = id => document.getElementById(id);

export async function send(type, payload = {}) {
  const result = await browser.runtime.sendMessage({type, ...payload});
  if (!result?.ok) throw new Error(result?.error || 'アプリから応答がありません。');
  return result;
}

export function notice(text, error = false) {
  $('notice').textContent = String(text || '').replace(/\r\n?/g, '\n');
  $('notice').classList.toggle('error', error);
  $('notice').hidden = !text;
  if (error && text) window.scrollTo({top: 0, behavior: 'instant'});
}

export function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}

export function time(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ja-JP', {timeZone: 'Asia/Tokyo'});
}

export function download(name, content, type = 'text/csv;charset=utf-8') {
  if (window.desktop?.saveCSV && type.startsWith('text/csv')) {
    return window.desktop.saveCSV(name, content).then(result => notice(result?.cancelled ? 'CSVの保存をキャンセルしました。' : 'CSVを書き出しました。')).catch(error => notice(error.message, true));
  }
  const url = URL.createObjectURL(new Blob([content], {type}));
  const anchor = node('a'); anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function poll(task, interval = 1500) {
  let working = false;
  const timer = setInterval(async () => {
    if (working || document.hidden) return;
    working = true;
    try { await task(); } catch { /* User actions report errors; polling never repeats notices. */ }
    finally { working = false; }
  }, interval);
  window.addEventListener('pagehide', () => clearInterval(timer), {once: true});
}
