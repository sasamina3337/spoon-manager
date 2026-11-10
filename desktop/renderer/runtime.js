import {ChatCommands, parseCommand, helpMessage, voiceListMessage, resolveVoice, chatText, isCommandEnabled} from './background/chat-commands.js';
import {requestSubmission, restoreRequests, setRequestsOpen, submitRequest, updateRequestStatus} from './background/requests.js';
import {executeBoard, boardSummary} from './background/board-games.js';
import {newReversi, newShogi, moveReversi, moveShogi, SHOGI_PIECES} from './background/board-rules.js';
import {boardCoordinate} from './shared/board-coordinates.js';
import {randomInt} from './shared/random.js';
import {automaticText, LEGACY_VOICES, notificationVoiceIds} from './shared/settings.js';
import {drawListeners} from './shared/manager-utils.js';

const obj = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const list = value => Array.isArray(value) ? value : [];
const clone = value => structuredClone(value);
const counterNames = ['diceRolls', 'jankenWins', 'jankenLosses', 'jankenDraws', 'guessPlayed', 'guessCleared', 'reversiPlayed', 'reversiWins', 'reversiLosses', 'reversiDraws', 'shogiPlayed', 'shogiWins', 'shogiLosses', 'shogiDraws'];
export function runtimeSession(raw, key) {
  const session = list(raw.manager?.sessions).find(item => item.key === key);
  if (!session) throw new Error('配信の記録がありません。');
  const saved = obj(raw.runtime?.sessions?.[key]);
  const requests = saved.requests || session.requests;
  return {...clone(session), ...clone(saved), requests: restoreRequests(Array.isArray(requests) ? {items: requests} : requests)};
}
export function assignedSpeaker(raw, userId) {
  const settings = obj(raw.settings), pool = list(settings.commentSpeakers);
  const reserved = notificationVoiceIds(list(raw.runtime?.voices).length ? raw.runtime.voices : LEGACY_VOICES, settings.systemSpeaker);
  const allowed = pool.filter(id => !reserved.includes(id));
  const explicit = raw.runtime?.assignments?.[userId];
  if (Number.isSafeInteger(explicit) && !reserved.includes(explicit)) return explicit;
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(userId)) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return allowed.length ? allowed[hash % allowed.length] : LEGACY_VOICES.find(voice => !reserved.includes(voice.id))?.id ?? 0;
}
export function pollView(poll) {
  if (!poll) return null;
  const votes = Object.values(obj(poll.votes));
  return {...poll, options: poll.options.map((item, index) => ({text: typeof item === 'string' ? item : item.text, count: votes.filter(value => value === index).length})), total: votes.length};
}
export function pollMessage(poll) {
  const view = pollView(poll);
  return view ? `${view.open ? '投票受付中：' : '投票結果：'}${view.question}\n${view.options.map((item, index) => `${index + 1}. ${item.text} ${item.count}票`).join('\n')}\n${view.open ? '/vote 番号 で参加（変更可）' : `合計 ${view.total}票`}` : '投票はまだありません。';
}
function changePoll(session, action, question, options) {
  if (action === 'start') {
    if (session.poll?.open) throw new Error('現在の投票を締め切ってから開始してください。');
    question = String(question || '').trim(); options = list(options).map(value => String(value).trim());
    if (!question || question.length > 60 || options.length < 2 || options.length > 5 || options.some(value => !value || value.length > 24) || new Set(options).size !== options.length) throw new Error('質問は1〜60文字、選択肢は重複なしで2〜5個・各24文字以内で入力してください。');
    session.poll = {question, options, votes: {}, open: true, startedAt: new Date().toISOString()};
  } else if (action === 'end') {
    if (!session.poll?.open) throw new Error('受付中の投票はありません。');
    session.poll.open = false;
  } else throw new Error('投票の操作を確認してください。');
  return pollMessage(session.poll);
}

