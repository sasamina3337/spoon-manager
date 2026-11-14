import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeAdapter} from '../desktop/renderer/native-entry.js';
import {DEFAULT_SETTINGS, LEGACY_VOICES} from '../desktop/renderer/shared/settings.js';
import {SPOON_SCOPES} from '../desktop/renderer/shared/spoon-permissions.js';
import {COMMAND_NAMES, parseCommand} from '../desktop/renderer/background/chat-commands.js';
import {BUILTIN_VOICES, ADDITIONAL_VOICE_TERMS_REVISION} from '../desktop/renderer/shared/builtin-voices.js';

function fixture() {
  let clock = 100000;
  const key = 'api:dj:1', user = {id:'api:dj:u', name:'リスナー'};
  const raw = {settings:{...structuredClone(DEFAULT_SETTINGS), provider:'engine', enabled:false}, manager:{preferences:{heartGoal:100, spoonGoal:100, commands:{enabled:true,cooldownSeconds:10},features:{chat:true}}, sessions:[{key,live:{title:'テスト配信'},users:[{...user,comments:1}],events:[],totals:{comments:1,entries:0,hearts:0,spoons:0,follows:0},requests:{open:false,items:[]}}]},_native:{activeKey:key,receiving:true,authorized:true,connectionState:'connected',listeners:[user],scopes:SPOON_SCOPES.join(' ')}};
  let portalActions=[];
  let voiceCatalog = [{id:2,name:'取得した声'}];
  const calls = [], adapter = createNativeAdapter({now:() => clock, call:async (operation,input) => {
    calls.push({operation,input:structuredClone(input)});
    if (operation === 'snapshot') return structuredClone(raw);
    if (operation === 'save-runtime') raw.runtime = structuredClone(input.runtime);
    if (operation === 'save-settings') {raw.settings=input.settings; raw.manager.preferences=input.preferences;}
    if (operation === 'voice-catalog') return structuredClone(voiceCatalog);
    if (operation === 'manager-action') return input.action === 'fans' ? {fans:[{nickname:'ファン',rank:1}],sessionKey:key} : {listeners:[user]};
    if (operation === 'connection') return {clientId:'id',clientSecret:'secret'};
    if (operation === 'authorization-url') return 'https://developers.spooncast.net/jp/oauth/authorize?state=test';
    if (operation === 'start-receiving') raw._native.receiving=true;
    if (operation === 'stop-receiving') raw._native.receiving=false;
    if (operation === 'participation') {if(input.action==='sync'){portalActions=portalActions.filter(action=>!input.payload.ack.includes(action.id));return {actions:structuredClone(portalActions)};}return {running:true,links:[]};}
    return null;
  }});
  const event = (text, extra={}) => raw.manager.sessions[0].events.push({id:'event:'+raw.manager.sessions[0].events.length,type:'comment',text,user,time:new Date(clock).toISOString(),...extra});
  adapter.runtime.prime(raw);
  return {raw,calls,adapter,user,key,event,portal:action=>portalActions.push(action),setVoiceCatalog:voices=>{voiceCatalog=voices;},advance:() => {clock+=10000;}};
}

async function drainCredits(f) {
  for (let i = 0; i < 100 && f.adapter.runtime.queued; i++) {
    await new Promise(resolve => setImmediate(resolve));
    // Advance only to an actual rate-limit waiter; do not expire queued work.
    if (f.adapter.runtime.waiters.size) { f.advance(); f.adapter.runtime.wake(); }
  }
  await f.adapter.runtime.outbox;
}

