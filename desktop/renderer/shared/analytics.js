export const STAT_FIELDS = ['comments', 'entries', 'hearts', 'spoons', 'follows'];
// A DOM page does not reliably expose the DJ's ID. Never merge unrelated rooms by name.
export const sessionOwner = key => String(key).startsWith('dom:') ? String(key) : String(key).slice(0, String(key).lastIndexOf(':'));
const stamp = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const count = value => Number.isFinite(value) && value > 0 ? value : 0;

function summarize(session, activeKey, now) {
  const start = stamp(session.observedAt);
  const end = stamp(session.endedAt) ?? (session.key === activeKey ? now : stamp(session.updatedAt)) ?? start;
  const minutes = start === null ? 0 : Math.max(0, (Math.min(now, end) - start) / 60000);
  const totals = Object.fromEntries(STAT_FIELDS.map(field => [field, count(session.totals?.[field])]));
  return {key: session.key, title: session.live?.title || '配信', date: session.observedAt, ended: Boolean(session.endedAt),
    totals, participants: session.users?.length || 0, minutes, commentsPerMinute: minutes >= 1 ? totals.comments / minutes : null};
}

// Only retained, observed data is analyzed. No API requests or game/private state.
export function analyzeSessions(sessions, {key, activeKey = '', limit = 10, now = Date.now()} = {}) {
  const selected = sessions.find(item => item.key === key) || sessions[0];
  const all = selected ? sessions.filter(item => sessionOwner(item.key) === sessionOwner(selected.key))
    .sort((a, b) => (stamp(b.observedAt) ?? 0) - (stamp(a.observedAt) ?? 0)) : [];
  const history = all.slice(0, [5, 10, 30, 100].includes(limit) ? limit : 10);
  const totals = Object.fromEntries(STAT_FIELDS.map(field => [field, 0]));
  const people = new Map();
  let minutes = 0;
  const rows = history.map(session => {
    const row = summarize(session, activeKey, now);
    minutes += row.minutes;
    for (const field of STAT_FIELDS) totals[field] += row.totals[field];
    for (const user of session.users || []) {
      let person = people.get(user.id);
      if (!person) { person = {id: user.id, name: user.name, sessions: 0, comments: 0, hearts: 0, spoons: 0}; people.set(user.id, person); }
      person.sessions++;
      for (const field of ['comments', 'hearts', 'spoons']) person[field] += count(user[field]);
    }
    return row;
  });
  const index = all.findIndex(item => item.key === selected?.key);
  const current = selected ? summarize(selected, activeKey, now) : null;
  const previous = all[index + 1] ? summarize(all[index + 1], activeKey, now) : null;
  const earlierPeople = new Set(all.slice(index + 1).flatMap(item => (item.users || []).map(user => user.id)));
  const returning = index >= 0 ? (selected.users || []).filter(user => earlierPeople.has(user.id)).length : 0;
  return {count: rows.length, totals, unique: people.size, minutes, commentsPerMinute: minutes >= 1 ? totals.comments / minutes : null,
    current, previous, returning, newcomers: current ? current.participants - returning : 0,
    hasEarlier: index >= 0 && index < all.length - 1,
    returningRate: current?.participants && index < all.length - 1 ? returning / current.participants * 100 : null,
    rows: rows.reverse(), contributors: [...people.values()].sort((a, b) => b.spoons - a.spoons || b.hearts - a.hearts || b.comments - a.comments).slice(0, 5)};
}
