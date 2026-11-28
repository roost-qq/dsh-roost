// 她的小闹钟 · 数据层（A1）：照对方口径验校验/上限/兼容/重试状态机。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createReminderStore, parseReminderTime, reminderText, normalizeReminder,
  nextReminderOccurrence, normalizeWeekdays, repeatText,
  REMINDER_GRACE_MS, REMINDER_RETRY_MS,
} from '../src/reminder-store.js';

const localMs = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

test('时间解析：严格格式、拒绝溢出日期、格式化回原文', () => {
  const at = parseReminderTime('2026-11-26 17:30');
  assert.ok(at > 0);
  assert.equal(reminderText(at), '2026-11-26 17:30');
  assert.equal(parseReminderTime('2026-02-30 10:00'), 0, '2月30日不存在');
  assert.equal(parseReminderTime('2026-11-26'), 0);
  assert.ok(parseReminderTime('2026-11-26T17:30') > 0, 'T 分隔也认');
});

test('相对时间：分钟后 / 半小时后 / 小时 / 秒，中文数字都认', () => {
  const base = new Date('2026-11-26T10:00:00').getTime();
  assert.equal(parseReminderTime('一分钟后', base) - base, 60_000);
  assert.equal(parseReminderTime('1分钟后', base) - base, 60_000);
  assert.equal(parseReminderTime('五分钟', base) - base, 5 * 60_000, '不带「后」也认');
  assert.equal(parseReminderTime('半小时后', base) - base, 30 * 60_000);
  assert.equal(parseReminderTime('半个小时', base) - base, 30 * 60_000);
  assert.equal(parseReminderTime('两小时', base) - base, 2 * 60 * 60_000);
  assert.equal(parseReminderTime('二十五分钟后', base) - base, 25 * 60_000, '几十的中文数字');
  assert.equal(parseReminderTime('30秒后', base) - base, 30_000);
  assert.equal(parseReminderTime('abc', base), 0, '认不出来就是 0');
  assert.equal(parseReminderTime('0分钟后', base), 0, '0 分钟不算');
});

