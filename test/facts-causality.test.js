/**
 * 阶段8：facts 因果链真指针。
 * 老库推断路径由 memory-history.test.js 钉住不动；这里钉新库写指针 +
 * 四处白名单回环 + history 的 linked 模式。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory, factIdOf } from '../src/memory.js';
import { historyOf } from '../src/memory-history.js';
import { restoreRetentionRows } from '../src/backup.js';
import { normalizeEntry } from '../src/dry-run.js';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-causal-'));
  const oldEnv = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = dir;
  const file = join(dir, 'memory.json');
  writeFileSync(file, JSON.stringify({ global: [], chats: {}, meta: { global: {}, chats: {} }, personas: {}, authz: {} }), 'utf8');
  return {
    dir, file,
    done: () => {
      if (oldEnv === undefined) delete process.env.DSH_ROOST_DATA;
      else process.env.DSH_ROOST_DATA = oldEnv;
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    },
  };
}

test('supersede 给旧条目写 supersededBy = 新条目稳定 id', () => {
  const f = fresh();
  try {
    const m = createMemory({ now: () => 1000, log: () => {} });
    m.add('', '主人住在杭州', 'global', { status: 'fact' });
    m.add('', '主人住在杭州市', 'global', { status: 'fact' });
    const raw = JSON.parse(readFileSync(f.file, 'utf8'));
    const oldMeta = raw.meta.global['主人住在杭州'];
    assert.equal(typeof oldMeta.until, 'number', '旧条目应有 until');
    assert.equal(oldMeta.supersededBy, factIdOf('主人住在杭州市'), '应指向新条目 id');
  } finally { f.done(); }
});

test('historyOf：有指针 = linked 真链（inferred:false），不再靠猜', () => {
  const rows = [
    { id: factIdOf('主人住在杭州'), text: '主人住在杭州', until: 2000, at: 1000, supersededBy: factIdOf('主人住在杭州市') },
    { id: factIdOf('主人住在杭州市'), text: '主人住在杭州市', at: 2000 },
  ];
  const got = historyOf(rows, factIdOf('主人住在杭州市'), { now: 3000 });
  assert.equal(got.mode, 'linked');
  assert.equal(got.earlier.length, 1);
  assert.equal(got.earlier[0].inferred, false);
  assert.equal(got.earlier[0].text, '主人住在杭州');
  assert.match(got.note, /确凿/);
});

test('historyOf：老库无指针仍走 inferred（不回归 memory-history.test.js 的口径）', () => {
  const rows = [
    { id: 'a', text: '主人住在杭州', until: 2000, at: 1000 },
    { id: 'b', text: '主人住在杭州市', at: 2000 },
  ];
  const got = historyOf(rows, 'b', { now: 3000 });
  assert.equal(got.mode, 'inferred');
  assert.equal(got.earlier[0].inferred, true);
  assert.match(got.note, /不等于因果/);
});

test('四处白名单：entries/insertRaw/backup/dry-run 都保 supersededBy', () => {
  const f = fresh();
  try {
    const m = createMemory({ now: () => 1000, log: () => {} });
    m.add('', '主人住在杭州', 'global', { status: 'fact' });
    m.add('', '主人住在杭州市', 'global', { status: 'fact' });
    const entries = m.retention.entries();
    const row = entries.find((e) => e.text === '主人住在杭州');
    assert.equal(row.supersededBy, factIdOf('主人住在杭州市'), 'retention.entries 要导出');

    // dry-run normalizeEntry（target='facts'）
    const norm = normalizeEntry({ ...row }, 'facts');
    assert.equal(norm.supersededBy, row.supersededBy, 'dry-run 白名单要保');

    // backup restoreRetentionRows：捕获 insertRaw 收到的 row
    let inserted = null;
    const fakeMemory = { retention: { entries: () => [] }, insertRaw: (r) => { inserted = r; return true; } };
    restoreRetentionRows({ payload: { facts: [row], journal: [] }, memory: fakeMemory, journal: {} });
    assert.equal(inserted?.supersededBy, row.supersededBy, 'backup 白名单要保');

    // insertRaw 落盘
    const f2 = fresh();
    try {
      const m2 = createMemory({ now: () => 1000, log: () => {} });
      m2.insertRaw(row);
      const raw = JSON.parse(readFileSync(f2.file, 'utf8'));
      assert.equal(raw.meta.global['主人住在杭州'].supersededBy, row.supersededBy, 'insertRaw 要落盘');
    } finally { f2.done(); }
  } finally { f.done(); }
});

test('G8 四处白名单：entries/normalizeEntry/backup/insertRaw 都保注入热度字段', () => {
  const f = fresh();
  try {
    const m = createMemory({ now: () => Date.parse('2026-11-24T12:00:00'), log: () => {} });
    m.add('', '主人住在杭州', 'global', { status: 'fact' });
    m.bumpHeat([{ text: '主人住在杭州', hitDays: 7, lastHitDay: '2026-11-24', lastHit: 1700000000000 }]);

    // 1) retention.entries 导出
    const row = m.retention.entries().find((e) => e.text === '主人住在杭州');
    assert.equal(row.hitDays, 7, 'entries 导出 hitDays');
    assert.equal(row.lastHitDay, '2026-11-24');
    assert.equal(row.lastHit, 1700000000000);

    // 2) dry-run normalizeEntry 保
    const norm = normalizeEntry({ ...row }, 'facts');
    assert.equal(norm.hitDays, 7, 'dry-run 白名单保 hitDays');
    assert.equal(norm.lastHitDay, '2026-11-24');
    assert.equal(norm.lastHit, 1700000000000);

    // 3) backup restoreRetentionRows 保
    let inserted = null;
    const fakeMemory = { retention: { entries: () => [] }, insertRaw: (r) => { inserted = r; return true; } };
    restoreRetentionRows({ payload: { facts: [row], journal: [] }, memory: fakeMemory, journal: {} });
    assert.equal(inserted?.hitDays, 7, 'backup 白名单保 hitDays');
    assert.equal(inserted?.lastHitDay, '2026-11-24');
    assert.equal(inserted?.lastHit, 1700000000000);

    // 4) insertRaw 落盘
    const f2 = fresh();
    try {
      const m2 = createMemory({ now: () => 1000, log: () => {} });
      m2.insertRaw(row);
      const raw = JSON.parse(readFileSync(f2.file, 'utf8'));
      const meta = raw.meta.global['主人住在杭州'];
      assert.equal(meta.hitDays, 7, 'insertRaw 落盘 hitDays');
      assert.equal(meta.lastHitDay, '2026-11-24');
      assert.equal(meta.lastHit, 1700000000000);
    } finally { f2.done(); }
  } finally { f.done(); }
});

/* ---------------- 变更留痕（changes / updatedAt，参照 mem0 的 history 表） ----------------
 *
 * 硬规矩三条：
 *   · 新建事实**不写**这两个字段（老库与精简口径都不变）；
 *   · 只有"别的字段表达不出来"的动作才记（edit / archive / unarchive / expire / restore）；
 *   · supersede 不记——`until` + `supersededBy` 已经能还原整条链，抄一遍就是双份真相。
 */

