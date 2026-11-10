import test from 'node:test';
import assert from 'node:assert/strict';
import {ChatCommands, COMMAND_NAMES, HELP_MESSAGE, helpMessage, parseCommand, chatText, botMessage, voiceListMessage, resolveVoice} from '../desktop/renderer/background/chat-commands.js';

test('commands require a whole slash-prefixed message; replies never trigger another command', () => {
  assert.deepEqual(parseCommand(' /VOICE  3 '), {name: 'voice', args: ['3']});
  for (const text of ['hello /help', '/helpful', '/unknown', '/uptime', 'https://example.com/help', HELP_MESSAGE]) assert.equal(parseCommand(text), null);
  assert.deepEqual(parseCommand('/voice list 2'), {name: 'voice', args: ['list', '2']});
  assert.equal(HELP_MESSAGE.includes('/uptime'), false);
  assert.ok(HELP_MESSAGE.includes('/voice list'));
  assert.deepEqual(parseCommand('/goal heart 100'), {name: 'goal', args: ['heart', '100']});
  assert.equal(chatText('😀'.repeat(101)).length, 200);
  assert.equal(HELP_MESSAGE.length <= 200, true);
});

test('DJ operations appear only in DJ help and the general help retains its complete DJ help link', () => {
  for (const args of [[], ['game'], ['status'], ['shogi'], ['reversi']]) {
    const text = helpMessage(args, 120);
    assert.doesNotMatch(text, /\/draw|\/poll|\/goal (?:heart|spoon)/);
  }
  const general = helpMessage([], 120);
  assert.ok(general.length <= 200);
  assert.ok(botMessage(general).includes('/help dj DJ専用'));
  assert.ok(general.includes('/goal 進捗'));
  const dj = helpMessage(['dj'], 120);
  assert.ok(dj.length <= 200);
  for (const command of ['/draw', '/goal heart', '/goal spoon', '/poll', '/poll end']) assert.ok(botMessage(dj).includes(command));
});

test('voice list pages include every ID, full name and style within the chat limit', () => {
  const voices = Array.from({length: 30}, (_, id) => ({id: id * 3, name: `音声キャラクター${id}（ノーマル）`}));
  const first = botMessage(voiceListMessage(voices));
  const total = Number(/音声一覧 1\/(\d+)/.exec(first)[1]);
  assert.ok(total > 1);
  const entries = [];
  for (let page = 1; page <= total; page++) {
    const reply = botMessage(voiceListMessage(voices, String(page)));
    assert.ok(reply.length <= 200);
    assert.ok(reply.includes(`音声一覧 ${page}/${total}（全30件）`));
    assert.ok(reply.includes('変更: /voice ID・名前'));
    assert.equal(reply.includes(`次: /voice list ${page + 1}`), page < total);
    assert.equal(parseCommand(reply), null);
    entries.push(...reply.split('\n').filter(line => /^\d+: /.test(line)));
  }
  assert.deepEqual(entries, voices.map(voice => `${voice.id}: ${voice.name}`));
  assert.match(voiceListMessage(voices, String(total + 1)), /1〜\d+ページ/);
});

test('voice list handles invalid pages, empty catalogs and unusually long Unicode names', () => {
  for (const page of ['0', '-1', '1.5', 'abc', '9007199254740992']) assert.match(voiceListMessage([], page), /使い方/);
  assert.match(voiceListMessage([]), /利用可能な音声はありません/);
  const voices = [{id: 9007199254740991, name: '😀。声：｜'.repeat(30)}, {id: 0, name: '次の声（ノーマル）'}];
  const first = botMessage(voiceListMessage(voices));
  assert.ok(first.length <= 200);
  assert.match(first, /9007199254740991: /);
  assert.match(first, /…/);
  assert.ok(first.endsWith('次: /voice list 2'));
  const last = botMessage(voiceListMessage(voices, '2'));
  assert.ok(last.length <= 200);
  assert.match(last, /0: 次の声（ノーマル）/);
  assert.ok(last.endsWith('変更: /voice ID・名前'));
});