test('chatId：设在哪条私聊就记在哪，老记录回落空串', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rem-'));
  try {
    const file = join(dir, 'reminders.json');
    const now = new Date('2026-11-25T00:00:00').getTime();
    const s = createReminderStore({ file, now: () => now, newId: () => 'id1' });
    const r = s.add('2026-11-26 10:00', '叫她来', { at: now, chatId: 'openid-B' });
    assert.equal(r.ok, true);
    assert.equal(s.list(now)[0].chatId, 'openid-B', '落盘并读回');

    /** 老记录（没有 chatId）读出来是空串，由 fireReminder 回落主人 */
    writeFileSync(file, JSON.stringify([{ id: 'old', at: now + 60_000, note: '老提醒' }]), 'utf8');
    assert.equal(s.list(now)[0].chatId, '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('相对时间入参：add 用注入的 now 当基准', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rem-'));
  try {
    const file = join(dir, 'reminders.json');
    const now = new Date('2026-11-25T23:59:30').getTime();
    const s = createReminderStore({ file, now: () => now, newId: () => 'id1' });
    const r = s.add('一分钟后', '跨午夜也要对', { at: now, chatId: 'openid-B' });
    assert.equal(r.ok, true);
    assert.equal(s.list(now)[0].at, now + 60_000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('normalizeReminder：脏数据丢掉，字段钳制', () => {
  assert.equal(normalizeReminder(null), null);
  assert.equal(normalizeReminder({ id: '', at: 1, note: 'x' }), null);
  assert.equal(normalizeReminder({ id: 'a', at: NaN, note: 'x' }), null);
  const r = normalizeReminder({ id: 'a', at: 1000, note: ' x '.repeat(300), attempts: -5 });
  assert.equal(r.note.length, 500, 'note 截到 500');
  assert.equal(r.attempts, 0, 'attempts 不为负');
  assert.ok(r.expiresAt > r.at);
});

test('add 校验：格式/过去/空 note/上限', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rem-'));
  try {
    const file = join(dir, 'reminders.json');
    const now = new Date('2026-11-25T00:00:00').getTime();
    const s = createReminderStore({ file, now: () => now, newId: () => 'id1' });
    assert.match(s.add('bad', 'note', { at: now }).message, /格式不对/);
    assert.match(s.add('2026-11-24 10:00', 'note', { at: now }).message, /过去了/);
    assert.match(s.add('2026-11-26 10:00', '  ', { at: now }).message, /note/);
    const r = s.add('2026-11-26 10:00', '提醒我', { at: now });
    assert.equal(r.ok, true);
    assert.equal(r.id, 'id1');
    assert.match(s.add('2026-11-27 10:00', '第二条', { at: now, limit: 1 }).message, /太多/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('close / prune：关掉即无、过期自动清', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rem-'));
  try {
    const file = join(dir, 'reminders.json');
    let now = new Date('2026-11-25T00:00:00').getTime();
    const s = createReminderStore({ file, now: () => now, newId: () => 'id1' });
    s.add('2026-11-26 10:00', '提醒我', { at: now });
    assert.equal(s.list(now).length, 1);
    s.close('nope').ok === false && assert.equal(s.close('nope').ok, false, '关不存在的报错');
    s.close('id1');
    assert.equal(s.list(now).length, 0);

    const dueAt = parseReminderTime('2026-11-26 10:00');
    s.add('2026-11-26 10:00', '会过期的', { at: now });
    now = dueAt + REMINDER_GRACE_MS + 1;
    assert.equal(s.list(now).length, 0, '过宽限期自动清掉');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fail 重试状态机：首次失败延宽限期、耗尽则放弃', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rem-'));
  try {
    const file = join(dir, 'reminders.json');
    let now = new Date('2026-11-25T00:00:00').getTime();
    const s = createReminderStore({ file, now: () => now, newId: () => 'id1' });
    s.add('2026-11-25T00:00:00'.replace('T', ' ').slice(0, 16), '到点了', { at: now - 1000 });
    const r1 = s.fail('id1', '超时', now);
    assert.equal(r1.drop, false);
    assert.equal(r1.reminder.attempts, 1);
    assert.equal(r1.reminder.nextAt, now + REMINDER_RETRY_MS);
    // 推进到接近宽限期尽头：再失败应放弃
    now += REMINDER_GRACE_MS - REMINDER_RETRY_MS;
    const r2 = s.fail('id1', '又失败', now);
    assert.equal(r2.drop, true, '重试窗口耗尽则放弃');
    assert.equal(s.list(now).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('legacy 兼容：新文件不存在时只读旧文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rem-'));
  try {
    const file = join(dir, 'reminders.json');
    const legacy = join(dir, 'speakup-reminders.json');
    writeFileSync(legacy, JSON.stringify([{ id: 'old', at: Date.now() + 60000, note: '老提醒' }]), 'utf8');
    const s = createReminderStore({ file, legacyFile: legacy });
    assert.equal(s.list().length, 1);
    assert.equal(s.list()[0].id, 'old');
    assert.equal(existsLegacyUntouched(file), false, '新文件还没建');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function existsLegacyUntouched(file) {
  try { readFileSync(file); return true; } catch { return false; }
}

test('normalizeWeekdays：数组/逗号串/脏值 → 去重排序的 0–6', () => {
  assert.deepEqual(normalizeWeekdays([1, 3, 1, 6]), [1, 3, 6]);
  assert.deepEqual(normalizeWeekdays('1,3,5'), [1, 3, 5]);
  assert.deepEqual(normalizeWeekdays('一,三'), [], '中文数字不认，交给面板转');
  assert.deepEqual(normalizeWeekdays([0, 7, -1, 2]), [0, 2], '越界丢弃');
});

test('daily 周期：每天同一时刻，跨月跨年都对', () => {
  const t = localMs(2026, 12, 31, 9, 0);
  const r = { at: t, repeat: 'daily', weekdays: [] };
  const next = nextReminderOccurrence(r, t);
  assert.equal(next, localMs(2027, 1, 1, 9, 0), '12/31 → 次年 1/1');
});

test('daily + weekdays：只在指定星期触发', () => {
  /** 2026-11-30 是周一。设周三(3)、周五(5) 09:00 */
  const t = localMs(2026, 11, 30, 9, 0); // 周一
  const r = { at: t, repeat: 'daily', weekdays: [3, 5] };
  assert.equal(nextReminderOccurrence(r, t), localMs(2026, 12, 2, 9, 0), '周一 → 周三');
  const t2 = localMs(2026, 12, 2, 9, 0); // 周三
  assert.equal(nextReminderOccurrence({ ...r, at: t2 }, t2), localMs(2026, 12, 4, 9, 0), '周三 → 周五');
});

test('weekdays：工作日跳过周末', () => {
  const fri = localMs(2026, 12, 4, 18, 0); // 周五
  const r = { at: fri, repeat: 'weekdays' };
  assert.equal(nextReminderOccurrence(r, fri), localMs(2026, 12, 7, 18, 0), '周五 → 下周一');
});

test('interval：每 N 分钟；落后太久只从现在补一枪', () => {
  const t = localMs(2026, 11, 26, 10, 0);
  const r = { at: t, repeat: 'interval', intervalMin: 30 };
  assert.equal(nextReminderOccurrence(r, t), t + 30 * 60_000);
  /** 现在比 at 落后 5 小时：不补 10 枪，只从 now 起 30 分钟后一枪 */
  const muchLater = t + 5 * 3_600_000;
  assert.equal(nextReminderOccurrence(r, muchLater), muchLater + 30 * 60_000);
});

test('周期闹钟：advance 续期保留，到期/截止时间删除', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rem-'));
  try {
    const file = join(dir, 'reminders.json');
    const t0 = localMs(2026, 11, 26, 9, 0);
    let now = localMs(2026, 11, 25, 0, 0);
    const s = createReminderStore({ file, now: () => now, newId: () => 'p1' });
    const r = s.add('2026-11-26 09:00', '每天喝水', { at: now, repeat: 'daily' });
    assert.equal(r.ok, true);
    assert.match(r.message, /每天/, '回执说明重复节奏');
    assert.equal(s.list(now).length, 1);
    assert.equal(s.list(now)[0].repeat, 'daily');

    now = t0; // 到点触发
    const a1 = s.advance('p1', now);
    assert.equal(a1.done, false, '周期不删除');
    assert.equal(s.list(now)[0].at, localMs(2026, 11, 27, 9, 0), '续到次日');
    assert.equal(s.list(now)[0].atText, '2026-11-27 09:00');
    assert.equal(s.list(now)[0].attempts, 0, '成功后续期清零重试计数');

    /** 带 until：下次超过截止就删除 */
    const t1 = localMs(2026, 11, 20, 0, 0);
    const s2 = createReminderStore({ file: join(dir, 'r2.json'), now: () => t1, newId: () => 'p2' });
    s2.add('2026-11-26 09:00', '有截止', {
      at: t1, repeat: 'daily', until: localMs(2026, 11, 27, 0, 0),
    });
    s2.advance('p2', t0); // → 次日 11/27 09:00，超过 until
    assert.equal(s2.list(t0).length, 0, '过了截止日删掉');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('周期闹钟不会被 prune 当过期清掉；一次性仍按宽限期清', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rem-'));
  try {
    const t0 = localMs(2026, 11, 26, 9, 0);
    const late = t0 + 3 * 86_400_000; // 停机 3 天后
    const s = createReminderStore({ file: join(dir, 'r.json'), now: () => localMs(2026, 11, 25), newId: () => 'p' });
    s.add('2026-11-26 09:00', '长期每天', { at: localMs(2026, 11, 25), repeat: 'daily' });
    assert.equal(s.list(late).length, 1, '周期闹钟停机几天还在');

    const s2 = createReminderStore({ file: join(dir, 'r2.json'), now: () => localMs(2026, 11, 25), newId: () => 'o' });
    s2.add('2026-11-26 09:00', '一次性', { at: localMs(2026, 11, 25) });
    assert.equal(s2.list(t0 + REMINDER_GRACE_MS + 1).length, 0, '一次性过宽限期清掉');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('repeatText：回执描述正确', () => {
  assert.equal(repeatText({ repeat: 'daily' }), '每天');
  assert.equal(repeatText({ repeat: 'daily', weekdays: [1, 3, 5] }), '每周一、三、五');
  assert.equal(repeatText({ repeat: 'weekdays' }), '每个工作日');
  assert.equal(repeatText({ repeat: 'interval', intervalMin: 120 }), '每 120 分钟');
  assert.equal(repeatText({ repeat: 'none' }), '');
});

test('add 校验：周期截止时间不能早于首次触发', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rem-'));
  try {
    const now = localMs(2026, 11, 25);
    const s = createReminderStore({ file: join(dir, 'r.json'), now: () => now });
    const bad = s.add('2026-11-26 09:00', 'x', {
      at: now, repeat: 'daily', until: localMs(2026, 11, 24),
    });
    assert.match(bad.message, /截止/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("字符串格式的 until 能被解析（工具层传字符串）", () => {
  const dir = mkdtempSync(join(tmpdir(), 'rem-'));
  try {
    const now = localMs(2026, 11, 25);
    const s = createReminderStore({ file: join(dir, 'r.json'), now: () => now, newId: () => 'p' });
    const r = s.add('2026-11-26 09:00', '每天', {
      at: now, repeat: 'daily', until: '2026-11-30 09:00',
    });
    assert.equal(r.ok, true);
    assert.equal(s.list(now)[0].until, localMs(2026, 11, 30, 9, 0), '字符串日期解析成时间戳');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("周期续期：after 远超 at 时一次跳到未来，不逐日追平刷屏（P1-2）", () => {
  const at = localMs(2026, 11, 1, 9, 0);
  const after = localMs(2026, 11, 11, 9, 0); // 停机 10 天后
  for (const rep of ['daily', 'weekdays']) {
    const next = nextReminderOccurrence({ at, repeat: rep, weekdays: [] }, after);
    assert.ok(next > after, rep + ': 必须返回 after 之后的时刻，不能是过去的');
  }
  const nextDaily = nextReminderOccurrence({ at, repeat: 'daily', weekdays: [] }, after);
  assert.equal(nextDaily, localMs(2026, 11, 12, 9, 0), 'daily 跳到次日 09:00');
  const nextWd = nextReminderOccurrence({ at, repeat: 'weekdays' }, after);
  assert.equal(nextWd, localMs(2026, 11, 12, 9, 0), 'weekdays：11/11 是周三，下一个工作日是周四');
});


test("周期闹钟失败重试有上限，耗尽顺延到下一周期（P1-1）", () => {
  const dir = mkdtempSync(join(tmpdir(), 'rem-'));
  try {
    const file = join(dir, 'r.json');
    const now0 = localMs(2026, 11, 20, 0, 0);
    let now = now0;
    const s = createReminderStore({ file, now: () => now, newId: () => 'p' });
    s.add('2026-11-20 09:00', '每天吃药', { at: now0, repeat: 'daily' });

    /** 前 2 次失败：5 分钟后重试，attempts 递增 */
    now += 5 * 60_000;
    assert.equal(s.fail('p', '失败1', now).drop, false);
    assert.equal(s.list(now)[0].attempts, 1, '第1次仍在重试窗口');
    now += 5 * 60_000;
    assert.equal(s.fail('p', '失败2', now).drop, false);
    assert.equal(s.list(now)[0].attempts, 2, '第2次仍在重试窗口');

    /** 第 3 次失败：窗口耗尽，顺延到次日 09:00，不再每 5min 轮询 */
    now += 5 * 60_000;
    const r3 = s.fail('p', '失败3', now);
    assert.equal(r3.drop, false, '不删整条周期');
    assert.match(r3.message, /顺延/);
    const row = s.list(now)[0];
    assert.equal(row.attempts, 0, '顺延后重试计数清零');
    assert.equal(row.at, localMs(2026, 11, 20, 9, 0), '顺延到当天 09:00（此刻才 00:15，还没到点）');
    assert.ok(row.nextAt > now, '下次触发必须在未来');

    /** 带 until 的：失败发生在触发时刻之后，顺延到次日 09:00 已越过 until 12:00，则删除 */
    const until = localMs(2026, 11, 20, 12, 0);
    let now2 = localMs(2026, 11, 20, 9, 5); // 触发后 5 分钟才开始失败
    const s2 = createReminderStore({ file: join(dir, 'r2.json'), now: () => now2, newId: () => 'q' });
    s2.add('2026-11-20 09:00', '有截止', { at: localMs(2026, 11, 19, 0, 0), repeat: 'daily', until });
    for (let i = 0; i < 3; i++) { s2.fail('q', '失败', now2); now2 += 5 * 60_000; }
    assert.equal(s2.list(now2).length, 0, '顺延越过 until 则删除');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("非法截止时间明确报错，不静默变成无限重复（P2-1）", () => {
  const dir = mkdtempSync(join(tmpdir(), 'rem-'));
  try {
    const now = localMs(2026, 11, 25);
    const s = createReminderStore({ file: join(dir, 'r.json'), now: () => now });
    const bad = s.add('2026-11-26 09:00', '每天', { at: now, repeat: 'daily', until: '2026-13-45 99:99' });
    assert.equal(bad.ok, false);
    assert.match(bad.message, /截止时间格式不对/);
    assert.equal(s.list(now).length, 0, '没记上非法闹钟');

    /** 数字时间戳仍兼容 */
    const ok = s.add('2026-11-26 09:00', '每天', { at: now, repeat: 'daily', until: localMs(2026, 12, 1) });
    assert.equal(ok.ok, true);
    assert.equal(s.list(now)[0].until, localMs(2026, 12, 1));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("defer：一次性删除，周期顺延到下一周期（P1 reminderRetry=false）", () => {
  const dir = mkdtempSync(join(tmpdir(), 'rem-'));
  try {
    const t = localMs(2026, 11, 26, 9, 0);
    let now = t;
    const s = createReminderStore({ file: join(dir, 'r.json'), now: () => now, newId: () => 'p' });
    s.add('2026-11-26 09:00', '每天', { at: localMs(2026, 11, 25), repeat: 'daily' });
    const d = s.defer('p', '私聊正忙', t);
    assert.equal(d.drop, false, '周期不删');
    assert.match(d.message, /顺延/);
    assert.equal(s.list(now)[0].at, localMs(2026, 11, 27, 9, 0), '让位到次日');

    const s2 = createReminderStore({ file: join(dir, 'r2.json'), now: () => now, newId: () => 'o' });
    s2.add('2026-11-26 09:00', '一次性', { at: localMs(2026, 11, 25) });
    assert.equal(s2.defer('o', '忙', t).drop, true, '一次性仍删');
    assert.equal(s2.list(now).length, 0);

    /** 带 until：顺延越过截止就删 */
    const s3 = createReminderStore({ file: join(dir, 'r3.json'), now: () => now, newId: () => 'q' });
    s3.add('2026-11-26 09:00', '有截止', {
      at: localMs(2026, 11, 25), repeat: 'daily', until: localMs(2026, 11, 26, 12, 0),
    });
    assert.equal(s3.defer('q', '忙', t).drop, true, '顺延到次日已过截止 → 删');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fail 真实生产时序：从触发时刻起连续失败，顺延到下一周期（P2-5）", () => {
  const dir = mkdtempSync(join(tmpdir(), 'rem-'));
  try {
    let now = localMs(2026, 11, 20, 9, 0); // tickReminders 只在 nextAt<=now 时触发，失败必在 09:00 后
    const s = createReminderStore({ file: join(dir, 'r.json'), now: () => now, newId: () => 'p' });
    s.add('2026-11-20 09:00', '每天吃药', { at: localMs(2026, 11, 19), repeat: 'daily' });
    for (let i = 0; i < 2; i++) {
      const r = s.fail('p', '失败', now);
      assert.match(r.message, /5 分钟后重试/);
      now += 5 * 60_000;
    }
    const last = s.fail('p', '失败', now);
    assert.match(last.message, /顺延/);
    assert.equal(s.list(now)[0].at, localMs(2026, 11, 21, 9, 0), '真实时序顺延到次日');
    assert.ok(s.list(now)[0].nextAt > now, 'nextAt 必须在未来');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("非法数字/布尔 until 一律报错，不静默变无限（P2-2）", () => {
  const dir = mkdtempSync(join(tmpdir(), 'rem-'));
  try {
    const now = localMs(2026, 11, 25);
    const s = createReminderStore({ file: join(dir, 'r.json'), now: () => now });
    for (const bad of [-1, NaN, Infinity, -Infinity, true, {}, [], 1.5]) {
      const r = s.add('2026-11-26 09:00', '每天', { at: now, repeat: 'daily', until: bad });
      assert.equal(r.ok, false, String(bad) + ' 必须报错');
      assert.match(r.message, /格式不对/);
    }
    assert.equal(s.list(now).length, 0, '非法值一条都不落库');
    /** 纯数字时间戳字符串（模型常见输出）要认 */
    const stamp = localMs(2026, 12, 1);
    const ok = s.add('2026-11-26 09:00', '每天', { at: now, repeat: 'daily', until: String(stamp) });
    assert.equal(ok.ok, true, '数字串时间戳应兼容');
    assert.equal(s.list(now)[0].until, stamp);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("一次性闹钟忽略脏 until，不被拒绝", () => {
  const dir = mkdtempSync(join(tmpdir(), 'rem-'));
  try {
    const now = localMs(2026, 11, 25);
    const s = createReminderStore({ file: join(dir, 'r.json'), now: () => now });
    const r = s.add('2026-11-26 09:00', '一次性', { at: now, repeat: 'none', until: true });
    assert.equal(r.ok, true, '一次性不用 until，脏值应被忽略而非拒绝');
    assert.equal(s.list(now)[0].until, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("normalizeReminder：显式 expiresAt=0 不再复活成一年（P2-4）", () => {
  const dir = mkdtempSync(join(tmpdir(), 'rem-'));
  try {
    const file = join(dir, 'r.json');
    const t = localMs(2026, 11, 26, 9, 0);
    writeFileSync(file, JSON.stringify([{
      id: 'bad', at: t, note: 'x', repeat: 'daily', expiresAt: 0, nextAt: t,
    }]));
    const s = createReminderStore({ file, now: () => t });
    assert.equal(s.load()[0].expiresAt, 0, '显式的 0 要保留');
    assert.equal(s.list(t).length, 0, '过期的损坏记录被 prune 清掉，不复活');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("interval 相位保持：会话耗时不叠加到节奏里（P2-3）", () => {
  const step = 5 * 60_000;
  let at = localMs(2026, 11, 26, 9, 0);
  for (let i = 1; i <= 4; i++) {
    const after = at + 2 * 60_000; // 每轮会话 2 分钟
    at = nextReminderOccurrence({ at, repeat: 'interval', intervalMin: 5 }, after);
    assert.equal(at, localMs(2026, 11, 26, 9, 0) + i * step, '第' + i + '轮仍落在 5 分钟格点');
  }
});
