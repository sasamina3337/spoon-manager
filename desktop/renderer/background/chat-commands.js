import {BOARD_HELP} from './board-games.js';

export const COMMANDS = [
  {name: '参加', usage: '/参加 確認コード', description: '参加ページのコードで自分のSpoonアカウントと紐づける', audience: '全員'},
  {name: 'play', usage: '/play shogi|reversi', description: '公開中のゲーム参加URLを表示', audience: '全員'},
  {name: '質問箱', usage: '/質問箱', description: '公開中の質問箱URLを表示', audience: '全員'},
  {name: '天気', usage: '/天気 地域 [今日|明日|明後日]', description: '指定地域の天気・気温・降水確率（/weather も可）', audience: '全員'},
  {name: 'weather', usage: '/weather 東京 [tomorrow]', description: '地域を指定して天気予報を確認', audience: '全員'},
  {name: '質問', usage: '/質問 内容', description: '受付中の質問一覧へ追加（/question も可）', audience: '全員'},
  {name: 'リクエスト', usage: '/リクエスト 内容', description: '受付中のリクエスト一覧へ追加（/request も可）', audience: '全員'},
  {name: 'question', usage: '/question 内容', description: '質問を送る', audience: '全員'},
  {name: 'request', usage: '/request 内容', description: 'リクエストを送る', audience: '全員'},
  {name: '受付', usage: '/受付 [開始|停止]', description: '受付状況の確認。開始・停止はDJ専用', audience: '確認は全員'},
  {name: 'requests', usage: '/requests [open|close]', description: '受付状況の確認・変更（/受付 と同じ）', audience: '変更はDJのみ'},
  {name: 'help', usage: '/help', description: 'コマンド一覧を表示', audience: '全員'},
  {name: 'stats', usage: '/stats', description: '受信したコメント・ハート・スプーンの集計', audience: '全員'},
  {name: 'me', usage: '/me', description: '自分のコメント・入室・貢献の記録', audience: '全員'},
  {name: 'status', usage: '/status [total]', description: '今回と保存済み配信分の自分の貢献・ゲーム成績', audience: '全員'},
  {name: 'rank', usage: '/rank [spoon|heart|comment]', description: '今回の受信分ランキング', audience: '全員'},
  {name: 'dice', usage: '/dice [2d6]', description: 'サイコロ（1〜5個・2〜100面）', audience: '全員'},
  {name: 'omikuji', usage: '/omikuji', description: '日本時間でその日のおみくじ', audience: '全員'},
  {name: 'janken', usage: '/janken グー|チョキ|パー', description: 'ボットとじゃんけん', audience: '全員'},
  {name: 'guess', usage: '/guess start|数字|end', description: '1〜20の数当て（5回まで・5分）', audience: '全員'},
  {name: 'reversi', usage: '/reversi start|3四|end', description: '縦横の座標でリバーシ。引数なしで盤面', audience: '全員'},
  {name: 'shogi', usage: '/shogi 7七 7六 [成]', description: '/shogi start で開始。漢字の盤面と縦横座標で将棋', audience: '全員'},
  {name: 'game', usage: '/game', description: 'ミニゲームの案内と自分の成績', audience: '全員'},
  {name: 'goal', usage: '/goal', description: 'ハート・スプーンの目標進捗', audience: '全員'},
  {name: 'voice', usage: '/voice [ID・名前]', description: '自分の声を確認、ID・名前・スタイル指定で変更', audience: '全員'},
  {name: 'voice', usage: '/voice list [ページ]', description: '利用可能な声のID・名前・スタイルを一覧表示', audience: '全員'},
  {name: 'draw', usage: '/draw [1〜5]', description: '現在のリスナーから抽選して結果を投稿', audience: 'DJのみ'},
  {name: 'poll', usage: '/poll 質問 | 選択肢1 | 選択肢2', description: '投票開始。/poll end で締切、/poll で集計', audience: '開始・締切はDJのみ'},
  {name: 'vote', usage: '/vote 番号', description: '投票に参加（変更可）', audience: '全員'},
  {name: 'goal', usage: '/goal heart|spoon 数値', description: '目標を変更（0で無効）', audience: 'DJのみ'}
];

export const COMMAND_NAMES = [...new Set(COMMANDS.map(command => command.name))];

// Missing flags keep existing installations' commands enabled.
export function isCommandEnabled(config, name) {
  return config?.enabledByName?.[name] !== false;
}

export const HELP_MESSAGE = 'コマンド\n/stats 集計 /me 自分\n/goal 進捗 /voice 声 /voice list 音声一覧\n/天気 東京 明日\n/dice /omikuji /janken /guess /game\n/reversi /shogi\n/vote 投票 /rank 順位\n/質問 内容 /リクエスト 内容\n/help request 受付\n/help dj DJ専用';

