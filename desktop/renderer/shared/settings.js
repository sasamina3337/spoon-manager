// Offline fallback only; the provider's /speakers response takes precedence.
export const LEGACY_VOICES = [
  {id: 0, name: '四国めたん（あまあま）'},
  {id: 1, name: 'ずんだもん（あまあま）'},
  {id: 2, name: '四国めたん（ノーマル）'},
  {id: 3, name: 'ずんだもん（ノーマル）'},
  {id: 8, name: '春日部つむぎ（ノーマル）'},
  {id: 10, name: '雨晴はう（ノーマル）'},
  {id: 9, name: '波音リツ（ノーマル）'},
  {id: 11, name: '玄野武宏（ノーマル）'},
  {id: 12, name: '白上虎太郎（ふつう）'},
  {id: 13, name: '青山龍星（ノーマル）'}
];

// Style IDs of the same VOICEVOX character still sound alike; reserve the whole character.
export function notificationVoiceIds(voices, speaker) {
  const character = name => String(name).normalize('NFKC').replace(/\s*\([^()]*\)\s*$/, '').trim();
  const selected = voices.find(voice => voice.id === speaker);
  return voices.filter(voice => voice.id === speaker || (selected && character(voice.name) === character(selected.name))).map(voice => voice.id);
}

export const DEFAULT_SETTINGS = {
  schemaVersion: 1,
  provider: 'legacy',
  apiKey: '',
  engineUrl: 'http://127.0.0.1:50021',
  systemSpeaker: 0,
  commentSpeakers: LEGACY_VOICES.filter(voice => !notificationVoiceIds(LEGACY_VOICES, 0).includes(voice.id)).map(voice => voice.id),
  speed: 1,
  volume: 1,
  outputDeviceId: '',
  outputDeviceLabel: '',
  enabled: true,
  spoonSource: 'api',
  spoonBridgeUrl: 'http://127.0.0.1:17864',
  spoonBridgeKey: '',
  readNames: false,
  commandSpeech: {weather: true, other: false},
  eventEnabled: {comment: true, entry: true, heart: true, spoon: true, temperature: true, follow: true},
  autoGreeting: {
    enabled: false,
    template: '{name}さん、いらっしゃい！\nゆっくりしていってね。',
    cooldownSeconds: 300
  },
  autoReplies: {
    heart: {enabled: false, template: '{name}さん\nハート{amount}個、ありがとうございます！',
      smallGiftTemplate: '{name}さん\n心ばかりの粗品、ありがとうございます！', cooldownSeconds: 0, minAmount: 1},
    spoon: {enabled: false, template: '{name}さん\n{amount}スプーン、ありがとうございます！', cooldownSeconds: 0, minAmount: 1}
  },
  announcements: {enabled: false, template: '遊びに来てくれてありがとうございます！\n気軽にコメントしてくださいね。', intervalMinutes: 10}
};

export function normalizeEngineUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); }
  catch { throw new Error('VOICEVOX EngineのURLを確認してください。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('APIのURLは認証情報・クエリを含まないhttp/httpsのURLにしてください。');
  }
  return url.href.replace(/\/+$/, '');
}