// Pure game/command rules stay in the renderer. All service requests and durable
// writes cross the typed native facade. The pump also runs while minimized.
export class NativeRuntime {
  constructor({call, snapshot, invalidate, now = Date.now}) {
    Object.assign(this, {call, snapshot, invalidate, now});
    this.chain = Promise.resolve(); this.outbox = Promise.resolve(); this.lastSent = 0; this.queued = 0;
    this.waiters = new Set(); this.generation = 0; this.blockedUntil = 0;
    this.seen = new Map(); this.greetings = new Map(); this.cooldowns = new Map(); this.lastAnnouncement = new Map();
    this.raw = {}; this.warmed = false; this.pumping = false;
    this.portalStatus = {running: false, participants: 0, links: []}; this.portalAck = [];
    this.automation = {paused: false, sent: 0, failed: 0, message: '有効にした自動コメントを待っています。'};
    this.commands = new ChatCommands({getConfig: () => ({...obj(this.raw.manager?.preferences?.commands), enabled: this.raw.manager?.preferences?.features?.chat === true && this.raw.manager?.preferences?.commands?.enabled === true}),
      isCurrent: job => this.raw._native?.receiving && this.raw._native?.activeKey === job.key,
      execute: (job, valid) => this.change(job.key, async (session, runtime, raw) => valid() ? this.execute(job, session, runtime, raw) : null),
      reply: (job, text) => this.send(job.key, text, 'bot', ['weather', '天気'].includes(job.command.name) ? 'weather' : 'other', job.command.name), now, wait: (ms, signal) => this.wait(ms, signal)});
  }
  wait(ms, signal) {
    if (ms <= 0 || signal?.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const waiter = {until: this.now() + ms, done: () => {this.waiters.delete(waiter); signal?.removeEventListener('abort', waiter.done); resolve();}};
      this.waiters.add(waiter); signal?.addEventListener('abort', waiter.done, {once:true});
    });
  }
  wake() {for (const waiter of this.waiters) if (this.now() >= waiter.until) waiter.done();}
  cancel() {this.generation++; this.commands.reset(); for(const waiter of this.waiters) waiter.done();}
  prime(raw) {
    this.cancel();
    this.raw = raw;
    for (const session of list(raw.manager?.sessions)) this.seen.set(session.key, new Set(list(session.events).map(event => event.id)));
    this.warmed = true;
  }
  serial(task) { const result = this.chain.then(task); this.chain = result.catch(() => {}); return result; }
  async change(key, task) {
    return this.serial(async () => {
      const raw = await this.snapshot(true); this.raw = raw;
      const runtime = clone(obj(raw.runtime)); runtime.sessions = obj(runtime.sessions); runtime.assignments = obj(runtime.assignments); runtime.profiles = obj(runtime.profiles);
      const session = runtimeSession(raw, key);
      const result = await task(session, runtime, raw);
      runtime.sessions[key] = {requests: session.requests, poll: session.poll || null, automationPaused: session.automationPaused === true};
      const keys = new Set(list(raw.manager?.sessions).map(item => item.key));
      for (const id of Object.keys(runtime.sessions)) if (!keys.has(id)) delete runtime.sessions[id];
      // Retain the most recently used game profiles; never grow without a bound.
      const profiles = Object.entries(runtime.profiles).sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
      runtime.profiles = Object.fromEntries(profiles.slice(0, 500));
      await this.call('save-runtime', {runtime}); this.invalidate(); this.raw = {...raw, runtime};
      return result;
    });
  }
  current(raw, key) {
    if (!raw._native?.receiving || raw._native.activeKey !== key) throw new Error('受信中の現在の配信を選択してください。');
  }
  async participation(action, payload = {}) {
    if (action === 'start') {const raw = await this.snapshot(true); this.current(raw, raw._native?.activeKey);}
    const result = await this.call('participation', {action, payload});
    if (['start', 'stop', 'status'].includes(action)) this.portalStatus = result;
    if (action === 'start') await this.syncPortal(await this.snapshot(true));
    return result;
  }
  publicState(raw) {
    const key = raw._native?.activeKey, session = key && list(raw.manager?.sessions).some(item => item.key === key) ? runtimeSession(raw, key) : null;
    const games = runtimeBoards(raw, key).map(game => ({...game, userIds: [game.id], names: [game.name, 'ボット']}));
    for (const match of list(raw.runtime?.matches).filter(item => item.key === key)) games.push({id: match.id, kind: match.kind, updatedAt: match.updatedAt || 0, userIds: match.players.map(item => item.id), names: match.players.map(item => item.name), waiting: match.players.length < 2 && !match.game.outcome, ...boardSummary(match.kind, match.game)});
    games.sort((a,b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    return {title: session?.live.title || '配信に参加', requestsOpen: !session?.endedAt && session?.requests.open === true, games, results: obj(raw.runtime?.portalResults)};
  }
  async syncPortal(raw) {
    const key = raw._native?.activeKey;
    const {actions} = await this.call('participation', {action: 'sync', payload: {state: this.publicState(raw), ack: this.portalAck}});
    this.portalAck = [];
    if (!actions?.length || !raw._native?.receiving || !key) return;
    await this.change(key, async (session, runtime, current) => {
      runtime.portalResults = obj(runtime.portalResults); runtime.matches = list(runtime.matches).filter(item => item.key === key).slice(-100);
      for (const action of actions) {
        const user = action.user;
        if (runtime.portalResults[user.id]?.id === action.id) {this.portalAck.push(action.id); continue;}
        try {
          let message = '操作を反映しました。';
          if (action.kind === 'question') {
            if (!session.requests.open || session.endedAt) throw new Error('現在は受付を停止しています。');
            message = submitRequest(session, {id: 'portal:' + action.id, user, time: new Date().toISOString()}, {kind: action.requestKind === 'request' ? 'request' : 'question', text: String(action.text || '').trim()});
          } else if (action.mode === 'pvp' || runtime.matches.some(item => item.kind === action.kind && !item.game.outcome && item.players.some(player => player.id === user.id))) {
            let match = runtime.matches.find(item => item.kind === action.kind && !item.game.outcome && item.players.some(player => player.id === user.id));
            if (action.action === 'start') {
              if (match) throw new Error('進行中の対局があります。');
              match = runtime.matches.find(item => item.kind === action.kind && item.players.length === 1 && !item.game.outcome);
              if (match) match.players.push(user);
              else {match = {id: action.id, kind: action.kind, key, players: [user], game: action.kind === 'shogi' ? newShogi() : newReversi()}; runtime.matches.push(match);}
              message = match.players.length === 2 ? '対局を開始しました。' : '対戦相手を待っています。';
            } else {
              if (!match) throw new Error('対局がありません。');
              const side = match.players[0].id === user.id ? 1 : -1;
              if (action.action === 'end') {match.game.outcome = side === 1 ? 'loss' : 'win'; message = '投了しました。';}
              else {
                if (match.players.length < 2 || match.game.turn !== side) throw new Error('相手の手番を待ってください。');
                (action.kind === 'shogi' ? moveShogi : moveReversi)(match.game, action.move);
              }
            }
            match.updatedAt = this.now();
          } else {
            const profile = runtime.profiles[user.id] ||= {name: user.name, counters: {}};
            profile.name = user.name; profile.updatedAt = this.now(); profile.counters = {...Object.fromEntries(counterNames.map(name => [name, 0])), ...profile.counters};
            let args = [];
            if (action.action === 'start') args = ['start'];
            else if (action.action === 'end') args = ['end'];
            else if (action.kind === 'reversi') args = [boardCoordinate('reversi', action.move)];
            else {
              const move = obj(action.move);
              args = move.drop ? ['drop', SHOGI_PIECES[move.drop], boardCoordinate('shogi', move.to)] : [boardCoordinate('shogi', move.from), boardCoordinate('shogi', move.to), move.promote ? '成' : '不成'];
            }
            const previous = profile[action.kind]?.ply || 0;
            const reply = executeBoard(profile, action.kind, args, key, randomInt);
            if (profile[action.kind]) profile[action.kind].updatedAt = this.now();
            if (action.action === 'move' && previous === (profile[action.kind]?.ply || 0)) throw new Error(Array.isArray(reply) ? reply.join('\n') : reply);
            message = action.action === 'end' ? '投了しました。' : '盤面を更新しました。';
          }
          runtime.portalResults[user.id] = {id: action.id, ok: true, message};
        } catch (error) {runtime.portalResults[user.id] = {id: action.id, ok: false, message: error.message};}
        this.portalAck.push(action.id);
      }
      runtime.portalResults = Object.fromEntries(Object.entries(runtime.portalResults).slice(-500));
    });
    await this.call('participation', {action: 'sync', payload: {state: this.publicState(await this.snapshot(true)), ack: this.portalAck}}); this.portalAck = [];
  }
  async action(input) {
    const raw = await this.snapshot(true), key = input.sessionKey || raw._native?.activeKey;
    if (input.type === 'SET_ASSIGNMENT' || input.type === 'RESET_ASSIGNMENTS' || input.type === 'REFRESH_VOICES') {
      if (input.type === 'REFRESH_VOICES') {
        const voices = await this.call('voice-catalog', {});
        await this.serial(async () => { const latest = await this.snapshot(true); await this.call('save-runtime', {runtime: {...obj(latest.runtime), voices, voiceProvider: latest.settings?.provider, voiceEngineUrl: latest.settings?.engineUrl}}); this.invalidate(); });
        return;
      }
      return this.change(key, (session, runtime) => {
        if (input.type === 'RESET_ASSIGNMENTS') for (const user of session.users) delete runtime.assignments[user.id];
        else {
          if (!session.users.some(user => user.id === input.userId) || !Number.isSafeInteger(input.speaker) || input.speaker < 0) throw new Error('参加者と音声を確認してください。');
          const reserved = notificationVoiceIds(list(raw.runtime?.voices).length ? raw.runtime.voices : LEGACY_VOICES, raw.settings.systemSpeaker);
          if (reserved.includes(input.speaker)) throw new Error('通知用の声はリスナーに割り当てられません。');
          runtime.assignments[input.userId] = input.speaker;
        }
      });
    }
    if (input.type === 'MANAGER_REQUESTS') {
      if (input.action === '受付' && key !== raw._native?.activeKey) throw new Error('現在の配信を選択してください。');
      return this.change(key, session => input.action === '受付' ? setRequestsOpen(session, input.open) : updateRequestStatus(session, input.id, input.status));
    }
    this.current(raw, key);
    if (input.type === 'SET_AUTOMATION_PAUSED') return this.change(key, session => {session.automationPaused = input.paused === true;});
    if (input.type === 'MANAGER_POLL') {
      const message = await this.change(key, session => changePoll(session, input.action, input.question, input.options));
      await this.send(key, message, 'bot'); return;
    }
    throw new Error('操作を確認してください。');
  }
  send(key, text, kind = 'automatic', speechKind = '', commandName = '') {
    if (this.queued >= 16) return Promise.reject(new Error('送信待ちが多いため応答を省略しました。'));
    this.queued++;
    const created = this.now(), generation = this.generation;
    const result = this.outbox.then(async () => {
      if (this.now() < this.blockedUntil) throw Object.assign(new Error('APIの送信制限のため、応答を一時休止しています。'), {status:429, retryAfter:Math.ceil((this.blockedUntil-this.now())/1000)});
      const delay = Math.max(0, 3000 - (this.now() - this.lastSent));
      if (delay) await this.wait(delay);
      if (generation !== this.generation) return;
      const raw = await this.snapshot(true); this.current(raw, key);
      if (commandName && (!isCommandEnabled(raw.manager?.preferences?.commands, commandName) || (kind === 'bot' && !raw.manager?.preferences?.commands?.enabled))) return;
      if (!raw.manager?.preferences?.features?.chat) throw new Error('設定の「チャット送信」を有効にし、DJの同意を取得してください。');
      if (kind === 'automatic' && raw.runtime?.sessions?.[key]?.automationPaused) return;
      if (this.now() - created > 60000) return;
      this.lastSent = this.now();
      await this.call('send-generated', {sessionKey: key, text: chatText(text), kind, speechKind}); this.invalidate();
      if (kind === 'automatic') {this.automation.sent++; this.automation.message = '自動コメントを送信しました。';}
    });
    this.outbox = result.catch(error => { if(error.status===429)this.blockedUntil=Math.max(this.blockedUntil,this.now()+Math.min(3600000,Math.max(30000,(Number(error.retryAfter)||30)*1000))); if (kind === 'automatic') {this.automation.failed++; this.automation.message = error.message;} }).finally(() => {this.queued--;});
    return result;
  }
  async tick() {
    this.wake();
    if (this.pumping) return;
    this.pumping = true;
    try {
      const raw = await this.snapshot(true); this.raw = raw;
      if (!this.warmed) {this.prime(raw); return;}
      const key = raw._native?.activeKey;
      if (!raw._native?.receiving || !key) {this.commands.reset(); return;}
      const session = runtimeSession(raw, key), settings = obj(raw.settings), seen = this.seen.get(key) || new Set(); this.seen.set(key, seen);
      const pending = session.events.filter(event => !seen.has(event.id));
      const automatic = [], commandJobs = [];
      if (pending.length) try {await this.change(key, async (saved, runtime, current) => {
        for (const event of pending) {
          seen.add(event.id);
          if (event.type === 'comment' && event.user) {
            const command = parseCommand(event.text);
            if (command && !isCommandEnabled(current.manager?.preferences?.commands, command.name)) continue;
            const vote = /^\/vote\s+([1-5])$/i.exec(String(event.text).trim());
            if (vote && saved.poll?.open && Number(vote[1]) <= saved.poll.options.length) {
              saved.poll.votes[event.user.id] = Number(vote[1]) - 1; continue;
            }
            const link = /^\/参加\s+([a-f0-9]{10})$/i.exec(String(event.text).trim());
            if (link) {
              try {await this.call('participation', {action: 'link', payload: {code: link[1], user: event.user}}); if (current.manager?.preferences?.features?.chat) automatic.push({text: `${event.user.name}さん、参加ページと連携しました。`, commandName: command.name});}
              catch (error) {if (current.manager?.preferences?.features?.chat) automatic.push({text: error.message, commandName: command.name});}
              continue;
            }
            const submission = requestSubmission(event.text);
            if (submission) {
              const response = submitRequest(saved, event, submission);
              if (current.manager?.preferences?.features?.chat) automatic.push({text: response, commandName: command.name});
            } else commandJobs.push({event, key});
          }
          if (saved.automationPaused || event.isDj || !event.user) continue;
          let config;
          if (event.type === 'entry' && settings.autoGreeting?.enabled) {
            const last = this.greetings.get(event.user.id) ?? -Infinity;
            if (this.now() - last >= (settings.autoGreeting.cooldownSeconds || 0) * 1000) {config = settings.autoGreeting; this.greetings.set(event.user.id, this.now());}
          } else if (['heart', 'spoon'].includes(event.type) && settings.autoReplies?.[event.type]?.enabled) {
            config = settings.autoReplies[event.type];
            if (event.amount !== 0 && Number(event.amount) < (config.minAmount || 1)) config = null;
          }
          if (config) automatic.push(automaticText(event.type === 'heart' && event.amount === 0 ? config.smallGiftTemplate : config.template, {name: event.user.name, amount: event.amount, title: session.live.title}));
        }
      });} catch(error) {for (const event of pending) seen.delete(event.id); throw error;}
      if (seen.size > 12000) this.seen.set(key, new Set(session.events.map(event => event.id)));
      for (const message of automatic) void this.send(key, typeof message === 'string' ? message : message.text, 'automatic', '', message.commandName || '').catch(() => {});
      for (const job of commandJobs) this.commands.accept(job);
      if (this.portalStatus.running) await this.syncPortal(await this.snapshot(true));
      this.automation.paused = session.automationPaused === true;
      const interval = Math.max(1, Number(settings.announcements?.intervalMinutes) || 10) * 60000;
      if (!this.lastAnnouncement.has(key)) this.lastAnnouncement.set(key, this.now());
      if (!session.automationPaused && settings.announcements?.enabled && this.now() - this.lastAnnouncement.get(key) >= interval) {
        this.lastAnnouncement.set(key, this.now());
        void this.send(key, automaticText(settings.announcements.template, {title: session.live.title})).catch(() => {});
      }
    } finally {this.pumping = false;}
  }
  async execute(job, session, runtime, raw) {
    const {name, args} = job.command, event = job.event, user = event.user;
    if (!isCommandEnabled(raw.manager?.preferences?.commands, name)) return null;
    const profile = runtime.profiles[user.id] ||= {name: user.name, counters: {}};
    profile.name = user.name; profile.updatedAt = this.now(); profile.counters = {...Object.fromEntries(counterNames.map(key => [key, 0])), ...profile.counters};
    const djOnly = () => {if (!event.isDj) throw new Error('この操作はDJ専用です。');};
    let voices = list(raw.runtime?.voices).length ? raw.runtime.voices : LEGACY_VOICES;
    const mine = session.users.find(item => item.id === user.id) || {};
    if (name === 'help') return helpMessage(args, raw.manager.preferences.commands.cooldownSeconds);
    if (name === 'stats') return `${session.live.title}\nコメント ${session.totals.comments} / ハート ${session.totals.hearts} / スプーン ${session.totals.spoons}\n検出 ${session.users.length}人`;
    if (name === 'me' || name === 'status') {
      const users = args[0] === 'total' ? list(raw.manager.sessions).filter(item => item.key.slice(0, item.key.lastIndexOf(':')) === session.key.slice(0, session.key.lastIndexOf(':'))).flatMap(item => item.users).filter(item => item.id === user.id) : [mine];
      const total = field => users.reduce((sum, item) => sum + (Number(item[field]) || 0), 0);
      return `${user.name}さん${args[0] === 'total' ? ' 保存分合計' : ' 今回'}\nコメント ${total('comments')} / 入室 ${total('entries')}\nハート ${total('hearts')} / スプーン ${total('spoons')}`;
    }
    if (name === 'rank') {
      const field = {spoon: 'spoons', heart: 'hearts', comment: 'comments'}[args[0] || 'spoon'];
      if (!field) return '/rank spoon|heart|comment';
      return session.users.toSorted((a, b) => b[field] - a[field]).slice(0, 5).map((item, i) => `${i + 1}. ${item.name} ${item[field]}`).join('\n') || '記録はまだありません。';
    }
    if (name === 'goal') {
      if (args.length) {
        djOnly(); const field = {heart: 'heartGoal', spoon: 'spoonGoal'}[args[0]], amount = Number(args[1]);
        if (!field || !Number.isSafeInteger(amount) || amount < 0 || amount > 1e9) return '/goal heart|spoon 0〜1000000000';
        await this.call('save-settings', {settings: raw.settings, preferences: {...raw.manager.preferences, [field]: amount}}); this.invalidate();
        return `目標を ${amount} に変更しました。`;
      }
      return `ハート ${session.totals.hearts}/${raw.manager.preferences.heartGoal}\nスプーン ${session.totals.spoons}/${raw.manager.preferences.spoonGoal}`;
    }
    if (name === 'voice') {
      if (args[0]?.toLowerCase() === 'help') return helpMessage(['voice'], raw.manager.preferences.commands.cooldownSeconds);
      const provider = raw.settings?.provider;
      const engineUrl = raw.settings?.engineUrl;
      const catalogMatchesSettings = list(raw.runtime?.voices).length > 0 && raw.runtime?.voiceProvider === provider &&
        (provider !== 'engine' || raw.runtime?.voiceEngineUrl === engineUrl);
      if (!catalogMatchesSettings) voices = LEGACY_VOICES;
      if (!catalogMatchesSettings) {
        try {
          const refreshed = await this.call('voice-catalog', {});
          if (Array.isArray(refreshed) && refreshed.length) {
            voices = refreshed;
            runtime.voices = voices;
            runtime.voiceProvider = provider;
            runtime.voiceEngineUrl = engineUrl;
          }
        } catch {}
      }
      if (args[0]?.toLowerCase() === 'list') return voiceListMessage(voices, args[1]);
      if (args.length) {
        const result = resolveVoice(voices, args.join(' '), notificationVoiceIds(voices, raw.settings.systemSpeaker));
        if (!result.voice) return result.message;
        runtime.assignments[user.id] = result.voice.id;
      }
      const speaker = assignedSpeaker({...raw, runtime}, user.id);
      return `${user.name}さんの声：${voices.find(voice => voice.id === speaker)?.name || speaker}`;
    }
    if (name === 'dice') {
      const match = /^(\d{1,2})d(\d{1,3})$/i.exec(args[0] || '1d6');
      if (!match || +match[1] < 1 || +match[1] > 5 || +match[2] < 2 || +match[2] > 100) return '/dice 1d6（1〜5個、2〜100面）';
      const rolls = Array.from({length: +match[1]}, () => randomInt(+match[2]) + 1); profile.counters.diceRolls += rolls.length;
      return `${user.name}さん：${rolls.join(' + ')} = ${rolls.reduce((a, b) => a + b, 0)}`;
    }
    if (name === 'omikuji') {
      const date = new Date(this.now() + 9 * 3600000).toISOString().slice(0, 10);
      if (profile.fortune?.date !== date) profile.fortune = {date, result: ['大吉', '中吉', '小吉', '吉', '末吉'][randomInt(5)], color: ['橙', '青', '緑', '白', '赤', '紫'][randomInt(6)], number: randomInt(99) + 1};
      return `${user.name}さん：${profile.fortune.result}\nラッキーカラー ${profile.fortune.color} / 数字 ${profile.fortune.number}`;
    }
    if (name === 'janken') {
      const hands = ['グー', 'チョキ', 'パー'], hand = hands.indexOf(args[0]), bot = randomInt(3);
      if (hand < 0) return '/janken グー|チョキ|パー';
      const outcome = hand === bot ? 'Draws' : (hand + 1) % 3 === bot ? 'Wins' : 'Losses'; profile.counters['janken' + outcome]++;
      return `${user.name}さん：${hands[hand]} / ボット：${hands[bot]}\n${{Wins: 'あなたの勝ち！', Losses: 'ボットの勝ち', Draws: 'あいこ'}[outcome]}`;
    }
    if (name === 'guess') {
      if (args[0] === 'start') { if (profile.guess && profile.guess.expires > this.now()) return '進行中です。/guess 数字 で回答してください。'; profile.guess = {answer: randomInt(20) + 1, remaining: 5, expires: this.now() + 300000}; profile.counters.guessPlayed++; return '1〜20の数を当ててね。/guess 数字（5回・5分以内）'; }
      const game = profile.guess;
      if (!game || game.expires < this.now()) {delete profile.guess; return '/guess start で開始してください。';}
      if (args[0] === 'end') {delete profile.guess; return '数当てを終了しました。';}
      const answer = Number(args[0]); if (!Number.isInteger(answer) || answer < 1 || answer > 20) return '/guess 1〜20';
      if (answer === game.answer) {profile.counters.guessCleared++; delete profile.guess; return '正解！おめでとうございます。';}
      if (--game.remaining === 0) {delete profile.guess; return `残念！正解は ${game.answer} でした。`;}
      return `${answer < game.answer ? 'もっと大きい' : 'もっと小さい'}です。残り${game.remaining}回`;
    }
    if (name === 'game') return `ゲーム成績\nじゃんけん ${profile.counters.jankenWins}勝 ${profile.counters.jankenLosses}敗\n数当て ${profile.counters.guessCleared}/${profile.counters.guessPlayed}クリア\nリバーシ ${profile.counters.reversiWins}勝 / 将棋 ${profile.counters.shogiWins}勝\n/help game で遊び方`;
    if (['shogi', 'reversi'].includes(name)) {const result = executeBoard(profile, name, args, session.key, randomInt); if (profile[name]) profile[name].updatedAt = this.now(); return result;}
    if (name === 'vote') {
      if (!session.poll?.open) return '現在投票は受け付けていません。';
      const choice = Number(args[0]) - 1; if (!Number.isInteger(choice) || choice < 0 || choice >= session.poll.options.length) return `/vote 1〜${session.poll.options.length}`;
      session.poll.votes[user.id] = choice; return `${user.name}さんの ${choice + 1} 番への投票を受け付けました。`;
    }
    if (name === 'poll') {
      if (!args.length) return pollMessage(session.poll);
      djOnly(); if (args[0] === 'end') return changePoll(session, 'end');
      const [question, ...options] = event.text.replace(/^\/poll\s+/i, '').split('|').map(value => value.trim()); return changePoll(session, 'start', question, options);
    }
    if (name === '受付' || name === 'requests') {
      if (!args.length) return session.requests.open ? '質問・リクエスト受付中：/質問 内容 /リクエスト 内容' : '現在受付を停止しています。';
      djOnly(); if (!['開始', 'open', '停止', 'close'].includes(args[0])) return '/受付 開始|停止'; return setRequestsOpen(session, ['開始', 'open'].includes(args[0]));
    }
    if (name === 'draw') {djOnly(); const count = args[0] || '1'; if (!/^[1-5]$/.test(count)) return '/draw 1〜5'; return drawListeners(raw._native.listeners || [], Number(count)).map((item, index) => `${index + 1}. ${item.name}`).join('\n');}
    if (name === 'weather' || name === '天気') {
      const days = {'今日': 0, today: 0, '明日': 1, tomorrow: 1, '明後日': 2}; const day = days[args.at(-1)] ?? 0;
      const place = (Object.hasOwn(days, args.at(-1)) ? args.slice(0, -1) : args).join(' ');
      if (!place) return '/天気 市区町村名 [今日|明日|明後日]';
      const weather = await this.call('weather', {place, day}), daily = weather.daily, code = daily.weather_code[day];
      const description = code === 0 ? '快晴' : code <= 3 ? '晴れ・曇り' : code <= 48 ? '霧' : code <= 67 ? '雨' : code <= 77 ? '雪' : code <= 82 ? 'にわか雨' : code <= 86 ? 'にわか雪' : '雷雨';
      return `${weather.place} ${daily.time[day]}\n${description} ${daily.temperature_2m_min[day]}〜${daily.temperature_2m_max[day]}℃\n降水確率 ${daily.precipitation_probability_max[day] ?? '不明'}%\n出典：${weather.source || 'Open-Meteo / GeoNames'}`;
    }
    if (name === 'play' || name === '質問箱') return this.portalStatus.links.find(link => link.kind === (name === '質問箱' ? 'question' : args[0]))?.url || '配信ツールから参加URLを公開してください。';
    if (name === '参加') return '参加ページの確認コードを指定してください。';
    return 'コマンドを /help で確認してください。';
  }
}

export function runtimeBoards(raw, key) {
  return Object.entries(obj(raw.runtime?.profiles)).flatMap(([id, profile]) => ['shogi', 'reversi'].filter(kind => profile[kind]?.key === key).map(kind => ({id, name: profile.name, kind, updatedAt: profile[kind].updatedAt || 0, ...boardSummary(kind, profile[kind])})));
}
