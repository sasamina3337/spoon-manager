// Keep in sync with SpoonClient::prepare_authorization's complete consent set.
export const SPOON_SCOPES = Object.freeze([
  'me.read', 'live.read', 'listeners.read', 'fans.read',
  'events.chat', 'events.presence', 'events.like', 'events.donation', 'events.follow',
  'donations.read', 'chat.send', 'dj.follow'
]);

export function missingSpoonScopes(granted) {
  const scopes = new Set(typeof granted === 'string' ? granted.split(/\s+/) : []);
  return SPOON_SCOPES.filter(scope => !scopes.has(scope));
}