test('entry credits follow greetings, retain departed/changed voices, persist and reset for a new broadcast', async () => {
  const f = fixture();
  Object.assign(f.raw.settings, {provider:'builtin', enabled:true, systemSpeaker:0, commentSpeakers:[3], autoGreeting:{enabled:true,template:'{name}さんようこそ',cooldownSeconds:0}});
  f.event('入室', {type:'entry'}); await f.adapter.runtime.tick(); await drainCredits(f);
  let sent = f.calls.filter(c => c.operation === 'send-generated');
  assert.equal(sent[0].input.text, 'リスナーさんようこそ');
  assert.equal(sent[1].input.kind, 'credit');
  assert.equal(sent[1].input.text, 'クレジット：\nVOICEVOX:四国めたん、ずんだもん');
  // An explicit change sends its own compact credit message.
  await f.adapter.message({type:'SET_ASSIGNMENT',userId:f.user.id,speaker:8}); await drainCredits(f);
  sent = f.calls.filter(c => c.operation === 'send-generated');
  assert.match(sent.at(-1).input.text, /クレジット：音声変更 リスナー\nVOICEVOX:春日部つむぎ/);
  f.raw._native.listeners = [];
  f.raw.settings.autoVoiceCredits = false;
  const history = f.raw.runtime.sessions[f.key].voiceCreditHistory;
  assert.ok(history.includes('VOICEVOX:春日部つむぎ') && history.includes('VOICEVOX:ずんだもん'));
  // A reload must not erase the broadcast's history.
  f.adapter.runtime.prime(structuredClone(f.raw));
  const nextUser = {id:'api:dj:new',name:'新しい人'};
  f.raw.manager.sessions[0].users.push(nextUser); f.raw._native.listeners = [nextUser];
  f.raw.settings.autoVoiceCredits = true;
  f.advance(); f.event('入室', {type:'entry',user:nextUser}); await f.adapter.runtime.tick(); await drainCredits(f);
  assert.match(f.calls.filter(c => c.operation === 'send-generated').at(-1).input.text, /春日部つむぎ/);
  const secondKey='api:dj:2';
  f.raw.manager.sessions.push({...structuredClone(f.raw.manager.sessions[0]),key:secondKey,events:[],users:[nextUser]});
  f.raw._native.activeKey=secondKey;
  f.raw.manager.sessions[1].events.push({id:'new-entry',type:'entry',user:nextUser});
  await f.adapter.runtime.tick(); await drainCredits(f);
  assert.doesNotMatch(f.calls.filter(c => c.operation === 'send-generated').at(-1).input.text, /春日部つむぎ/);
});

test('credit OFF stops entry/change posts but retains history; pause, commands and greeting switches are independent', async () => {
  const f=fixture();
  Object.assign(f.raw.settings,{provider:'builtin',enabled:true,systemSpeaker:0,commentSpeakers:[3],autoVoiceCredits:false});
  f.event('入室',{type:'entry'}); await f.adapter.runtime.tick(); await drainCredits(f);
  await f.adapter.message({type:'SET_ASSIGNMENT',userId:f.user.id,speaker:8}); await drainCredits(f);
  assert.equal(f.calls.some(c=>c.operation==='send-generated'),false);
  assert.ok(f.raw.runtime.sessions[f.key].voiceCreditHistory.includes('VOICEVOX:春日部つむぎ'));
  f.raw.settings.autoVoiceCredits=true;
  f.raw.runtime.sessions[f.key].automationPaused=true;
  f.raw.manager.preferences.commands.enabled=false;
  f.advance(); f.event('再入室',{type:'entry'}); await f.adapter.runtime.tick(); await drainCredits(f);
  assert.equal(f.calls.filter(c=>c.operation==='send-generated').length,1);
  assert.equal(f.calls.filter(c=>c.operation==='send-generated')[0].input.kind,'credit');
  f.advance(); f.event('重複しない入室',{type:'entry'}); await f.adapter.runtime.tick();
  // Disabling while waiting must cancel queued credit chunks too.
  f.raw.settings.autoVoiceCredits=false; await drainCredits(f);
  assert.equal(f.calls.filter(c=>c.operation==='send-generated').length,1);
});

