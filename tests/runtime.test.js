import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeAdapter} from '../desktop/renderer/native-entry.js';
import {DEFAULT_SETTINGS} from '../desktop/renderer/shared/settings.js';
import {SPOON_SCOPES} from '../desktop/renderer/shared/spoon-permissions.js';
import {COMMAND_NAMES, parseCommand} from '../desktop/renderer/background/chat-commands.js';

function fixture() {
  let clock = 100000;
  const key = 'api:dj:1', user = {id:'api:dj:u', name:'リスナー'};
  const raw = {settings:{...structuredClone(DEFAULT_SETTINGS), enabled:false}, manager:{preferences:{heartGoal:100, spoonGoal:100, commands:{enabled:true,cooldownSeconds:10},features:{chat:true}}, sessions:[{key,live:{title:'テスト配信'},users:[{...user,comments:1}],events:[],totals:{comments:1,entries:0,hearts:0,spoons:0,follows:0},requests:{open:false,items:[]}}]},_native:{activeKey:key,receiving:true,authorized:true,connectionState:'connected',listeners:[user],scopes:SPOON_SCOPES.join(' ')}};
  let portalActions=[];
  const calls = [], adapter = createNativeAdapter({now:() => clock, call:async (operation,input) => {
    calls.push({operation,input:structuredClone(input)});
    if (operation === 'snapshot') return structuredClone(raw);
    if (operation === 'save-runtime') raw.runtime = structuredClone(input.runtime);
    if (operation === 'save-settings') {raw.settings=input.settings; raw.manager.preferences=input.preferences;}
    if (operation === 'voice-catalog') return [{id:2,name:'取得した声'}];
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
  return {raw,calls,adapter,user,key,event,portal:action=>portalActions.push(action),advance:() => {clock+=10000;}};
}

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
