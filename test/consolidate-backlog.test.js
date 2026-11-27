// C 组（2026-11-28 复核）：整理完整性 / 可观测。
//
//   C1 断点续跑：同一天同一会话超出一批的行不再被静默丢掉（真 bug）
//   C2 backlog 说清「已补多少 / 还剩多少」，面板摊开「库存 vs 平时可见」
//   C3 注释修正（由 values 决定，这里只守 memory/atomic 那两句不再回来）
//
// C1 的验收方式是"**并集**"：把每次喂给模型的行 id 都记下来，跑完之后
// 这个并集必须等于这一天的全部行——只要有一条没出现过，就说明尾巴又丢了。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemory } from '../src/memory.js';
import { createJournal } from '../src/journal.js';
import {
  createConsolidate, yesterdayOf, progressOf, MAX_BATCHES_PER_CHAT,
} from '../src/consolidate.js';

const noop = () => {};

/**
 * 造一个「一天 200 行、同一个群」的会话。
 *
 * 行文本故意写长（每行 60 字），保证 `pickRows` 的字数上限
 * （`MAX_INPUT_CHARS = 6000`）先于条数上限生效——那正是丢尾巴的现场。
 */
function bigRig({ rows = 200, maxBatches = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-c1-'));
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  const prev = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = data;
  const now = Date.parse('2026-11-27T10:00:00');
  const day = yesterdayOf(now);
  const base = Date.parse(`${day}T08:00:00`);
  const j = createJournal({ file: join(data, 'j.sqlite'), log: noop });
  const ids = [];
  for (let i = 0; i < rows; i += 1) {
    const id = `r${i}`;
    ids.push(id);
    j.add({
      id,
      at: base + i * 60_000,
      chatId: 'g1',
      sender: '甲',
      role: 'user',
      kind: 'chat',
      text: `第${i}条消息：今天我们聊了一件挺具体的事，涉及排期、成本和谁来做，细节不少要记下来`,
    });
  }

  const m = createMemory({ now: () => now, log: noop });
  /** 每次喂给模型的行 id 集合（并集必须覆盖全部） */
  const seen = new Set();
  let prompts = 0;
  const generate = async (p) => {
    prompts += 1;
    for (const line of String(p).split('\n')) {
      const mm = /^\[(r\d+)\]/.exec(line.trim());
      if (mm) seen.add(mm[1]);
    }
    return JSON.stringify({ summary: `第 ${prompts} 批` });
  };
  const c = createConsolidate({
    journal: j, graph: null, memory: m, generate,
    aliasesOf: () => [], log: noop, now: () => now,
  });
  return {
    j, m, c, day, ids, seen,
    prompts: () => prompts,
    run: () => c.run({ day }),
    digest: () => j.get(`day:${day}:g1`),
    done: () => c.done(day, 'g1'),
    doneAll: () => {
      try { j.close(); } catch {}
      if (prev === undefined) delete process.env.DSH_ROOST_DATA; else process.env.DSH_ROOST_DATA = prev;
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch {}
    },
  };
}

test('C1：跑一次不会写摘要行（还没整理完），但断点前进了', async () => {
  /** 600 行 ≈ 8 批，一轮最多 3 批，必然跑不完 */
  const r = bigRig({ rows: 600 });
  try {
    await r.run();
    assert.equal(r.done(), false, '一批处理不完就不能说这天整理完了');
    const pg = progressOf(`${r.day}|g1`);
    assert.ok(pg && pg.lastAt > 0, '必须留下断点');
    assert.ok(r.seen.size > 0, '模型至少看过一批');
  } finally { r.doneAll(); }
});

test('C1：反复跑，直到全部行都被送进过模型（并集 = 全部）', async () => {
  const r = bigRig({ rows: 120 });
  try {
    /** 每次 run 都有上限，所以要多跑几轮；最多 20 轮一定收敛 */
    for (let i = 0; i < 20 && !r.done(); i += 1) await r.run();
    assert.equal(r.done(), true, '最终应当写摘要');
    assert.equal(r.seen.size, r.ids.length, `并集要等于全部 ${r.ids.length} 行（实际 ${r.seen.size}）`);
    const missing = r.ids.filter((id) => !r.seen.has(id));
    assert.deepEqual(missing, [], `这些行从没进过提示词：${missing.slice(0, 5).join(',')}`);
  } finally { r.doneAll(); }
});

test('C1：每轮模型调用数有上限（不会一口气把整天烧完）', async () => {
  const r = bigRig({ rows: 600 });
  try {
    await r.run();
    assert.ok(r.prompts() <= MAX_BATCHES_PER_CHAT, `单轮最多 ${MAX_BATCHES_PER_CHAT} 批，实际 ${r.prompts()}`);
  } finally { r.doneAll(); }
});

test('C1：老库（已有摘要行、没有断点文件）仍然当已完成，零迁移', async () => {
  const r = bigRig({ rows: 10 });
  try {
    /** 手动造一条老样式摘要行（模拟升级前的库） */
    r.j.add({ id: `day:${r.day}:g1`, at: Date.parse(`${r.day}T23:00:00`), chatId: 'g1', role: 'digest', kind: 'digest', level: 'important', text: '老摘要' });
    assert.equal(r.done(), true);
    const st = await r.run();
    assert.equal(st.chats, 0, '已完成的不再重跑');
    assert.equal(r.prompts(), 0, '一次模型都不该调');
  } finally { r.doneAll(); }
});

test('C2：backlog 的 rows 扣掉断点之前的部分，并给出 processed', async () => {
  const r = bigRig({ rows: 600 });
  try {
    await r.run();
    const b = r.c.backlog({ days: 3, at: Date.parse('2026-11-27T10:00:00') });
    const item = b.items.find((x) => x.day === r.day && x.chatId === 'g1');
    assert.ok(item, '这天这个会话应当在积压列表里');
    assert.ok(item.processed > 0, '已经补过的行要算 processed');
    assert.equal(item.processed + item.rows, item.total, 'processed + rows = total');
    assert.ok(item.rows < item.total, '还剩的行应当少于总行数');
  } finally { r.doneAll(); }
});

test('C2：面板把「库存 / 平时可见」摊开，/memory 也在后端给同一组数', () => {
  const root = new URL('../', import.meta.url);
  const host = readFileSync(new URL('src/host.js', root), 'utf8');
  assert.match(host, /const INJECT_FACTS_GLOBAL = 6;/);
  assert.match(host, /const INJECT_FACTS_CHAT = 3;/);
  assert.match(host, /inject: \{\s*\n\s*global: INJECT_FACTS_GLOBAL,/, '/memory 要回同一组数');
  const cli = readFileSync(new URL('client/client.js', root), 'utf8');
  assert.match(cli, /平时注 \$\{mem\.inject\.global\} \+ \$\{mem\.inject\.chat\} 条/, '面板要说清平时只注几条');
});

test('C3：两处错误注释已改（memory 的"跨群共用"、atomic 的"都可重建"）', () => {
  const root = new URL('../', import.meta.url);
  const mem = readFileSync(new URL('src/memory.js', root), 'utf8');
  assert.equal(/代价是元数据以\*\*文本\*\*为 key：同一句话在不同群共用一份/.test(mem), false,
    '这句与实现不符，不能继续挂着');
  assert.match(mem, /跨群不共用/);
  const at = readFileSync(new URL('src/atomic.js', root), 'utf8');
  assert.equal(/本仓的数据都是可重建的状态/.test(at), false, '用户数据不是可重建的');
});