test('voice commands filter refreshed and cached personal voices and revoke saved assignments', async () => {
  const f = fixture();
  Object.assign(f.raw.settings, {provider: 'builtin', systemSpeaker: 0, commentSpeakers: [13, 3]});
  f.setVoiceCatalog(BUILTIN_VOICES);
  const run = async text => { f.advance(); f.event(text); await f.adapter.runtime.tick(); await f.adapter.runtime.commands.chain; await f.adapter.runtime.outbox; };
  await run('/voice 13');
  assert.notEqual(f.raw.runtime.assignments[f.user.id], 13);
  Object.assign(f.raw.settings, {avoidRestrictedVoices: false, additionalVoiceTermsAccepted: ADDITIONAL_VOICE_TERMS_REVISION, additionalVoiceUse: 'licensed'});
  await run('/voice 13');
  assert.equal(f.raw.runtime.assignments[f.user.id], 13);
  assert.equal((await f.adapter.message({type: 'GET_STATE'})).participants[0].speaker, 13);
  assert.equal((await f.adapter.message({type: 'SAVE_APP_SETTINGS', settings: {...f.raw.settings, avoidRestrictedVoices: true}, preferences: f.raw.manager.preferences})).ok, true);
  assert.notEqual((await f.adapter.message({type: 'GET_STATE'})).participants[0].speaker, 13);
  assert.equal((await f.adapter.message({type: 'SET_ASSIGNMENT', userId: f.user.id, speaker: 13})).ok, false);
  await run('/voice 青山龍星');
  const reply = f.calls.filter(c => c.operation === 'send-generated').at(-1).input.text;
  assert.match(reply, /一致する声がありません/);
  // A failed catalog refresh must also filter the local fallback.
  f.raw.runtime.voiceProvider = 'engine'; f.setVoiceCatalog([]);
  await run('/voice 13');
  assert.match(f.calls.filter(c => c.operation === 'send-generated').at(-1).input.text, /一致する声がありません/);
});

test('chat voice changes and notification-setting changes publish new credits and retain the previous ones', async () => {
  const f=fixture();
  Object.assign(f.raw.settings,{provider:'builtin',enabled:true,systemSpeaker:0,commentSpeakers:[3]});
  f.setVoiceCatalog(BUILTIN_VOICES);
  f.event('/voice 8'); await f.adapter.runtime.tick();
  await new Promise(resolve=>setImmediate(resolve)); await drainCredits(f); await f.adapter.runtime.commands.chain;
  assert.ok(f.calls.some(c=>c.operation==='send-generated' && c.input.kind==='credit' && /音声変更.*リスナー\nVOICEVOX:春日部つむぎ/.test(c.input.text)));
  const result=await f.adapter.message({type:'SAVE_APP_SETTINGS',settings:{...f.raw.settings,systemSpeaker:1},preferences:f.raw.manager.preferences});
  assert.equal(result.ok,true); await drainCredits(f);
  assert.ok(f.calls.some(c=>c.operation==='send-generated' && c.input.kind==='credit' && /音声変更 通知・返信\nVOICEVOX:ずんだもん/.test(c.input.text)));
  assert.ok(f.raw.runtime.sessions[f.key].voiceCreditHistory.includes('VOICEVOX:四国めたん'));
  assert.ok(f.raw.runtime.sessions[f.key].voiceCreditHistory.includes('VOICEVOX:春日部つむぎ'));
});

test('settings and assignments serialize, recheck the latest reserved voice and preserve both histories', async () => {
  const f = fixture();
  Object.assign(f.raw.settings, {provider:'builtin', enabled:true, systemSpeaker:0, commentSpeakers:[3]});
  // Hold the mutation queue while both UI actions read their initial snapshots.
  let release;
  const held = f.adapter.runtime.serial(() => new Promise(resolve => {release = resolve;}));
  await new Promise(resolve => setImmediate(resolve));
  const save = f.adapter.message({type:'SAVE_APP_SETTINGS', settings:{systemSpeaker:8}});
  const assignment = f.adapter.message({type:'SET_ASSIGNMENT', userId:f.user.id, speaker:8});
  await new Promise(resolve => setImmediate(resolve));
  release(); await held;
  assert.equal((await save).ok, true);
  assert.equal((await assignment).ok, false);
  assert.notEqual(f.raw.runtime.assignments[f.user.id], 8);
  const history = f.raw.runtime.sessions[f.key].voiceCreditHistory;
  assert.ok(history.includes('VOICEVOX:四国めたん'));
  assert.ok(history.includes('VOICEVOX:春日部つむぎ'));
  assert.ok(history.includes('VOICEVOX:ずんだもん'));
  await drainCredits(f);
});

