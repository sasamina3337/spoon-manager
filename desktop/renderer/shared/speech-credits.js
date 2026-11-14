import {BUILTIN_VOICES} from './builtin-voices.js';
import {isCoeiroinkVoice} from './settings.js';

export const CREDIT_COMMENT_LIMIT = 100;
export const MAX_CREDIT_MESSAGES = 20;
const MAX_CREDIT_HISTORY = 4096;
const unsafeCharacters = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

function singleLine(value) {
  if (typeof value !== 'string' || unsafeCharacters.test(value)) throw new Error('音声クレジットに不正な改行・制御文字があります。声の一覧を確認してください。');
  return value.trim();
}

export function creditHistory(values = []) {
  if (!Array.isArray(values) || values.length > MAX_CREDIT_HISTORY) throw new Error('音声クレジット履歴の件数を確認してください。');
  return [...new Set(values.map(value => {
    const line = singleLine(value);
    if (!/^(?:VOICEVOX[: ]|COEIROINK:)\S/.test(line)) throw new Error('音声クレジットの表記を確認してください。');
    return line;
  }))];
}

export function voiceCredit(voice) {
  if (typeof voice?.credit === 'string' && voice.credit.trim()) return creditHistory([voice.credit])[0];
  if (typeof voice?.name !== 'string' || /(?:保存済み話者|話者) ID /.test(voice.name)) return '';
  const name = singleLine(voice.name).normalize('NFKC').replace(/\s*\([^()]*\)\s*$/, '').replace(/^VOICEVOX:\s*/, '').trim();
  if (!name) return '';
  if (isCoeiroinkVoice(voice.id)) return name.startsWith('COEIROINK:') ? name : '';
  if (/もち子|あん子/.test(name)) return 'VOICEVOX もち子さん(cv明日葉よもぎ)';
  if (name === 'Voidoll') return 'VOICEVOX:Voidoll(CV:丹下桜)';
  if (name === 'ユーレイちゃん' || name === 'ツクモちゃん') return 'VOICEVOX:ユーレイちゃん(CV:神崎零)';
  if (name.startsWith('Nemo ')) return 'VOICEVOX Nemo';
  return `VOICEVOX:${name}`;
}

// Never truncate a required name/CV to fit the chat limit.
export function creditMessages(credits, heading = 'クレジット：', limit = CREDIT_COMMENT_LIMIT) {
  if (!Number.isInteger(limit) || limit < 1 || limit > CREDIT_COMMENT_LIMIT) throw new Error('音声クレジットの文字数制限を確認してください。');
  const lines = creditHistory(credits);
  const prefix = singleLine(heading) + '\n', messages = [];
  let message = prefix;
  const groups = new Map();
  for (const line of lines) {
    const match = /^(VOICEVOX|COEIROINK):(.+)$/.exec(line);
    // Nemo and the space in "VOICEVOX 離途" have distinct required forms.
    const engine = match ? match[1] + ':' : '';
    const key = engine || line;
    if (!groups.has(key)) groups.set(key, {engine, names: []});
    groups.get(key).names.push(match ? match[2] : line);
  }
  for (const {engine, names} of groups.values()) {
    const fullLine = engine + names.join(engine ? '、' : '\n');
    if (message !== prefix && prefix.length + fullLine.length <= limit && message.length + 1 + fullLine.length > limit) {
      messages.push(message); message = prefix;
    }
    let sameLine = false;
    for (const name of names) {
      if (prefix.length + engine.length + name.length > limit) throw new Error('音声クレジットが100文字に収まりません。正式表記と掲載場所を確認してください。');
      let addition = sameLine ? '、' + name : (message === prefix ? '' : '\n') + engine + name;
      if (message.length + addition.length > limit) {
        messages.push(message); message = prefix;
        addition = engine + name;
      }
      message += addition;
      sameLine = Boolean(engine);
    }
  }
  if (message !== prefix) messages.push(message);
  validateCreditMessages(messages);
  return messages;
}

export function validateCreditMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > MAX_CREDIT_MESSAGES || messages.some(message =>
    typeof message !== 'string' || !message.trim() || message.length > CREDIT_COMMENT_LIMIT || unsafeCharacters.test(message.replaceAll('\n', ''))))
    throw new Error('音声クレジットの送信件数・文字数・表記を確認し、必要なら別の場所へ掲載してください。');
  return messages;
}

// Names are untrusted display text. Keep the required credit itself verbatim.
export function voiceChangeMessages(changes, catalog) {
  const groups = new Map();
  for (const change of changes) {
    const credit = voiceCredit(catalog.find(voice => voice?.id === change.id));
    if (!credit) throw new Error('変更後の音声名を確認できません。「保存済み API から声を取得」で更新してください。');
    const name = String(change.name || 'リスナー').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim() || 'リスナー';
    if (!groups.has(credit)) groups.set(credit, []);
    groups.get(credit).push(name);
  }
  const messages = [...groups].flatMap(([credit, names]) => {
    const name = [...names[0]].slice(0, 12).join('');
    const others = names.length > 1 ? ` ほか${names.length - 1}人` : '';
    return creditMessages([credit], `クレジット：音声変更 ${name}${others}`);
  });
  return validateCreditMessages(messages);
}

// Include the entire available catalog: random assignments and prior settings
// must not make a credit disappear while a recording is still being made.
export function speechCredits(voices = []) {
  const credits = new Set(BUILTIN_VOICES.map(voice => voice.credit));
  for (const voice of voices) {
    const credit = voiceCredit(voice);
    if (credit) credits.add(credit);
  }
  return [...credits].join('\n');
}
