export const REQUEST_LIMIT = 1000;
export const REQUEST_STATUSES = {pending: '未対応', working: '対応中', done: '完了'};
export const REQUEST_KINDS = {question: '質問', request: 'リクエスト'};

export function requestSubmission(text) {
  const match = /^\/(質問|question|リクエスト|request)(?:\s+([\s\S]*))?$/i.exec(String(text).trim());
  if (!match) return null;
  return {kind: ['質問', 'question'].includes(match[1].toLowerCase()) ? 'question' : 'request', text: (match[2] || '').trim()};
}

export function restoreRequests(saved) {
  const ids = new Set(), events = new Set();
  const items = [];
  for (const item of Array.isArray(saved?.items) ? saved.items : []) {
    if (items.length >= REQUEST_LIMIT) break;
    if (!Number.isSafeInteger(item?.id) || item.id < 1 || ids.has(item.id) ||
        typeof item.eventId !== 'string' || !item.eventId || events.has(item.eventId) ||
        !Object.hasOwn(REQUEST_KINDS, item.kind) || !Object.hasOwn(REQUEST_STATUSES, item.status) ||
        typeof item.text !== 'string' || !item.text.trim() || item.text.length > 500 ||
        typeof item.user?.id !== 'string' || typeof item.user.name !== 'string') continue;
    ids.add(item.id); events.add(item.eventId);
    items.push({id: item.id, eventId: item.eventId, kind: item.kind, status: item.status, text: item.text,
      user: {id: item.user.id.slice(0, 300), name: item.user.name.slice(0, 120)},
      time: typeof item.time === 'string' ? item.time : '', updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : ''});
  }
  return {open: saved?.open === true, items};
}

export function setRequestsOpen(session, open) {
  if (typeof open !== 'boolean') throw new Error('受付の開始・停止を指定してください。');
  if (open && session.endedAt) throw new Error('終了した配信では受付を開始できません。');
  session.requests ||= restoreRequests();
  session.requests.open = open;
  return open ? '質問・リクエストの受付を開始しました。/質問 内容 または /リクエスト 内容 で送ってください。' : '質問・リクエストの受付を停止しました。';
}

export function submitRequest(session, event, submission, {acceptedFromPortal = false} = {}) {
  session.requests ||= restoreRequests();
  const inbox = session.requests;
  // Keep submission deduplication independent of the rolling event log.
  const existing = inbox.items.find(item => item.eventId === event.id);
  if (existing) return `${REQUEST_KINDS[existing.kind]} #${existing.id} は受付済みです。`;
  if (!acceptedFromPortal && (!inbox.open || session.endedAt)) return '質問・リクエストは現在受付を停止しています。';
  if (!submission.text || submission.text.length > 500) return '使い方：/質問 内容 または /リクエスト 内容（本文1〜500文字）';
  if (typeof event.id !== 'string' || !event.id || typeof event.user?.id !== 'string' || typeof event.user.name !== 'string') return '送信者を確認できないため受付できませんでした。';
  if (inbox.items.length >= REQUEST_LIMIT) return `この配信の受付上限（${REQUEST_LIMIT}件）に達しました。`;
  const id = inbox.items.reduce((max, item) => Math.max(max, item.id), 0) + 1;
  if (!Number.isSafeInteger(id)) return '受付番号の上限に達しました。';
  const time = event.time || new Date().toISOString();
  inbox.items.push({id, eventId: event.id, kind: submission.kind, text: submission.text,
    user: {id: event.user.id.slice(0, 300), name: event.user.name.slice(0, 120)}, status: 'pending', time, updatedAt: time});
  return `${REQUEST_KINDS[submission.kind]} #${id} を受け付けました。`;
}

export function updateRequestStatus(session, id, status) {
  if (!Object.hasOwn(REQUEST_STATUSES, status)) throw new Error('対応状況を選択してください。');
  const item = session.requests?.items.find(item => item.id === id);
  if (!item) throw new Error('対象の質問・リクエストが見つかりません。');
  item.status = status;
  item.updatedAt = new Date().toISOString();
}