test('invalid credit batches fail before a greeting; cancel during snapshot stops any later send', async () => {
  const f = fixture(), runtime = f.adapter.runtime;
  Object.assign(f.raw.settings, {provider:'builtin', enabled:true});
  await assert.rejects(runtime.send(f.key, {greeting:'ようこそ', messages:['長'.repeat(101)]}, 'credit'), /文字数/);
  await runtime.outbox;
  assert.equal(f.calls.some(c => c.operation === 'send-generated'), false);
  assert.equal(runtime.automation.failed, 1);
  const snapshot = runtime.snapshot;
  let snapshots = 0;
  runtime.snapshot = async (...args) => {
    const raw = await snapshot(...args);
    if (++snapshots === 2) runtime.cancel();
    return raw;
  };
  await runtime.send(f.key, {messages:['クレジット：\nVOICEVOX:ずんだもん']}, 'credit');
  await runtime.outbox;
  assert.equal(f.calls.some(c => c.operation === 'send-generated'), false);
});

test('changing a shared assignment pool posts one credit for the voice, not one per listener', async () => {
  const f = fixture();
  Object.assign(f.raw.settings, {provider:'builtin', enabled:true, systemSpeaker:0, commentSpeakers:[3]});
  const users = Array.from({length:1000}, (_, i) => ({id:`api:dj:user${i}`, name:'リスナー'}));
  f.raw._native.listeners = users;
  f.raw.manager.sessions[0].users = users;
  const result = await f.adapter.message({type:'SAVE_APP_SETTINGS', settings:{commentSpeakers:[8]}});
  assert.equal(result.ok, true);
  await drainCredits(f);
  const credits = f.calls.filter(c => c.operation === 'send-generated');
  assert.equal(credits.length, 1);
  assert.equal(credits[0].input.text, 'クレジット：音声変更 リスナー ほか999人\nVOICEVOX:春日部つむぎ');
});

test('request intake and status changes persist, duplicate events are not processed twice', async () => {
  const f=fixture();
  assert.equal((await f.adapter.message({type:'MANAGER_REQUESTS',sessionKey:f.key,action:'受付',open:true})).ok,true);
  f.event('/質問 おすすめは？'); await f.adapter.runtime.tick(); await f.adapter.runtime.outbox;
  assert.equal(f.raw.runtime.sessions[f.key].requests.items.length,1);
  assert.equal(f.raw.runtime.sessions[f.key].requests.items[0].text,'おすすめは？');
  await f.adapter.runtime.tick();
  assert.equal(f.raw.runtime.sessions[f.key].requests.items.length,1);
  const response=await f.adapter.message({type:'MANAGER_REQUESTS',sessionKey:f.key,action:'status',id:1,status:'done'});
  assert.equal(response.session.requests.items[0].status,'done');
  assert.equal((await f.adapter.message({type:'MANAGER_REQUESTS',sessionKey:f.key,action:'status',id:1,status:'bad'})).ok,false);
});

