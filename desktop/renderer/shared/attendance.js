export function japanDate(value = Date.now()) {
  const stamp = new Date(value).getTime();
  return Number.isFinite(stamp) ? new Date(stamp + 9 * 3600000).toISOString().slice(0, 10) : '';
}

export function dailyAttendance(sessions, owner, ownerOf) {
  const days = new Map();
  for (const session of sessions.filter(item => ownerOf(item.key) === owner)) {
    for (const user of session.users) {
      for (const [date, visit] of Object.entries(user.visits || {})) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        if (!days.has(date)) days.set(date, new Map());
        const people = days.get(date);
        let person = people.get(user.id);
        if (!person) {person = {id: user.id, name: user.name, firstSeen: visit.firstSeen, lastSeen: visit.lastSeen, entries: 0, sessions: 0}; people.set(user.id, person);}
        if (visit.firstSeen < person.firstSeen) person.firstSeen = visit.firstSeen;
        if (visit.lastSeen >= person.lastSeen) {person.lastSeen = visit.lastSeen; person.name = user.name;}
        person.entries += visit.entries || 0;
        person.sessions++;
      }
    }
  }
  return [...days].sort(([a], [b]) => b.localeCompare(a)).map(([date, users]) => ({date,
    users: [...users.values()].sort((a, b) => a.firstSeen.localeCompare(b.firstSeen) || a.id.localeCompare(b.id))}));
}