test('voice names select a normal style while full names, spaced styles and numeric IDs select the requested voice', () => {
  const voices = [{id: 0, name: '四国めたん（あまあま）'}, {id: 2, name: '四国めたん（ノーマル）'},
    {id: 8, name: '春日部つむぎ（ささやき）'}, {id: 10, name: '白上虎太郎（ふつう）'},
    {id: 12, name: 'Alice Smith (Normal)'}, {id: 13, name: 'Alice Smith (Happy)'}];
  for (const input of ['四国めたん', '四国めたん ノーマル', '四国めたん(ノーマル)', '2', '２']) assert.equal(resolveVoice(voices, input).voice.id, 2, input);
  for (const input of ['四国めたん あまあま', '四国めたん（あまあま）', ' 四国めたん　( あまあま ) ']) assert.equal(resolveVoice(voices, input).voice.id, 0, input);
  assert.equal(resolveVoice(voices, '春日部つむぎ').voice.id, 8);
  assert.equal(resolveVoice(voices, '白上虎太郎').voice.id, 10);
  assert.equal(resolveVoice(voices, 'ALICE　SMITH').voice.id, 12);
  assert.equal(resolveVoice(voices, 'Alice Smith Happy').voice.id, 13);
  assert.match(helpMessage(['voice'], 10), /\/voice 四国めたん/);
  assert.ok(botMessage(helpMessage(['voice'], 10)).length <= 200);
});

test('ambiguous names, unknown names and reserved voices never resolve to an arbitrary voice', () => {
  const voices = [{id: 0, name: '四国めたん（あまあま）'}, {id: 6, name: '四国めたん（ささやき）'}];
  const ambiguous = resolveVoice(voices, '四国めたん');
  assert.equal(ambiguous.voice, undefined);
  assert.match(ambiguous.message, /候補が複数/);
  assert.match(ambiguous.message, /0: 四国めたん/);
  assert.match(ambiguous.message, /6: 四国めたん/);
  for (const query of ['四国', '知らない声', '0 お願い', '99']) {
    assert.equal(resolveVoice(voices, query).voice, undefined);
    assert.match(resolveVoice(voices, query).message, /一致する声がありません/);
  }
  for (const query of ['四国めたん', '四国めたん あまあま', '6']) {
    const result = resolveVoice(voices, query, [0, 6]);
    assert.equal(result.voice, undefined); assert.match(result.message, /通知専用/);
  }
});

function fixture(extra = {}) {
  let now = 100000, enabled = true;
  const replies = [];
  const commands = new ChatCommands({getConfig: () => ({enabled, cooldownSeconds: 10}), isCurrent: () => true,
    execute: async () => HELP_MESSAGE, reply: async (job, text) => replies.push(text), now: () => now, wait: async ms => {now += ms;}, ...extra});
  const input = (user = 'a', text = '/help') => ({key: 'room', event: {type: 'comment', user: {id: user}, text}});
  return {commands, replies, input, advance: ms => { now += ms; }, disable: () => { enabled = false; }};
}

test('per-user and global cooldowns prevent floods while later requests work', async () => {
  const app = fixture();
  assert.equal(app.commands.accept(app.input()), true); await app.commands.chain;
  app.commands.accept(app.input('b')); await app.commands.chain;
  assert.equal(app.replies.length, 1);
  app.advance(3000); app.commands.accept(app.input('a')); await app.commands.chain;
  assert.equal(app.replies.length, 1);
  app.commands.accept(app.input('b')); await app.commands.chain;
  assert.equal(app.replies.length, 2);
  app.advance(10000); app.commands.accept(app.input('a')); await app.commands.chain;
  assert.equal(app.replies.length, 3);
});

test('individual OFF flags block every command without consuming other commands cooldowns', async () => {
  const flags = Object.fromEntries(COMMAND_NAMES.map(name => [name, false]));
  let calls = 0;
  const app = fixture({getConfig: () => ({enabled: true, cooldownSeconds: 10, enabledByName: flags}), execute: async () => {calls++; return '応答';}});
  for (const name of COMMAND_NAMES) app.commands.accept(app.input('a', '/' + name));
  await app.commands.chain;
  assert.equal(calls, 0); assert.equal(app.replies.length, 0); assert.equal(app.commands.pending, 0);
  flags.dice = true;
  app.commands.accept(app.input('a', '/dice')); await app.commands.chain;
  assert.equal(calls, 1); assert.equal(app.replies.length, 1);
});

test('turning a command OFF cancels queued work and suppresses an in-flight reply', async () => {
  let enabled = true, finish, calls = 0;
  const app = fixture({getConfig: () => ({enabled: true, cooldownSeconds: 10, enabledByName: {help: enabled}}),
    execute: () => {calls++; return new Promise(resolve => {finish = resolve;});}});
  app.commands.accept(app.input()); enabled = false; await app.commands.chain;
  assert.equal(calls, 0);
  enabled = true; app.advance(11000); app.commands.accept(app.input()); await Promise.resolve();
  enabled = false; finish('応答'); await app.commands.chain;
  assert.equal(calls, 1); assert.equal(app.replies.length, 0);
});

