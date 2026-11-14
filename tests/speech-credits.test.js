import test from 'node:test';
import assert from 'node:assert/strict';
import {creditMessages, voiceCredit, voiceChangeMessages, speechCredits, validateCreditMessages} from '../desktop/renderer/shared/speech-credits.js';

test('credit comments group engines, remove duplicate styles and preserve special forms and CVs', () => {
  assert.deepEqual(creditMessages(['VOICEVOX:ずんだもん', 'VOICEVOX:No.7', 'VOICEVOX:ずんだもん']), ['クレジット：\nVOICEVOX:ずんだもん、No.7']);
  const credits = ['VOICEVOX:Voidoll(CV:丹下桜)', 'VOICEVOX 離途', 'VOICEVOX Nemo', 'VOICEVOX もち子さん(cv明日葉よもぎ)', 'COEIROINK:MANA', 'COEIROINK:つくよみちゃん'];
  const messages = creditMessages(credits);
  assert.ok(messages.every(text => text.length <= 100));
  for (const credit of credits.filter(c => !c.startsWith('COEIROINK:'))) assert.ok(messages.some(text => text.includes(credit)));
  assert.ok(messages.some(text => text.includes('COEIROINK:MANA、つくよみちゃん')));
  const all = Array.from({length: 50}, (_, i) => `VOICEVOX:音声${i}(CV:声優${i})`);
  const chunks = creditMessages(all);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(text => text.startsWith('クレジット：\nVOICEVOX:') && text.length <= 100));
  for (let i = 0; i < 50; i++) assert.ok(chunks.some(text => text.includes(`音声${i}(CV:声優${i})`)));
  assert.throws(() => creditMessages(['VOICEVOX:' + '長'.repeat(100)]), /100文字/);
  assert.equal(voiceCredit({id:20, name:'もち子さん（ノーマル）'}), 'VOICEVOX もち子さん(cv明日葉よもぎ)');
});

test('untrusted credit lines reject controls and oversized batches without truncating formal names', () => {
  for (const control of ['\n', '\r', '\t', '\0', '\u202e', '\u2066', '\u2028']) {
    assert.throws(() => creditMessages([`VOICEVOX:声${control}偽の行`]), /制御文字/);
    assert.throws(() => voiceCredit({id:3, name:`声${control}偽の行`}), /制御文字/);
    assert.throws(() => voiceCredit({credit:`VOICEVOX:声${control}偽の行`}), /制御文字/);
  }
  assert.throws(() => creditMessages(['VOICEVOX:声'], 'クレジット\n偽の見出し'), /制御文字/);
  assert.throws(() => creditMessages(['偽のエンジン:声']), /表記/);
  assert.throws(() => creditMessages(Array(4097).fill('VOICEVOX:声')), /履歴/);
  assert.throws(() => validateCreditMessages(Array(21).fill('クレジット：\nVOICEVOX:声')), /送信件数/);
  assert.throws(() => validateCreditMessages(['長'.repeat(101)]), /文字数/);
  assert.throws(() => creditMessages(['VOICEVOX:声'], '見出し', 101), /文字数/);
});

test('bulk changes group the same voice and sanitize display names; copied credits use the same official form', () => {
  const catalog = [{id:20, name:'もち子さん（ノーマル）'}];
  const messages = voiceChangeMessages(Array.from({length:1000}, () => ({id:20, name:'同名\n\u202eリスナー'})), catalog);
  assert.deepEqual(messages, ['クレジット：音声変更 同名 リスナー ほか999人\nVOICEVOX もち子さん(cv明日葉よもぎ)']);
  assert.ok(speechCredits(catalog).includes(voiceCredit(catalog[0])));
  assert.equal(voiceCredit({id:3, name:'保存済み話者 ID 3'}), '');
});
