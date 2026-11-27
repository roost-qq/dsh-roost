// B 组（2026-11-28 复核 #3 / #5 / #6）：记忆质量三件。
//
//   B2 拆掉「注入即加冕」——衰减起点不再看 lastHit（自动注入不算复习）
//   B3 core 可降——被反驳到 confidence<0.5 或被顶替时，一步降回 long
//   B1 语义改口——「住在杭州」→「搬到上海」这种 0.10 相似度的改口交给模型判
//
// 三者的共同前提：**默认不改变现有行为**。B2 只去掉一个不该存在的信号；
// B3 只在"已经不信了/已经不作数了"时生效；B1 默认关。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createMemory, factIdOf, growTier, retentionOf, scoreOfFact,
} from '../src/memory.js';
import { createJournal } from '../src/journal.js';
import { createConsolidate, buildSupersedePrompt, yesterdayOf } from '../src/consolidate.js';

const noop = () => {};
const DAY = 24 * 60 * 60 * 1000;

function memRig() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-qual-'));
  const prev = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = dir;
  const file = join(dir, 'memory.json');
  writeFileSync(file, JSON.stringify({ global: [], chats: {}, meta: { global: {}, chats: {} } }), 'utf8');
  return {
    dir, file,
    m: (opts = {}) => createMemory({ now: () => 1000, log: noop, ...opts }),
    raw: () => JSON.parse(readFileSync(file, 'utf8')),
    done: () => {
      if (prev === undefined) delete process.env.DSH_ROOST_DATA; else process.env.DSH_ROOST_DATA = prev;
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch {}
    },
  };
}

/* ---------------- B2：注入不再拨回衰减时钟 ---------------- */

test('B2：lastHit 不影响衰减（被自动注入不再等于被复习）', () => {
  const now = 100 * DAY;
  const at = now - 30 * DAY;
  const plain = retentionOf({ at }, now);
  const hitToday = retentionOf({ at, lastHit: now }, now);
  assert.equal(hitToday, plain, 'lastHit 写了也不该把时钟拨回今天');
  /** 对照：reviewedAt（真复习）仍然算——那是主人的动作，不是自动注入 */
  assert.ok(retentionOf({ at, reviewedAt: now }, now) > plain, '复习仍然生效');
});

test('B2：hitDays 仍然让衰减更慢（2026-11-24 的决策保留）', () => {
  const now = 100 * DAY;
  const at = now - 30 * DAY;
  const base = retentionOf({ at }, now);
  const hot = retentionOf({ at, hitDays: 10 }, now);
  assert.ok(hot > base, '反复提到的事记得更牢——这是期望行为，别一起删掉');
});

test('B2：scoreOfFact 里 lastHit 同样不起作用（排序与淘汰口径一致）', () => {
  const now = 100 * DAY;
  const at = now - 20 * DAY;
  assert.equal(scoreOfFact({ at, lastHit: now }, now), scoreOfFact({ at }, now));
});

/* ---------------- B3：core 可降 ---------------- */

test('B3：core 被反驳到 confidence<0.5 → 一步降回 long', () => {
  assert.equal(growTier({ tier: 'core', confidence: 0.3 }), 'long');
  assert.equal(growTier({ tier: 'core', confidence: 0.9 }), 'core', '还信就不动');
  assert.equal(growTier({ tier: 'core' }), 'core', '老库没有 confidence 不乱降');
});

test('B3：证据接口收到 contradict 时，core 当场降档', () => {
  const f = memRig();
  try {
    const m = f.m();
    m.add('', '主人住在杭州', 'global', { tier: 'core' });
    /** 造低可信：连续三次反证（每次 -0.2） */
    for (let i = 0; i < 3; i += 1) {
      m.recordEvidence('', '主人住在杭州', 'contradict', { kind: 'test' }, 'global');
    }
    const meta = f.raw().meta.global['主人住在杭州'];
    assert.ok(meta.confidence < 0.5, `三次反证后应当低于 0.5（实际 ${meta.confidence}）`);
    assert.equal(meta.tier, 'long', '不信了就不该继续占永不衰减的位置');
  } finally { f.done(); }
});

test('B3：被顶替的 core 降回 long（不作数了就不该永久）', () => {
  const f = memRig();
  try {
    const m = f.m();
    m.add('', '主人住在杭州', 'global', { tier: 'core' });
    m.add('', '主人住在杭州市', 'global', { tier: 'long' });
    const meta = f.raw().meta.global['主人住在杭州'];
    assert.equal(typeof meta.until, 'number', '先确认真被顶替了');
    assert.equal(meta.tier, 'long');
  } finally { f.done(); }
});

