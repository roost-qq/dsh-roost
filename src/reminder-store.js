/**
 * 她的小闹钟 · 数据层（A1）——移植自 aurabot-beta `src/purpose/module.js` 小闹钟段。
 * MIT License, Copyright (c) 2026 Aurabot contributors；本仓 AGPL-3.0，署名见
 * THIRD-PARTY-NOTICES.md。函数体口径与对方一致，只把 readJson/writeJson 指向
 * 本仓语义等价的 autotelic-store.js。
 *
 * 每条提醒带 `chatId`（在哪个私聊设的，到点就往那个私聊说）；老记录没有这个
 * 字段时回落主人。到点先注入一轮真会话让她自己决定说不说，再把她真说的话
 * 经 `sendOut` 投递到 QQ——DSH 会话本身到不了 QQ（见 host.js fireReminder）。
 * 纯函数 + 注入式依赖，可单测。
 */

import { readJson, writeJson } from './autotelic-store.js';

export const REMINDER_GRACE_MS = 15 * 60_000;
export const REMINDER_RETRY_MS = 5 * 60_000;
export const REMINDER_WAIT_MS = 4 * 60_000;

const DAY_MS = 86_400_000;
/** 周期闹钟没设 until 时的存活上限：足够长，别让停机几天就被 prune 误删 */
const PERIODIC_LIFETIME_MS = 365 * DAY_MS;
const REPEATS = new Set(['none', 'daily', 'weekdays', 'interval']);

const two = (n) => String(n).padStart(2, '0');