test('saved individual flags block commands including request intake, voting and participation; ON resumes new events', async () => {
  const f = fixture();
  const flags = Object.fromEntries(COMMAND_NAMES.map(name => [name, false]));
  const saved = await f.adapter.message({type: 'SAVE_MANAGER_PREFS', preferences: {commands: {enabledByName: flags}}});
  assert.equal(saved.ok, true);
  assert.deepEqual((await f.adapter.manager()).preferences.commands.enabledByName, flags);
  await f.adapter.message({type: 'MANAGER_REQUESTS', sessionKey: f.key, action: '受付', open: true});
  // Open a poll through the DJ controls; command flags apply to chat commands.
  await f.adapter.message({type: 'MANAGER_POLL', sessionKey: f.key, action: 'start', question: 'どちら？', options: ['A', 'B']});
  const before = f.calls.length;
  for (const name of COMMAND_NAMES) f.event('/' + name);
  for (const text of ['/質問 本文', '/question body', '/リクエスト 本文', '/request body', '/vote 1', '/参加 abcdef1234']) f.event(text);
  await f.adapter.runtime.tick(); await f.adapter.runtime.commands.chain; await f.adapter.runtime.outbox;
  assert.equal(f.raw.runtime.sessions[f.key].requests.items.length, 0);
  assert.deepEqual(f.raw.runtime.sessions[f.key].poll.votes, {});
  assert.deepEqual(f.raw.runtime.profiles, {});
  assert.equal(f.calls.slice(before).some(call => call.operation === 'send-generated' || call.operation === 'weather' || (call.operation === 'participation' && call.input.action === 'link')), false);
  await f.adapter.message({type: 'SAVE_MANAGER_PREFS', preferences: {commands: {enabledByName: {question: true, vote: true, 参加: true, dice: true}}}});
  for (const text of ['/question new body', '/vote 2', '/参加 abcdef1234', '/dice']) {
    f.advance(); f.event(text);
    await f.adapter.runtime.tick(); await f.adapter.runtime.commands.chain; await f.adapter.runtime.outbox;
  }
  assert.equal(f.raw.runtime.sessions[f.key].requests.items.length, 1);
  assert.equal(f.raw.runtime.sessions[f.key].requests.items[0].text, 'new body');
  assert.equal(f.raw.runtime.sessions[f.key].poll.votes[f.user.id], 1);
  assert.ok(f.calls.some(call => call.operation === 'participation' && call.input.action === 'link'));
  assert.equal(f.raw.runtime.profiles[f.user.id].counters.diceRolls, 1);
  assert.equal(f.raw.manager.preferences.commands.enabledByName.質問, false);
});
test('polls support starting, changing a vote and closing with persisted results', async () => {
  const f=fixture();
  assert.equal((await f.adapter.message({type:'MANAGER_POLL',sessionKey:f.key,action:'start',question:'どちら？',options:['A','B']})).ok,true);
  const run=async text => {f.advance(); f.event(text); await f.adapter.runtime.tick(); await f.adapter.runtime.commands.chain; await f.adapter.runtime.outbox;};
  await run('/vote 1'); await run('/vote 2');
  const state=await f.adapter.manager(); assert.equal(state.session.poll.total,1); assert.equal(state.session.poll.options[1].count,1);
  assert.equal((await f.adapter.message({type:'MANAGER_POLL',sessionKey:f.key,action:'end'})).session.poll.open,false);
});
test('board commands, voices and automated replies are connected to durable native operations', async () => {
  const f=fixture();
  assert.equal(parseCommand('/参加 abcdef1234').name,'参加'); assert.equal(parseCommand('/質問箱').name,'質問箱');
  f.event('/reversi start'); await f.adapter.runtime.tick(); await f.adapter.runtime.commands.chain; await f.adapter.runtime.outbox;
  const board=(await f.adapter.manager()).boards[0]; assert.equal(board.kind,'reversi'); assert.equal(board.legal.length,4);
  assert.equal((await f.adapter.message({type:'SET_ASSIGNMENT',userId:f.user.id,speaker:8})).ok,true);
  assert.equal((await f.adapter.message({type:'GET_STATE'})).participants[0].speaker,8);
  await f.adapter.message({type:'REFRESH_VOICES'}); assert.equal((await f.adapter.message({type:'GET_STATE'})).voices[0].name,'取得した声');
  f.raw.settings.autoGreeting={enabled:true,template:'{name}さんようこそ',cooldownSeconds:300};
  f.advance(); f.event('入室',{type:'entry'}); await f.adapter.runtime.tick(); await f.adapter.runtime.outbox;
  assert.ok(f.calls.some(call=>call.operation==='send-generated' && call.input.text==='リスナーさんようこそ'));
  await f.adapter.message({type:'SET_AUTOMATION_PAUSED',sessionKey:f.key,paused:true});
  f.advance(); f.event('入室',{type:'entry'}); const before=f.calls.filter(call=>call.operation==='send-generated').length;
  await f.adapter.runtime.tick(); await f.adapter.runtime.outbox;
  assert.equal(f.calls.filter(call=>call.operation==='send-generated').length,before);
});