function finite(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

export function normalizeAutoGreeting(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const enabled = source.enabled === true;
  const template = typeof source.template === 'string' ? source.template.trim() : DEFAULT_SETTINGS.autoGreeting.template;
  if (enabled && !template) throw new Error('入室時に送信するコメントを入力してください。');
  if (template.length > 200) throw new Error('入室時のコメントは200文字以内にしてください（絵文字は2文字の場合があります）。');
  return {
    enabled,
    template,
    cooldownSeconds: Math.trunc(finite(source.cooldownSeconds ?? 300, 300, 0, 3600))
  };
}

export function normalizeAutomation(input, fallback, {announcement = false} = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const template = typeof source.template === 'string' ? source.template.replace(/\r\n?/g, '\n').trim() : fallback.template;
  if ((source.enabled === true && !template) || template.length > 200) throw new Error('自動コメントは1〜200文字で入力してください。');
  const smallGift = Object.hasOwn(fallback, 'smallGiftTemplate');
  const smallGiftTemplate = typeof source.smallGiftTemplate === 'string' ? source.smallGiftTemplate.replace(/\r\n?/g, '\n').trim() : fallback.smallGiftTemplate;
  if (smallGift && ((source.enabled === true && !smallGiftTemplate) || smallGiftTemplate.length > 200)) throw new Error('心ばかりの粗品のお礼は1〜200文字で入力してください。');
  return {enabled: source.enabled === true, template,
    ...(smallGift ? {smallGiftTemplate} : {}),
    ...(announcement ? {intervalMinutes: Math.trunc(finite(source.intervalMinutes ?? 10, 10, 1, 120))}
      // Retain the legacy field while migrating gifts to a reply for each occurrence.
      : {cooldownSeconds: 0,
        minAmount: Math.trunc(finite(source.minAmount ?? 1, 1, 1, 1000000000))})};
}

export function needsAutomaticChat(settings) {
  return Boolean(settings.autoGreeting?.enabled || settings.autoReplies?.heart?.enabled || settings.autoReplies?.spoon?.enabled || settings.announcements?.enabled);
}

export function automaticText(template, {name = '', amount = '', title = ''} = {}) {
  const values = {name: String(name), amount: String(amount), title: String(title)};
  let output = '';
  for (const char of template.replace(/\{(name|amount|title)\}/g, (_match, key) => values[key])) {
    if (output.length + char.length > 200) break;
    output += char;
  }
  return output;
}

export function normalizeSettings(input = {}) {
  const settings = {...DEFAULT_SETTINGS, ...input};
  if (!['legacy', 'engine'].includes(settings.provider)) throw new Error('未対応の音声APIです。');
  if (!['dom', 'api'].includes(settings.spoonSource)) throw new Error('未対応のSpoon取得方法です。');
  let commentSpeakers = [...new Set((Array.isArray(settings.commentSpeakers) ? settings.commentSpeakers : [])
    .map(Number).filter(id => Number.isSafeInteger(id) && id >= 0))];
  if (!commentSpeakers.length) throw new Error('コメントに使う声を1つ以上選んでください。');
  const systemSpeaker = Math.trunc(finite(settings.systemSpeaker, 0, 0, Number.MAX_SAFE_INTEGER));
  const reserved = notificationVoiceIds(LEGACY_VOICES, systemSpeaker);
  commentSpeakers = commentSpeakers.filter(id => id !== systemSpeaker && !reserved.includes(id));
  if (!commentSpeakers.length) commentSpeakers = LEGACY_VOICES.filter(voice => voice.id !== systemSpeaker && !reserved.includes(voice.id)).map(voice => voice.id);
  return {
    schemaVersion: 1,
    provider: settings.provider,
    apiKey: String(settings.apiKey ?? '').trim(),
    engineUrl: normalizeEngineUrl(settings.engineUrl),
    systemSpeaker,
    commentSpeakers,
    speed: finite(settings.speed, 1, 0.5, 2),
    volume: finite(settings.volume, 1, 0, 1),
    outputDeviceId: typeof settings.outputDeviceId === 'string' ? settings.outputDeviceId.slice(0, 1024) : '',
    outputDeviceLabel: typeof settings.outputDeviceLabel === 'string' ? settings.outputDeviceLabel.slice(0, 300) : '',
    enabled: settings.enabled !== false,
    spoonSource: 'api',
    spoonBridgeUrl: normalizeBridgeUrl(settings.spoonBridgeUrl),
    spoonBridgeKey: String(settings.spoonBridgeKey ?? '').trim(),
    readNames: settings.readNames === true,
    commandSpeech: {weather: settings.commandSpeech?.weather !== false, other: settings.commandSpeech?.other === true},
    eventEnabled: Object.fromEntries(Object.keys(DEFAULT_SETTINGS.eventEnabled)
      .map(type => [type, settings.eventEnabled?.[type] !== false])),
    autoGreeting: normalizeAutoGreeting(settings.autoGreeting),
    autoReplies: Object.fromEntries(['heart', 'spoon'].map(type => [type, normalizeAutomation(settings.autoReplies?.[type], DEFAULT_SETTINGS.autoReplies[type])])),
    announcements: normalizeAutomation(settings.announcements, DEFAULT_SETTINGS.announcements, {announcement: true})
  };
}

export function normalizeBridgeUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('連携サーバーのURLを確認してください。'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password ||
      url.search || url.hash || url.pathname !== '/') throw new Error('連携サーバーにはhttp://127.0.0.1:ポート番号を指定してください。');
  return url.origin;
}

export function cleanUser(user) {
  if (!user || typeof user.name !== 'string') return null;
  const name = user.name.trim().slice(0, 120);
  if (!name) return null;
  return {id: String(user.id || `name:${name}`).slice(0, 300), name};
}