/** 星期输入：数组或 "1,3,5" → 去重排序的 0–6 整数数组（0=周日） */
export function normalizeWeekdays(raw) {
  const flat = Array.isArray(raw) ? raw.join(',') : String(raw ?? '');
  const out = [];
  for (const part of flat.split(/[,，\s]+/)) {
    if (!part) continue;
    const n = Number(part);
    if (Number.isInteger(n) && n >= 0 && n <= 6 && !out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

/**
 * 纯函数：算出周期闹钟触发后的下一次时刻。
 * - daily：同一 HH:MM，跳到下一个匹配星期（weekdays 空 = 每天）
 * - weekdays：周一到周五的同一 HH:MM
 * - interval：从原 at 起每次加 intervalMin；落后太多则改从 now 起一枪（不补一堆）
 * - none：返回 0（由调用方删除）
 */
export function nextReminderOccurrence(r, after = Date.now()) {
  const rep = REPEATS.has(String(r?.repeat || '')) ? String(r.repeat) : 'none';
  if (rep === 'none') return 0;
  const at = Number(r?.at) || Number(after);
  if (rep === 'interval') {
    const stepMs = Math.max(1, Math.min(10080, Math.round(Number(r?.intervalMin) || 60))) * 60_000;
    /**
     * 在原 at 的相位格点上推进，不能用 `after + step`——after 含整轮会话耗时，
     * 逐轮叠加会让「每 5 分钟」漂成 5+耗时、10+2×耗时……回执却还说每 5 分钟。
     * k = floor((after-at)/step)+1 保证落在 after 之后的第一个格点（不补发过去的）。
     */
    const elapsed = Math.max(0, Number(after) - at);
    const k = Math.floor(elapsed / stepMs) + 1;
    return at + k * stepMs;
  }
  const wd = rep === 'weekdays' ? [1, 2, 3, 4, 5] : normalizeWeekdays(r?.weekdays);
  const base = new Date(at);
  const hh = base.getHours(), mm = base.getMinutes();
  /**
   * 从 after 那天起找，不是从 at 起——停机/关闭多日后 at 早已过去，
   * 从 at 逐日 +1 会返回过去时刻，导致心跳每分钟触发、逐日追平刷屏。
   * 锚定 after 一次跳到「现在之后的下一个合法时刻」，不补发过去的。
   */
  const anchor = Math.max(Number(at), Number(after));
  for (let add = 0; add <= 7; add += 1) {
    const cand = new Date(anchor);
    cand.setDate(cand.getDate() + add);
    cand.setHours(hh, mm, 0, 0);
    if (cand.getTime() <= Number(after)) continue;
    if (!wd.length || wd.includes(cand.getDay())) return cand.getTime();
  }
  /** 理论上到不了（7 天覆盖所有星期），兜底也保证 > after */
  return Number(after) + DAY_MS;
}

/** 面板/工具回执里描述重复节奏的一句话 */
export function repeatText(r) {
  const rep = String(r?.repeat || 'none');
  if (rep === 'daily') {
    const wd = normalizeWeekdays(r?.weekdays);
    const names = ['日', '一', '二', '三', '四', '五', '六'];
    return wd.length ? `每周${wd.map((d) => names[d]).join('、')}` : '每天';
  }
  if (rep === 'weekdays') return '每个工作日';
  if (rep === 'interval') return `每 ${Math.max(1, Math.min(10080, Math.round(Number(r?.intervalMin) || 60)))} 分钟`;
  return '';
}

/** 时间戳 → `yyyy-mm-dd HH:MM` 本地时间 */
export function reminderText(at) {
  const d = new Date(at);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** 中文数字/阿拉伯数字 → 数值；认不出来返回 NaN */
function cnNum(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return NaN;
  if (/^\d+$/.test(s)) return Number(s);
  const digits = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (digits[s] !== undefined) return digits[s];
  const teen = /^十([一二三四五六七八九])$/.exec(s);
  if (teen) return 10 + digits[teen[1]];
  const tens = /^([一二三四五六七八九])十([一二三四五六七八九])?$/.exec(s);
  if (tens) return digits[tens[1]] * 10 + (tens[2] ? digits[tens[2]] : 0);
  return NaN;
}

/**
 * 相对时间：`一分钟后 / 半小时后 / 两小时 / 30秒后` 这类。
 * 返回绝对毫秒（保留秒精度），认不出来返回 0。
 */
function parseRelativeTime(value, base) {
  const s = String(value || '').trim().replace(/\s+/g, '');
  if (!s) return 0;
  const body = s.replace(/(?:以后|之后|后)$/, '');

  /** 半小时 / 半个小时 / 半分钟 */
  let m = /^半(?:个)?(小时|钟头)$/.exec(body);
  if (m) return base + 30 * 60_000;
  m = /^半(?:分钟|分)$/.exec(body);
  if (m) return base + 30_000;

  /** N + 单位（单位可带「个」） */
  m = /^(.+?)(?:个)?(小时|钟头|分钟|分|秒钟|秒)$/.exec(body);
  if (!m) return 0;
  const n = cnNum(m[1]);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const unit = m[2];
  const ms = /小时|钟头/.test(unit) ? 3_600_000 : /秒/.test(unit) ? 1_000 : 60_000;
  return base + n * ms;
}

/**
 * 解析闹钟时间。
 *
 * 既认严格的 `yyyy-mm-dd HH:MM`（拒绝 2 月 30 日这类溢出日期），也认
 * 「一分钟后 / 半小时后 / 2小时」这类相对时间——后者以前完全交给模型心算，
 * 实测它会算错（把 0:51 的「一分钟后」写成了 00:53）。
 *
 * @param {string} value
 * @param {number} [base] 相对时间的基准（默认现在；测试可注入）
 */
export function parseReminderTime(value, base = Date.now()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) {
    const rel = parseRelativeTime(value, Number(base));
    return Number.isFinite(rel) && rel > 0 ? Math.round(rel) : 0;
  }
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0);
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])
    || d.getHours() !== Number(m[4]) || d.getMinutes() !== Number(m[5])) return 0;
  return d.getTime();
}