export function helpMessage(args, cooldown) {
  if (args.length > 1) return '/help・/help game・/help status・/help dj から選んでください。';
  if (['shogi', 'reversi'].includes(args[0])) return BOARD_HELP[args[0]];
  if (args[0] === 'voice') return '声の選択\n/voice 今の声を確認\n/voice 四国めたん 名前で選択\n/voice 四国めたん あまあま スタイル指定\n/voice 8 IDで選択\n/voice list [ページ] 一覧\n名前だけならノーマル・ふつうを優先します。通知専用の声は選べません。';
  if (['weather', '天気'].includes(args[0])) return '天気予報（日本時間）\n/天気 東京 [今日|明日|明後日]\n/weather New York tomorrow\n市区町村名で検索し、天気・最低／最高気温・降水確率を表示します。見つからない場合は英語の都市名も試してください。読み上げは設定で選べます。\n出典：Open-Meteo／GeoNames';
  if (args[0] === 'game') return '遊び\n/dice [2d6] サイコロ\n/omikuji 運勢\n/janken グー|チョキ|パー\n/guess start → /guess 1〜20 数当て\n/reversi start リバーシ\n/shogi start 将棋\n/help reversi・/help shogi で操作説明\n/game 自分の成績。無料・景品なし';
  if (args[0] === 'status') return '/status 今回の自分の貢献、/status total 保存済み配信分の合計、/me 自分の記録、/rank spoon|heart|comment 今回の順位。受信・保存できた範囲だけを集計します。';
  if (args[0] === 'request') return '質問・リクエスト受付\n/質問 内容 または /question 内容\n/リクエスト 内容 または /request 内容\n/受付 受付状況\nDJは /受付 開始・/受付 停止\n返信が省略されても受付中の内容は保存します。';
  if (args[0] === 'dj') return 'DJ専用\n/draw [1〜5] 抽選\n/goal heart 1000 ハート目標\n/goal spoon 500 スプーン目標\n/poll 質問 | 選択肢1 | 選択肢2 で投票開始\n/poll end で締切\n/poll で投票集計（全員）\n/受付 開始・/受付 停止';
  if (args.length) return 'そのカテゴリはありません。/help game・/help status・/help dj を使ってください。';
  return `${HELP_MESSAGE}｜応答:${cooldown}秒間隔`;
}

export function parseCommand(text) {
  if (typeof text !== 'string') return null;
  const match = /^\/([a-z]+|質問箱|質問|リクエスト|受付|天気|参加)(?:\s+(.*))?$/is.exec(text.trim());
  if (!match || !COMMANDS.some(command => command.name === match[1].toLowerCase())) return null;
  return {name: match[1].toLowerCase(), args: match[2]?.trim().split(/\s+/).filter(Boolean) || []};
}

export function chatText(text, limit = 200) {
  let result = '';
  for (const char of String(text)) { if (result.length + char.length > limit) break; result += char; }
  return result;
}

function formatBotMessage(text) {
  const message = String(text).replace(/｜/g, '\n').replace(/。(?=\S)/g, '。\n').replace(/：(?=\S)/g, '：\n')
    .replace(/・(?=ハート|スプーン|コメント|入室|検出|数当て)/g, '\n');
  return message.startsWith('/') ? 'ご案内\n' + message : message;
}

export function botMessage(text) {
  return chatText(formatBotMessage(text));
}

export function voiceListMessage(voices, page = '1') {
  if (!/^\d+$/.test(page) || !Number.isSafeInteger(Number(page)) || Number(page) < 1) return '使い方：/voice list [ページ番号（1以上）]';
  if (!voices.length) return '利用可能な音声はありません。読み上げ設定で音声一覧を更新してください。';
  const header = (current, total) => `音声一覧 ${current}/${total}（全${voices.length}件）`;
  const footer = next => `変更: /voice ID・名前${next ? `\n次: /voice list ${next}` : ''}`;
  // Reserve the longest possible page numbers and count formatting before the 200-character limit.
  const fits = rows => formatBotMessage(`${header(voices.length, voices.length)}\n${rows.join('\n')}\n${footer(voices.length)}`).length <= 200;
  const pages = [];
  let rows = [];
  for (const voice of voices) {
    const name = [...voice.name.replace(/\s+/g, ' ').trim()];
    let row = `${voice.id}: ${name.join('')}`;
    while (!fits([row])) {
      name.pop();
      row = `${voice.id}: ${name.join('')}…`;
    }
    if (!fits([...rows, row])) { pages.push(rows); rows = []; }
    rows.push(row);
  }
  pages.push(rows);
  const current = Number(page);
  if (current > pages.length) return `音声一覧は1〜${pages.length}ページです。/voice list ページ番号 で確認してください。`;
  return `${header(current, pages.length)}\n${pages[current - 1].join('\n')}\n${footer(current < pages.length ? current + 1 : null)}`;
}

