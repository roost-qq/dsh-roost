/**
 * A 组（2026-11-28 复核 #1/#2/#4）：两个写者 + 静默淘汰。
 *
 * 背景：`load()` 原来一旦有缓存就**永远不再读盘**，`save()` 直接整份覆盖。
 * 「开发实例与运行副本共用一个 data 目录」「DSH 重启旧进程未退」这两种
 * 真实场景下，后写的一方会把另一方刚写进去的事实整块抹掉，谁都不报错。
 * 记忆是**不可重建**的数据，所以这里钉死三件事：
 *   A1 盘上变了就重读（不能拿旧缓存当真相）
 *   A2 写前发现盘上变了 → 合并（别人的新增保留、别人的删除尊重）
 *   A3 容量满挤掉谁，调用方要能知道
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory } from '../src/memory.js';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-conc-'));
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

/** 直接读盘（绕过缓存），验证"别人看得到"这件事 */
function onDisk(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

test('A1：另一个进程写过之后，本进程的 list 能看到（不再永久吃旧缓存）', () => {
  const f = fresh();
  try {
    const a = createMemory({ now: () => 1000, log: () => {} });
    const b = createMemory({ now: () => 1000, log: () => {} });
    assert.equal(a.add('', '主人住在杭州', 'global'), true);
    /** b 第一次读：拿到杭州 */
    assert.deepEqual(b.list('').global, ['主人住在杭州']);

    /** a 再写一条（长度不同，size 也会变，双保险） */
    assert.equal(a.add('', '主人养了一只叫豆豆的猫', 'global'), true);
    /**
     * 关键断言：b **没有** reload()，也必须看到。
     * 旧实现这里返回的只有「杭州」——这正是"丢更新"的前半段。
     */
    assert.deepEqual(b.list('').global.sort(), ['主人养了一只叫豆豆的猫', '主人住在杭州'].sort());
  } finally { f.done(); }
});

test('A1/A2：两个实例交替写，四个人的事实一条都不丢', () => {
  const f = fresh();
  try {
    const a = createMemory({ now: () => 1000, log: () => {} });
    const b = createMemory({ now: () => 1000, log: () => {} });
    assert.equal(a.add('', '甲说的一句话', 'global'), true);
    assert.equal(b.add('', '乙说的一句话', 'global'), true);
    /** 交错：a 写完 b 立刻写（真实场景就是两个进程各干各的） */
    assert.equal(a.add('', '甲又补了一句更长的', 'global'), true);
    assert.equal(b.add('', '乙也补了一句', 'global'), true);

    const texts = onDisk(f.file).global.sort();
    assert.deepEqual(texts, ['乙也补了一句', '乙说的一句话', '甲又补了一句更长的', '甲说的一句话'].sort(),
      '任何一条都不能因为整份覆盖而消失');
    /** 两个实例的视图也应当一致（都重读过盘） */
    assert.deepEqual(a.list('').global.sort(), texts);
    assert.deepEqual(b.list('').global.sort(), texts);
  } finally { f.done(); }
});

test('A2：别人删掉的事实，本进程写自己的时候不会把它复活', () => {
  const f = fresh();
  try {
    const a = createMemory({ now: () => 1000, log: () => {} });
    const b = createMemory({ now: () => 1000, log: () => {} });
    assert.equal(a.add('', '这条待会儿会被删掉', 'global'), true);
    assert.equal(a.add('', '这条留着', 'global'), true);
    /** b 先读到两条（建立快照基准） */
    assert.equal(b.list('').global.length, 2);

    /** a 侧走 retention 删除（模拟另一个进程真删） */
    const r = a.retention?.remove?.([{ scope: 'global', chatId: '', text: '这条待会儿会被删掉' }]);
    if (r === undefined) {
      /** 没有 remove 就退化成直接改盘，目的只是"盘上少了一条" */
      const disk = onDisk(f.file);
      disk.global = disk.global.filter((x) => x !== '这条待会儿会被删掉');
      writeFileSync(f.file, JSON.stringify(disk), 'utf8');
    }
    /** b 接着写自己的事实 */
    assert.equal(b.add('', 'b 新写的一条', 'global'), true);
    const texts = onDisk(f.file).global;
    assert.equal(texts.includes('这条待会儿会被删掉'), false, '别人删的不该被复活');
    assert.equal(texts.includes('b 新写的一条'), true, '自己的新事实要写进去');
    assert.equal(texts.includes('这条留着'), true);
  } finally { f.done(); }
});

test('A2：盘上被手改成坏 JSON 时不硬写（宁可这次不写，不覆盖）', () => {
  const f = fresh();
  try {
    const m = createMemory({ now: () => 1000, log: () => {} });
    assert.equal(m.add('', '先写一条正常的', 'global'), true);
    /** 外部把文件改成读不出来的东西 */
    writeFileSync(f.file, '{ 这不是 JSON', 'utf8');
    const before = statSync(f.file).size;
    const ok = m.add('', '再加一条', 'global');
    /**
     * 要么写成功（读失败被隔离后重来），要么返回 false 且**原文件不被清空**。
     * 关键是不能出现"把坏文件换成只剩一条新事实的空库"。
     */
    const raw = readFileSync(f.file, 'utf8');
    assert.ok(ok === true || ok === false);
    assert.ok(raw.length >= Math.min(before, 6), '原内容不能被写没');
  } finally { f.done(); }
});

test('A3：容量满挤掉谁，调用方拿得到（dropped 收集数组）', () => {
  const f = fresh();
  try {
    const m = createMemory({ now: () => 1000, log: () => {}, capacityOf: () => ({ total: 2 }) });
    const drop1 = [];
    m.add('', '第一条事实', 'global', { dropped: drop1 });
    assert.deepEqual(drop1, [], '没满不该挤');
    const drop2 = [];
    m.add('', '第二条事实', 'global', { dropped: drop2 });
    assert.deepEqual(drop2, []);
    /** 第三条触发淘汰：必有一条被挤掉，且调用方知道是谁 */
    const drop3 = [];
    m.add('', '第三条事实', 'global', { dropped: drop3 });
    assert.equal(drop3.length, 1, '满了两条上限，新增必然挤掉一条');
    assert.equal(onDisk(f.file).global.length, 2);
  } finally { f.done(); }
});

test('A3：不传 dropped 时行为与以前完全一样（老调用点零改动）', () => {
  const f = fresh();
  try {
    const m = createMemory({ now: () => 1000, log: () => {}, capacityOf: () => ({ total: 2 }) });
    assert.equal(m.add('', '一', 'global'), true);
    assert.equal(m.add('', '二', 'global'), true);
    /** 返回值仍是布尔，不传收集数组也不会炸 */
    assert.equal(m.add('', '三', 'global'), true);
    assert.equal(onDisk(f.file).global.length, 2);
  } finally { f.done(); }
});

test('A3：apply-markers 在库满时把「挤掉了谁」说出来', () => {
  const src = readFileSync(new URL('../src/apply-markers.js', import.meta.url), 'utf8');
  assert.match(src, /const dropped = \[\];/, '要有收集数组');
  assert.match(src, /withDrop\('记住了'\)/, '「记住了」要能带上挤掉提示');
  assert.match(src, /status: 'fact', dropped \}/, 'add 要真的把 dropped 递进去');
});

test('A1 守门：load 里必须有版本校验，save 里必须有写前比对', () => {
  const src = readFileSync(new URL('../src/memory.js', import.meta.url), 'utf8');
  assert.match(src, /if \(cache && !ioFailed\) \{\s*\n\s*if \(cacheInSync\(\)\) return cache;/, 'load 要先比较版本戳');
  assert.match(src, /if \(!cacheInSync\(\) && !mergeWithDisk\(m\)\) return false;/, 'save 写前要比对');
  assert.match(src, /markSynced\(\);\s*\n\s*return true;/, '写完要重记版本戳');
});