/** 脏数据不进列表：id/at/note 缺一不可，字段钳到合法形状 */
export function normalizeReminder(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  const at = Number(raw.at);
  const note = String(raw.note || '').trim().slice(0, 500);
  if (!id || !Number.isFinite(at) || !note) return null;
  const repeat = REPEATS.has(String(raw.repeat || '')) ? String(raw.repeat) : 'none';
  const intervalMin = Math.max(1, Math.min(10080, Math.round(Number(raw.intervalMin) || 60)));
  const weekdays = normalizeWeekdays(raw.weekdays);
  const until = Math.max(0, Number(raw.until) || 0);
  /**
   * 周期闹钟的存活期：有 until 就到 until + 宽限期，否则给一年——
   * 不能像一次性那样 at+15min，否则进程停机几天就被 prune 当作过期清掉。
   * 注意不能用 `Number(...) || 缺省`：显式存的 0（损坏/手工改过的记录）是 falsy，
   * 会把一条本该过期的记录「复活」成一年。用 hasOwn 区分「没这个键」和「存了 0」。
   */
  const hasExpiry = Object.prototype.hasOwnProperty.call(raw, 'expiresAt');
  const rawExpiry = Number(raw.expiresAt);
  const expiresAt = (hasExpiry && Number.isFinite(rawExpiry))
    ? rawExpiry
    : (repeat === 'none'
      ? at + REMINDER_GRACE_MS
      : (until > 0 ? until + REMINDER_GRACE_MS : at + PERIODIC_LIFETIME_MS));
  return {
    id,
    at,
    atText: String(raw.atText || '').trim() || reminderText(at),
    /**
     * 在哪个私聊设的。老记录没有这个字段 → 空串，到点回落主人
     * （见 host.js fireReminder 的 `r.chatId || owner`）。
     */
    chatId: String(raw.chatId || '').trim(),
    note,
    createdAt: Number(raw.createdAt) || at,
    attempts: Math.max(0, Math.round(Number(raw.attempts) || 0)),
    nextAt: Number(raw.nextAt) || at,
    expiresAt,
    lastError: String(raw.lastError || '').slice(0, 180),
    /** 重复：none=一次性；daily=每天/指定星期；weekdays=工作日；interval=每 N 分钟 */
    repeat,
    intervalMin,
    weekdays,
    until,
  };
}

/**
 * 造小闹钟存储。
 * @param {object} o
 * @param {string} o.file reminders.json 路径（必给；空则纯内存，测试用）
 * @param {string} [o.legacyFile] 旧 speakup-reminders.json 只读兼容路径
 * @param {()=>number} [o.now]
 * @param {(id:string)=>string} [o.newId] 生成 id（注入便于测试）
 */