test('留痕：改正文记下旧说法（否则 delete mm[旧文本] 一执行就永久丢失）', () => {
  const f = fresh();
  try {
    const m = createMemory({ now: () => 1000, log: () => {} });
    m.add('', '主人住在杭州', 'global', {});
    const r = m.editFact('', 'global', '主人住在杭州', { text: '主人住在上海' });
    assert.equal(r.ok, true, r.message);

    const meta = JSON.parse(readFileSync(f.file, 'utf8')).meta.global['主人住在上海'];
    assert.equal(meta.updatedAt, 1000, '结构性修改要写 updatedAt');
    assert.equal(meta.changes.length, 1);
    assert.equal(meta.changes[0].event, 'edit');
    assert.equal(meta.changes[0].from, '主人住在杭州', '旧说法必须留下来');
    assert.equal(meta.changes[0].to, '主人住在上海');
  } finally { f.done(); }
});

test('留痕：环形 6 条，第 7 次改把最早那条挤掉', () => {
  const f = fresh();
  try {
    let clock = 1000;
    const m = createMemory({ now: () => clock, log: () => {} });
    m.add('', 'v0', 'global', {});
    for (let i = 1; i <= 7; i += 1) {
      clock = 1000 + i * 100;
      const r = m.editFact('', 'global', `v${i - 1}`, { text: `v${i}` });
      assert.equal(r.ok, true, r.message);
    }
    const meta = JSON.parse(readFileSync(f.file, 'utf8')).meta.global.v7;
    assert.equal(meta.changes.length, 6, '环形上限 6');
    assert.equal(meta.changes.at(-1).from, 'v6', '最后一条是最近一次改动');
    assert.equal(meta.changes.at(-1).at, 1700);
    assert.equal(meta.changes[0].from, 'v1', '最早那条（v0→v1）已被挤掉');
  } finally { f.done(); }
});

test('留痕：只改 pin/tier 也记一条，但没有 from（正文没动）', () => {
  const f = fresh();
  try {
    const m = createMemory({ now: () => 2000, log: () => {} });
    m.add('', '主人住在杭州', 'global', {});
    m.editFact('', 'global', '主人住在杭州', { pin: 0.5 });
    const meta = JSON.parse(readFileSync(f.file, 'utf8')).meta.global['主人住在杭州'];
    assert.equal(meta.changes.length, 1);
    assert.equal(meta.changes[0].event, 'edit');
    assert.equal(meta.changes[0].from, undefined, '正文没改就不该有 from');
    assert.equal(meta.updatedAt, 2000);
  } finally { f.done(); }
});