/* ---------------- B1：语义改口 ---------------- */

test('B1：提示里说清「越靠后越新」与「拿不准就不要提」', () => {
  const p = buildSupersedePrompt([{ key: 'global', texts: ['主人住在杭州', '主人搬到上海了'] }]);
  assert.match(p, /越靠后越新/);
  assert.match(p, /不要提/);
  assert.match(p, /1\. 主人住在杭州/);
  assert.match(p, /"supersede"/);
});

function consRig({ semanticEnabled = false, pairs = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-sem-'));
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  const prev = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = data;
  const now = Date.parse('2026-11-27T10:00:00');
  const day = yesterdayOf(now);
  const base = Date.parse(`${day}T09:00:00`);
  const j = createJournal({ file: join(data, 'j.sqlite'), log: noop });
  j.add({ id: 'r1', at: base, chatId: 'g1', sender: '甲', role: 'user', kind: 'chat', text: '我搬家了' });

  const m = createMemory({ now: () => now, log: noop });
  m.add('g1', '主人住在杭州', 'chat', {});
  m.add('g1', '主人搬到上海了', 'chat', {});

  const prompts = [];
  const generate = async (p) => {
    prompts.push(p);
    if (p.includes('越靠后越新')) return JSON.stringify({ supersede: pairs || [{ l: 'g1', old: 1, new: 2, why: '搬家' }] });
    return '{}';
  };
  const c = createConsolidate({
    journal: j, graph: null, memory: m, generate,
    aliasesOf: () => [], log: noop, now: () => now,
    semanticEnabled: () => semanticEnabled,
  });
  return {
    m, j, c, day, prompts,
    run: () => c.run({ day }),
    metaOf: (t) => m.listFull('g1', []).chat.find((x) => x.text === t),
    /** 直接读盘：`until`/`supersededBy` 是账本字段，listFull 只透出前者 */
    rawMeta: (t) => JSON.parse(readFileSync(join(data, 'memory.json'), 'utf8')).meta.chats.g1?.[t] || {},
    done: () => {
      try { j.close(); } catch {}
      if (prev === undefined) delete process.env.DSH_ROOST_DATA; else process.env.DSH_ROOST_DATA = prev;
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch {}
    },
  };
}

test('B1：开着时，旧说法被打成历史，并记下被谁顶掉', () => {
  const r = consRig({ semanticEnabled: true });
  try {
    return r.run().then(() => {
      const old = r.rawMeta('主人住在杭州');
      assert.equal(typeof old.until, 'number', '旧说法要进历史');
      assert.equal(old.supersededBy, factIdOf('主人搬到上海了'), '因果链要完整');
      const fresh = r.metaOf('主人搬到上海了');
      assert.equal(fresh.until ?? null, null, '新说法必须还活着');
    }).finally(r.done);
  } catch (e) { r.done(); throw e; }
});

test('B1：编号写反（新的在前）整对丢弃，不猜', () => {
  const r = consRig({ semanticEnabled: true, pairs: [{ l: 'g1', old: 2, new: 1 }] });
  try {
    return r.run().then(() => {
      assert.equal(r.metaOf('主人住在杭州').until ?? null, null, '写反了就当没说');
      assert.equal(r.metaOf('主人搬到上海了').until ?? null, null);
    }).finally(r.done);
  } catch (e) { r.done(); throw e; }
});

test('B1：默认关时一次判定请求都不发', () => {
  const r = consRig({ semanticEnabled: false });
  try {
    return r.run().then(() => {
      assert.equal(r.prompts.some((p) => p.includes('越靠后越新')), false, '关着不能多发请求');
      assert.equal(r.metaOf('主人住在杭州').until ?? null, null);
    }).finally(r.done);
  } catch (e) { r.done(); throw e; }
});

test('B1：config 默认关，宿主热读，且面板登记了这个开关', () => {
  const root = new URL('../', import.meta.url);
  const cfg = readFileSync(new URL('src/config.js', root), 'utf8');
  assert.match(cfg, /semantic: \{ enabled: false \}/);
  const host = readFileSync(new URL('src/host.js', root), 'utf8');
  assert.match(host, /semanticEnabled: \(\) => cfg\.memory\?\.semantic\?\.enabled === true/);
  const feat = readFileSync(new URL('src/features.js', root), 'utf8');
  assert.match(feat, /path: \['memory', 'semantic', 'enabled'\]/);
});