export function createReminderStore({ file = '', legacyFile = '', now = () => Date.now(), newId = null } = {}) {
  const load = () => {
    const fresh = file ? readJson(file, null) : null;
    const raw = Array.isArray(fresh) ? fresh : (() => {
      if (!legacyFile) return [];
      const legacy = readJson(legacyFile, null);
      return Array.isArray(legacy) ? legacy : [];
    })();
    return raw.map(normalizeReminder).filter(Boolean);
  };
  const save = (list) => { if (file) writeJson(file, list); };
  const prune = (at = now()) => {
    const raw = load();
    const live = raw.filter((r) => Number(r.expiresAt) > Number(at));
    if (live.length !== raw.length) save(live);
    return live;
  };

  /** 面板/工具列表：按触发时间升序 */
  const list = (at = now()) => prune(at).sort((a, b) => a.at - b.at);

  /**
   * 设一条闹钟。校验口径与对方一致：总闸/上限由调用方判，这里只判时间格式、将来、note 非空。
   * `chatId` 记下「在哪个私聊设的」，到点就往那个私聊说；空着 → 回落主人。
   * @returns {{ok:boolean, id?:string, at?:string, message:string}}
   */
  const add = (value, noteText, {
    limit = 5, at = now(), chatId = '',
    repeat = 'none', weekdays = [], intervalMin = 60, until = 0,
  } = {}) => {
    const atMs = parseReminderTime(value, at);
    if (!atMs) return { ok: false, message: '时间格式不对，要用 yyyy-mm-dd HH:MM（例如 2026-11-26 17:30），或「一分钟后 / 半小时后」这类相对时间' };
    if (atMs <= Number(at)) return { ok: false, message: '这个时间已经过去了，请设一个将来的时间' };
    const note = String(noteText || '').trim().slice(0, 500);
    if (!note) return { ok: false, message: '要提醒自己什么？把想说的话写进 note' };
    const rep = REPEATS.has(String(repeat || '')) ? String(repeat) : 'none';
    /**
     * until 可能是数字时间戳（工具层保留原类型），也可能是 "yyyy-mm-dd HH:MM" 字符串，
     * 还可能是纯数字时间戳字符串。空值 = 不设截止；任何"非空但非法"的值必须报错，
     * 不能静默落 0 变成无限重复。一次性闹钟不用截止，直接忽略 until。
     */
    const badUntil = { ok: false, message: '截止时间格式不对，要用 yyyy-mm-dd HH:MM（如 2026-12-31 09:00）或数字时间戳' };
    let untilMs = 0;
    if (rep !== 'none') {
      const empty = until === undefined || until === null || until === '' || until === 0;
      if (!empty) {
        if (typeof until === 'number') {
          if (!Number.isSafeInteger(until) || until <= 0) return badUntil;
          untilMs = until;
        } else if (typeof until === 'string') {
          const s = until.trim();
          if (!s) return badUntil;
          untilMs = /^\d+$/.test(s) ? Number(s) : parseReminderTime(s, at);
          if (!Number.isFinite(untilMs) || untilMs <= 0) return badUntil;
        } else {
          /** 布尔 / 对象 / 数组等一律拒绝，不静默变无限 */
          return badUntil;
        }
      }
    }
    if (rep !== 'none' && untilMs > 0 && untilMs <= atMs) {
      return { ok: false, message: '截止时间要比第一次触发的时间晚' };
    }
    const live = prune(at);
    if (live.length >= limit) return { ok: false, message: '你设定的提醒太多了' };
    const id = typeof newId === 'function' ? newId() : `r-${at}-${Math.random().toString(36).slice(2, 10)}`;
    const reminder = normalizeReminder({
      id, at: atMs, note, createdAt: Number(at),
      chatId: String(chatId || '').trim(),
      attempts: 0, nextAt: atMs, lastError: '',
      repeat: rep, weekdays, intervalMin, until: untilMs,
      expiresAt: rep === 'none'
        ? atMs + REMINDER_GRACE_MS
        : (untilMs > 0 ? untilMs + REMINDER_GRACE_MS : atMs + PERIODIC_LIFETIME_MS),
    });
    save([...live, reminder]);
    const rhythm = rep === 'none' ? '' : `，之后${repeatText(reminder)}`;
    return { ok: true, id, at: reminder.atText, message: `已记下，${reminder.atText} 到点我会主动开口${rhythm}` };
  };

  /** 成功触发后：一次性删除，周期则算下一次保留；到期删除 */
  const advance = (id, at = now()) => {
    const live = load();
    const cur = live.find((r) => r.id === id);
    if (!cur) return { ok: false, message: '提醒已不在' };
    if (cur.repeat === 'none') { remove(id); return { ok: true, done: true }; }
    const next = nextReminderOccurrence(cur, Number(at));
    if (!next || (cur.until > 0 && next > cur.until)) {
      remove(id);
      return { ok: true, done: true, expired: true, message: '周期提醒到截止时间了' };
    }
    cur.at = next;
    cur.atText = reminderText(next);
    cur.nextAt = next;
    cur.attempts = 0;
    cur.lastError = '';
    cur.expiresAt = cur.until > 0 ? cur.until + REMINDER_GRACE_MS : next + PERIODIC_LIFETIME_MS;
    save(live);
    return { ok: true, done: false, nextAt: next, atText: cur.atText };
  };

  /** 关一条；过期/已关的按对方口径如实报错，不静默成功 */
  const close = (id) => {
    const key = String(id || '').trim();
    const live = prune();
    if (!key || !live.some((r) => r.id === key)) {
      return { ok: false, message: '没找到这个提醒，可能已经过期或关闭了' };
    }
    save(live.filter((r) => r.id !== key));
    return { ok: true, message: '这个小闹钟已关闭' };
  };

  /**
   * 本轮放弃（reminderRetry=false、私聊正忙让位、重试耗尽）：
   * 一次性删除；周期绝不因一次失败就整条消失——那等于用户设的「每天」悄悄失效，
   * 而是顺延到下一周期时刻本轮作罢，越过 until 才真正删除。
   * @returns {{drop:boolean, reminder?:object, message:string}}
   */
  const defer = (id, error = '', at = now()) => {
    const live = load();
    const cur = live.find((r) => r.id === id);
    if (!cur) return { drop: true, message: '提醒已不在' };
    if (cur.repeat === 'none') {
      remove(id);
      return { drop: true, message: '一次性提醒本轮放弃' };
    }
    const next = nextReminderOccurrence(cur, Number(at));
    if (!next || (cur.until > 0 && next > cur.until)) {
      save(live.filter((r) => r.id !== id));
      return { drop: true, message: '本轮放弃且周期已到截止，不再顺延' };
    }
    cur.at = next;
    cur.atText = reminderText(next);
    cur.nextAt = next;
    cur.attempts = 0;
    cur.lastError = String(error || '本轮放弃').slice(0, 180);
    cur.expiresAt = cur.until > 0 ? cur.until + REMINDER_GRACE_MS : next + PERIODIC_LIFETIME_MS;
    save(live);
    return { drop: false, reminder: cur, message: `本轮放弃，顺延到 ${reminderText(next)}` };
  };

  /**
   * 触发失败后的状态推进（对方 attemptReminder 的状态机，纯函数化）：
   * 首次失败把宽限期从 at+15min 起算；重试将耗尽宽限期则放弃；否则 attempts+1、nextAt+5min。
   * @returns {{drop:boolean, reminder?:object, message:string}}
   */
  const fail = (id, error = '', at = now()) => {
    const live = load();
    const current = live.find((r) => r.id === id);
    if (!current) return { drop: true, message: '提醒已不在' };
    /**
     * 一次性首次失败把宽限期从现在起算；周期闹钟绝不能压短——
     * 它靠一年长的 expiresAt 活着，压成 15min 会被 prune 当成过期清掉。
     * 周期失败只在 nextAt 上做 5min 重试，存活期原样保留。
     */
    if (current.attempts === 0 && current.repeat === 'none') {
      current.expiresAt = Number(at) + REMINDER_GRACE_MS;
    }
    if (current.repeat !== 'none') {
      /**
       * 周期闹钟失败也要收口：沿用一次性的 15min 窗口 / 5min 间隔（3 次）。
       * 没有上限会每 5min 跑一轮真会话，持续到一年后的 expiresAt（≈10 万次）。
       * 窗口耗尽不是删整条周期，而是顺延到下一个周期时刻本轮作罢；
       * 若顺延已越过 until 才真正删除。
       */
      const maxAttempts = Math.max(1, Math.floor(REMINDER_GRACE_MS / REMINDER_RETRY_MS));
      if (current.attempts + 1 < maxAttempts) {
        current.attempts += 1;
        current.nextAt = Number(at) + REMINDER_RETRY_MS;
        current.lastError = String(error || '触发失败').slice(0, 180);
        save(live);
        return { drop: false, reminder: current, message: '5 分钟后重试' };
      }
      /** 耗尽委托给 defer：与 reminderRetry=false 分支共用同一套周期顺延语义 */
      const step = defer(id, error, at);
      return step.drop
        ? { drop: true, message: '本轮重试耗尽且周期已到截止，放弃' }
        : { drop: false, reminder: step.reminder, message: `本轮重试耗尽，顺延到 ${reminderText(step.reminder.at)}` };
    }
    if (Number(at) + REMINDER_RETRY_MS >= Number(current.expiresAt)) {
      save(live.filter((r) => r.id !== id));
      return { drop: true, message: '重试窗口耗尽，放弃' };
    }
    current.attempts += 1;
    current.nextAt = Number(at) + REMINDER_RETRY_MS;
    current.lastError = String(error || '触发失败').slice(0, 180);
    save(live);
    return { drop: false, reminder: current, message: '5 分钟后重试' };
  };

  /** 触发成功 / 不可重试时移除 */
  const remove = (id) => {
    save(load().filter((r) => r.id !== id));
  };

  return { load, save, prune, list, add, close, fail, defer, remove, advance };
}