test('voice commands persist name and style selections, retain numeric IDs and preserve assignments on invalid or reserved names', async () => {
  const f = fixture();
  f.setVoiceCatalog([...LEGACY_VOICES, {id: 17, name: '九州そら（ノーマル）'}]);
  f.raw.settings.systemSpeaker = 3;
  const run = async text => {
    f.advance(); f.event(text);
    await f.adapter.runtime.tick(); await f.adapter.runtime.commands.chain; await f.adapter.runtime.outbox;
  };
  await run('/voice 四国めたん');
  assert.equal(f.raw.runtime.assignments[f.user.id], 2);
  assert.equal((await f.adapter.message({type: 'GET_STATE'})).participants[0].speaker, 2);
  assert.match(f.calls.filter(call => call.operation === 'send-generated').at(-1).input.text, /四国めたん（ノーマル）/);
  await run('/voice 四国めたん あまあま');
  assert.equal(f.raw.runtime.assignments[f.user.id], 0);
  await run('/voice 春日部つむぎ（ノーマル）');
  assert.equal(f.raw.runtime.assignments[f.user.id], 8);
  await run('/voice 2');
  assert.equal(f.raw.runtime.assignments[f.user.id], 2);
  await run('/voice 九州そら');
  assert.equal(f.raw.runtime.assignments[f.user.id], 17);
  await run('/voice 17');
  assert.equal(f.raw.runtime.assignments[f.user.id], 17);
  await run('/voice list');
  assert.match(f.calls.filter(call => call.operation === 'send-generated').at(-1).input.text, /音声一覧 1\//);
  await run('/voice help');
  assert.match(f.calls.filter(call => call.operation === 'send-generated').at(-1).input.text, /\/voice 四国めたん/);
  assert.equal(f.calls.filter(call => call.operation === 'voice-catalog').length, 1);
  for (const query of ['知らない声', 'ずんだもん', 'ずんだもん あまあま']) {
    await run('/voice ' + query); assert.equal(f.raw.runtime.assignments[f.user.id], 17);
  }
  f.raw.runtime.voices = [{id: 40, name: '候補の声（やさしい）'}, {id: 41, name: '候補の声（元気）'}];
  await run('/voice 候補の声');
  assert.equal(f.raw.runtime.assignments[f.user.id], 17);
  assert.match(f.calls.filter(call => call.operation === 'send-generated').at(-1).input.text, /候補が複数/);
});
test('chat short codes persist canonical COEIROINK assignments and hide notification voices', async () => {
  const f = fixture();
  const id = 'coeiroink:292ea286-3d5f-4fcc-957c-66462a6a9d08:47';
  f.raw.settings.coeiroinkDirectEnabled = true;
  f.raw.settings.systemSpeaker = 3;
  f.setVoiceCatalog([...LEGACY_VOICES, {id, name: 'COEIROINK:MANA（のーまる）'}]);
  const run = async text => {
    f.advance(); f.event(text);
    await f.adapter.runtime.tick(); await f.adapter.runtime.commands.chain; await f.adapter.runtime.outbox;
    return f.calls.filter(call => call.operation === 'send-generated').at(-1).input.text;
  };
  await f.adapter.message({type: 'REFRESH_VOICES'});
  const pages = Number(/音声一覧 1\/(\d+)/.exec(await run('/voice list'))[1]);
  let list = '';
  for (let page = 1; page <= pages; page++) list += await run('/voice list ' + page);
  assert.match(list, /C47: MANA（のーまる）/);
  assert.doesNotMatch(list, /coeiroink:|ずんだもん/i);
  assert.match(await run('/voice C47'), /番号: C47/);
  assert.equal(f.raw.runtime.assignments[f.user.id], id);
  assert.equal((await f.adapter.message({type: 'GET_STATE'})).participants[0].speaker, id);
  const current = await run('/voice');
  assert.match(current, /MANA（のーまる）/);
  assert.match(current, /番号: C47/);
  assert.doesNotMatch(current, /292ea286/);
  assert.match(await run('/voice 3'), /通知専用/);
  assert.equal(f.raw.runtime.assignments[f.user.id], id);
});

test('receive prompts for authorization before connecting, then resumes automatically', async () => {
  const f=fixture(); f.raw._native.authorized=false; f.raw._native.receiving=false;
  assert.equal((await f.adapter.message({type:'CONNECT_SPOON'})).needsAuthorization,true);
  assert.equal(f.calls.some(call=>call.operation==='start-receiving'),false);
  f.raw._native.authorized=true; await f.adapter.pump();
  assert.equal(f.calls.filter(call=>call.operation==='start-receiving').length,1);
  await f.adapter.message({type:'DISCONNECT_SPOON'}); assert.equal(f.raw._native.receiving,false);
});
test('verified portal players can match, move and resign without chat-send permission', async () => {
  const f=fixture();f.raw.manager.preferences.features.chat=false;
  const second={id:'api:dj:v',name:'対戦相手'};
  const act=async (user,action,extra={})=>{f.advance();f.portal({id:String(Date.now())+String(Math.random()),kind:'reversi',action,user,...extra});await f.adapter.runtime.syncPortal(structuredClone(f.raw));};
  await act(f.user,'start',{mode:'pvp'}); assert.equal(f.raw.runtime.matches[0].players.length,1);
  await act(second,'start',{mode:'pvp'}); assert.equal(f.raw.runtime.matches[0].players.length,2);
  const view=f.adapter.runtime.publicState(f.raw).games[0];
  await act(second,'move',{move:view.legal[0]});assert.equal(f.raw.runtime.matches[0].game.ply,0); assert.equal(f.raw.runtime.portalResults[second.id].ok,false);
  await act(f.user,'move',{move:view.legal[0]});assert.equal(f.raw.runtime.matches[0].game.ply,1);
  await act(second,'end');assert.equal(f.raw.runtime.matches[0].game.outcome,'win');
  assert.equal(f.calls.some(call=>call.operation==='send-generated'),false);
});
test('permission failures do not reopen the login browser on every background pulse', async () => {
  const f=fixture();f.raw._native.receiving=false;f.raw._native.connectionState='unauthorized';f.raw._native.authorizationCompleted=1;
  await f.adapter.message({type:'CONNECT_SPOON'});await f.adapter.pump();await f.adapter.pump();
  assert.equal(f.calls.filter(call=>call.operation==='authorization-url').length,1);
  assert.equal(f.calls.some(call=>call.operation==='start-receiving'),false);
  f.raw._native.authorizationCompleted=2;f.raw._native.connectionState='stopped';await f.adapter.pump();
  assert.equal(f.calls.filter(call=>call.operation==='start-receiving').length,1);
});

test('receive upgrades existing partial consent once and waits for a new full grant', async () => {
  const f = fixture();
  f.raw._native.receiving = false;
  f.raw._native.authorizationCompleted = 4;
  f.raw._native.scopes = 'me.read live.read events.chat donations.read.extra';
  assert.equal((await f.adapter.message({type: 'CONNECT_SPOON'})).needsAuthorization, true);
  await f.adapter.pump(); await f.adapter.pump();
  assert.equal(f.calls.filter(call => call.operation === 'authorization-url').length, 1);
  assert.equal(f.calls.filter(call => call.operation === 'start-receiving').length, 0);
  f.raw._native.scopes = SPOON_SCOPES.join(' ');
  f.raw._native.authorizationCompleted = 5;
  await f.adapter.pump(); await f.adapter.pump();
  assert.equal(f.calls.filter(call => call.operation === 'start-receiving').length, 1);
});

test('an incomplete new grant reports missing permissions without opening a browser loop', async () => {
  const f = fixture();
  f.raw._native.receiving = false; f.raw._native.authorizationCompleted = 1;
  f.raw._native.scopes = SPOON_SCOPES.filter(scope => scope !== 'donations.read').join(' ');
  await f.adapter.message({type: 'CONNECT_SPOON'});
  f.raw._native.authorizationCompleted = 2;
  await assert.rejects(f.adapter.pump(), /donations.read/);
  await f.adapter.pump(); await f.adapter.pump();
  assert.equal(f.calls.filter(call => call.operation === 'authorization-url').length, 1);
  assert.equal(f.calls.filter(call => call.operation === 'start-receiving').length, 0);
});

test('a saved complete grant starts receiving without requesting consent again', async () => {
  const f = fixture(); f.raw._native.receiving = false;
  assert.equal((await f.adapter.message({type: 'CONNECT_SPOON'})).ok, true);
  assert.equal(f.calls.filter(call => call.operation === 'start-receiving').length, 1);
  assert.equal(f.calls.filter(call => call.operation === 'authorization-url').length, 0);
});