test('留痕：归档 / 取消归档用事件名区分（archivedAt 只有时间点，说不出哪种）', () => {
  const f = fresh();
  try {
    const m = createMemory({ now: () => 3000, log: () => {} });
    m.add('', '主人住在杭州', 'global', {});
    m.editFact('', 'global', '主人住在杭州', { archivedAt: 3000 });
    m.editFact('', 'global', '主人住在杭州', { archivedAt: 0 });
    const meta = JSON.parse(readFileSync(f.file, 'utf8')).meta.global['主人住在杭州'];
    assert.deepEqual(meta.changes.map((c) => c.event), ['archive', 'unarchive']);
  } finally { f.done(); }
});

test('留痕：supersede 只写 updatedAt，不写 changes（不造双份真相）', () => {
  const f = fresh();
  try {
    const m = createMemory({ now: () => 1000, log: () => {} });
    m.add('', '主人住在杭州', 'global', { status: 'fact' });
    m.add('', '主人住在杭州市', 'global', { status: 'fact' });
    const oldMeta = JSON.parse(readFileSync(f.file, 'utf8')).meta.global['主人住在杭州'];
    assert.equal(typeof oldMeta.until, 'number', '先确认真的被顶掉了');
    assert.equal(oldMeta.updatedAt, 1000, '被顶掉也算结构性修改');
    assert.equal(oldMeta.changes, undefined, '不记事件：until + supersededBy 已经是完整证据');
  } finally { f.done(); }
});

test('留痕：expire / restore 各留一条（恢复后 until 被删，只这条能说明"曾经失效过"）', () => {
  const f = fresh();
  try {
    let clock = 4000;
    const m = createMemory({ now: () => clock, log: () => {} });
    m.add('', '主人住在杭州', 'global', {});
    m.retention.expire([{ scope: 'global', chatId: '', text: '主人住在杭州' }], 7000);
    let meta = JSON.parse(readFileSync(f.file, 'utf8')).meta.global['主人住在杭州'];
    assert.equal(meta.changes.at(-1).event, 'expire');
    assert.equal(meta.updatedAt, 7000);

    clock = 8000;
    m.retention.restore([{ scope: 'global', chatId: '', text: '主人住在杭州' }]);
    meta = JSON.parse(readFileSync(f.file, 'utf8')).meta.global['主人住在杭州'];
    assert.equal(meta.changes.at(-1).event, 'restore');
    assert.equal(meta.updatedAt, 8000);
    assert.equal(meta.until, undefined, '恢复就是真恢复');
  } finally { f.done(); }
});

test('留痕：新建事实不写 updatedAt/changes（老库与精简口径都不变）', () => {
  const f = fresh();
  try {
    const m = createMemory({ now: () => 1000, log: () => {} });
    m.add('', '主人住在杭州', 'global', {});
    const meta = JSON.parse(readFileSync(f.file, 'utf8')).meta.global['主人住在杭州'];
    assert.equal(meta.updatedAt, undefined, '新建时不落盘（at 就是创建时间）');
    assert.equal(meta.changes, undefined);
  } finally { f.done(); }
});

test('四处白名单：entries/normalizeEntry/backup/insertRaw 都保 updatedAt + changes', () => {
  const f = fresh();
  try {
    const m = createMemory({ now: () => 1000, log: () => {} });
    m.add('', '主人住在杭州', 'global', {});
    m.editFact('', 'global', '主人住在杭州', { text: '主人住在上海' });

    const row = m.retention.entries().find((e) => e.text === '主人住在上海');
    assert.equal(row.updatedAt, 1000, 'entries 导出 updatedAt');
    assert.equal(row.changes.length, 1, 'entries 导出 changes');
    assert.equal(row.changes[0].from, '主人住在杭州');

    const norm = normalizeEntry({ ...row }, 'facts');
    assert.equal(norm.updatedAt, 1000, 'dry-run 白名单要保');
    assert.equal(norm.changes.length, 1);

    let inserted = null;
    const fakeMemory = { retention: { entries: () => [] }, insertRaw: (r) => { inserted = r; return true; } };
    restoreRetentionRows({ payload: { facts: [row], journal: [] }, memory: fakeMemory, journal: {} });
    assert.equal(inserted?.updatedAt, 1000, 'backup 白名单要保');
    assert.equal(inserted?.changes?.length, 1);

    const f2 = fresh();
    try {
      const m2 = createMemory({ now: () => 1000, log: () => {} });
      m2.insertRaw(row);
      const meta = JSON.parse(readFileSync(f2.file, 'utf8')).meta.global['主人住在上海'];
      assert.equal(meta.updatedAt, 1000, 'insertRaw 要落盘');
      assert.equal(meta.changes[0].from, '主人住在杭州');
    } finally { f2.done(); }
  } finally { f.done(); }
});