test('disabling, aborting or changing rooms during async commands prevents a late reply', async () => {
  for (const reason of ['disabled', 'abort', 'reset', 'stale', 'expired']) {
    let finish, current = true;
    const app = fixture({execute: () => new Promise(resolve => { finish = resolve; }), isCurrent: () => current});
    const abort = new AbortController();
    app.commands.accept({...app.input(), signal: abort.signal});
    await Promise.resolve();
    if (reason === 'disabled') app.disable();
    if (reason === 'abort') abort.abort();
    if (reason === 'reset') app.commands.reset();
    if (reason === 'stale') current = false;
    if (reason === 'expired') app.advance(16000);
    finish(HELP_MESSAGE); await app.commands.chain;
    assert.equal(app.replies.length, 0, reason);
  }
});

test('errors do not retry or poison subsequent commands; normal chat is ignored', async () => {
  let calls = 0;
  const app = fixture({reply: async () => { calls++; if (calls === 1) throw new Error('403'); }});
  assert.equal(app.commands.accept(app.input('a', '普通のコメント')), false);
  app.commands.accept(app.input()); await app.commands.chain;
  assert.equal(app.commands.status.state, 'error'); assert.equal(calls, 1);
  app.advance(11000); app.commands.accept(app.input()); await app.commands.chain;
  assert.equal(calls, 2); assert.equal(app.commands.status.state, 'ready');
});

test('429 stops later command requests for Retry-After and never retries the failed reply', async () => {
  let calls = 0;
  const app = fixture({reply: async () => {
    calls++; if (calls === 1) throw Object.assign(new Error('limited'), {status: 429, retryAfter: 60});
  }});
  app.commands.accept(app.input()); await app.commands.chain;
  assert.equal(calls, 1);
  app.advance(11000); app.commands.accept(app.input()); await app.commands.chain;
  assert.equal(calls, 1);
  app.commands.reset(); // Restarting a stream must not bypass the API cooldown.
  app.commands.accept(app.input()); await app.commands.chain; assert.equal(calls, 1);
  app.advance(60000); app.commands.accept(app.input()); await app.commands.chain;
  assert.equal(calls, 2);
});

test('slow commands cannot release multiple queued replies at once', async () => {
  let release;
  let count = 0;
  const waited = [];
  const app = fixture({wait: async ms => {waited.push(ms); app.advance(ms);}, execute: async () => {
    count++; if (count === 1) await new Promise(resolve => { release = resolve; }); return HELP_MESSAGE;
  }});
  app.commands.accept(app.input('a')); await Promise.resolve();
  app.advance(3000); app.commands.accept(app.input('b'));
  release(); await app.commands.chain;
  assert.equal(app.replies.length, 2); assert.deepEqual(waited, [3000]);
});

test('split shogi boards send in order three seconds apart and enforce six seconds before another move', async () => {
  const waited = [];
  const app = fixture({wait: async ms => {waited.push(ms); app.advance(ms);}, execute: async () => ['将棋 上段', '将棋 下段']});
  app.commands.accept(app.input('a', '/shogi start')); await app.commands.chain;
  assert.deepEqual(app.replies, ['将棋 上段', '将棋 下段']); assert.deepEqual(waited, [3000]);
  app.commands.accept(app.input('a', '/shogi 7七 7六')); await app.commands.chain;
  assert.equal(app.replies.length, 2);
  app.advance(3000); app.commands.accept(app.input('a', '/shogi 7七 7六')); await app.commands.chain;
  assert.equal(app.replies.length, 4); assert.deepEqual(waited, [3000, 3000]);
});

test('reset interrupts the wait for a second board message without sending the stale half', async () => {
  const app = fixture({execute: async () => ['将棋 上段', '将棋 下段'], wait: undefined});
  app.commands.accept(app.input('a', '/shogi start'));
  for (let i = 0; i < 10 && !app.replies.length; i++) await Promise.resolve();
  assert.equal(app.replies.length, 1); app.commands.reset(); await app.commands.chain;
  assert.deepEqual(app.replies, ['将棋 上段']); assert.equal(app.commands.pending, 0);
});

test('a failed second board message is not retried and still applies the API backoff', async () => {
  let calls = 0;
  const app = fixture({execute: async () => ['将棋 上段', '将棋 下段'], reply: async () => {
    calls++; if (calls === 2) throw Object.assign(new Error('rate limit'), {status: 429, retryAfter: 60});
  }});
  app.commands.accept(app.input('a', '/shogi start')); await app.commands.chain;
  assert.equal(calls, 2); assert.equal(app.commands.status.state, 'limited');
  app.advance(7000); app.commands.accept(app.input('a', '/shogi')); await app.commands.chain; assert.equal(calls, 2);
});