export function resolveVoice(voices, input, reservedIds = []) {
  const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
  const query = normalize(input);
  const character = voice => normalize(voice.name).replace(/\([^()]*\)$/, '');
  const exact = /^\d+$/.test(query)
    ? voices.filter(voice => voice.id === Number(query) && Number.isSafeInteger(voice.id))
    : voices.filter(voice => normalize(voice.name) === query || normalize(voice.name).replace(/[()]/g, '') === query);
  const candidates = exact.length || /^\d+$/.test(query) ? exact : voices.filter(voice => character(voice) === query);
  if (!candidates.length) return {message: '一致する声がありません。/voice list でID・名前・スタイルを確認してください。'};
  let available = candidates.filter(voice => !reservedIds.includes(voice.id));
  if (!available.length) return {message: '通知専用の声は選べません。/voice list で別の声を選んでください。'};
  if (!exact.length && available.length > 1) {
    const normal = available.filter(voice => /\((ノーマル|ふつう|normal)\)$/.test(normalize(voice.name)));
    if (normal.length === 1) available = normal;
  }
  if (available.length === 1) return {voice: available[0]};
  return {message: chatText('声の候補が複数あります。/voice ID または名前とスタイルで指定してください。\n' + available.slice(0, 3).map(voice => `${voice.id}: ${voice.name}`).join('\n') + '\n一覧: /voice list')};
}

function waitForChat(milliseconds, signal) {
  if (signal.aborted || milliseconds <= 0) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => {clearTimeout(timer); signal.removeEventListener('abort', done); resolve();};
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener('abort', done, {once: true});
  });
}

// One bounded queue for chat commands; never block reading the SSE stream.
export class ChatCommands {
  constructor({getConfig, isCurrent, execute, reply, now = Date.now, wait = waitForChat}) {
    Object.assign(this, {getConfig, isCurrent, execute, reply, now, wait});
    this.users = new Map(); this.lastAccepted = -Infinity; this.lastSent = -Infinity; this.blockedUntil = 0; this.pending = 0;
    this.chain = Promise.resolve(); this.abort = new AbortController();
    this.status = {state: 'idle', message: 'コマンドを待っています。'};
  }

  reset() { this.abort.abort(); this.abort = new AbortController(); }

  accept(input) {
    const config = this.getConfig();
    const command = input.event.type === 'comment' && parseCommand(input.event.text);
    if (!config.enabled || !command) return false;
    if (!isCommandEnabled(config, command.name)) return true;
    const now = this.now(), id = input.event.user?.id;
    if (!id || input.signal?.aborted || !this.isCurrent(input)) return true;
    if (now < this.blockedUntil) return true;
    const cooldown = command.name === 'shogi' ? 6000 : command.name === 'reversi' ? 3000 : config.cooldownSeconds * 1000;
    if (this.pending >= 8 || now - this.lastAccepted < 3000 || now - (this.users.get(id) ?? -Infinity) < cooldown) {
      this.status = {state: 'limited', message: '連投を抑えるため、一部のコマンド応答を省略しました。'};
      return true;
    }
    this.lastAccepted = now; this.users.delete(id); this.users.set(id, now);
    if (this.users.size > 1000) this.users.delete(this.users.keys().next().value);
    const job = {...input, command, createdAt: now, signal: input.signal ? AbortSignal.any([input.signal, this.abort.signal]) : this.abort.signal};
    this.pending++;
    this.chain = this.chain.then(async () => {
      const valid = () => !job.signal.aborted && this.getConfig().enabled && isCommandEnabled(this.getConfig(), command.name) && this.isCurrent(job) && this.now() >= this.blockedUntil && this.now() - job.createdAt < 15000;
      if (!valid()) return;
      const delay = Math.max(0, 3000 - (this.now() - this.lastSent));
      if (delay) await this.wait(delay, job.signal);
      if (!valid()) return;
      this.status = {state: 'working', message: `/${command.name} に応答しています…`};
      const text = await this.execute(job, valid);
      if (!valid() || !text) return;
      const messages = Array.isArray(text) ? text.slice(0, 2) : [text];
      for (const [index, message] of messages.entries()) {
        if (index) {
          const pause = Math.max(0, 3000 - (this.now() - this.lastSent));
          if (pause) await this.wait(pause, job.signal);
        }
        if (!valid()) return;
        this.lastSent = this.now();
        await this.reply(job, botMessage(message));
      }
      if (!job.signal.aborted) this.status = {state: 'ready', message: `/${command.name} に応答しました。`};
    }).catch(error => {
      if (job.signal.aborted) return;
      if (error.status === 429) {
        const delay = Math.min(86400000, Math.max(30000, (Number(error.retryAfter) || 0) * 1000));
        this.blockedUntil = this.now() + delay;
        this.status = {state: 'limited', message: `APIの呼び出し上限のため、コマンド応答を${Math.ceil(delay / 1000)}秒休止します。`};
      } else this.status = {state: 'error', message: '応答できませんでした。チャット送信の同意と配信の状態を確認してください。'};
    }).finally(() => { this.pending--; });
    return true;
  }
}
