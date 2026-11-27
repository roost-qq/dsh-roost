// 人物身份基座（persons.json）+ 待确认别名队列。
//
// 这一层的存在理由只有一个：**删人不能按显示名删**。显示名会改名、会重名，
// 所以身份必须落成稳定 id，其余各层只做引用打标。
//
// 最容易静默出错的几处：
//   1. 空库/老库没人调就必须一个字都不写（默认行为零变化）；
//   2. `remembers()` 默认必须是 true，否则一上线所有人都被"遗忘"；
//   3. 换机器人后 openid 变了，同一 qq 不能裂成两条；
//   4. 待确认别名**不能**自动变成权威别名。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPersons, PERSONS_SCHEMA_VERSION } from '../src/persons.js';
import { createPendingAliases } from '../src/pending-aliases.js';

function fresh(t, name = 'persons.json') {
  const dir = mkdtempSync(join(tmpdir(), 'roost-persons-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
  return { file: join(dir, name), dir };
}

/* ---------------- persons ---------------- */

test('persons：空库不写盘，remembers() 默认 true（默认行为零变化）', (t) => {
  const { file } = fresh(t);
  const p = createPersons({ file, log: () => {} });
  assert.equal(p.remembers('u_unknown'), true, '没记录 = 还记着');
  assert.equal(p.remembers(''), true, '空 id 也不能返回 false');
  assert.equal(p.get('u_unknown'), null);
  assert.equal(existsSync(file), false, '只读操作不许建文件');
});

test('persons：setNoMemory 之后 remembers 为 false，恢复后回 true（幂等不刷新时间）', (t) => {
  const { file } = fresh(t);
  let clock = 1000;
  const p = createPersons({ file, now: () => clock, log: () => {} });
  p.see('u_a', { name: '小明' });
  assert.equal(p.remembers('u_a'), true);

  clock = 2000;
  assert.equal(p.setNoMemory('u_a', true).ok, true);
  const first = p.get('u_a').noMemoryAt;
  assert.equal(first, 2000);
  assert.equal(p.remembers('u_a'), false);

  clock = 3000;
  p.setNoMemory('u_a', true);
  assert.equal(p.get('u_a').noMemoryAt, 2000, '重复设同一个值不刷新时间');

  p.setNoMemory('u_a', false);
  assert.equal(p.remembers('u_a'), true);
  assert.equal(p.get('u_a').noMemoryAt, undefined, '恢复时清掉标记时间');
});

test('persons：换机器人（新 openid 挂同一 qq）不裂成两个人', (t) => {
  const { file } = fresh(t);
  const p = createPersons({ file, log: () => {} });
  p.see('openid-old', { name: '小明', qq: '10001' });
  /** 新 openid，但 qq 相同 → 归到同一条 */
  p.see('openid-new', { name: '小明', qq: '10001' });
  p.setNoMemory('10001', true);
  assert.equal(p.remembers('openid-old'), false, '按 qq 设的标记要能命中老 openid');
  assert.equal(p.remembers('openid-new'), false);
  assert.equal(p.size, 1, '同一个 qq 只能有一条记录');
});

test('persons：names 与 aliases 分离——见过的名字不等于确认过的别名', (t) => {
  const { file } = fresh(t);
  const p = createPersons({ file, log: () => {} });
  p.see('u_a', { name: '小明' });
  p.see('u_a', { name: '明明' });
  assert.deepEqual(p.get('u_a').names, ['小明', '明明']);
  assert.deepEqual(p.get('u_a').aliases, [], '光见过不能进 aliases（宁漏不误）');

  p.addAlias('u_a', '小明');
  assert.deepEqual(p.get('u_a').aliases, ['小明']);
  assert.deepEqual(p.namesOf('u_a').sort(), ['小明', '明明'].sort(), 'namesOf 取并集，注入侧过滤用');
});

test('persons：forgetVersion 递增，是在途写入的护栏', (t) => {
  const { file } = fresh(t);
  const p = createPersons({ file, log: () => {} });
  p.see('u_a', { name: '小明' });
  const v0 = p.forgetVersionOf('u_a');
  assert.equal(v0, 0);
  const v1 = p.bumpForgetVersion('u_a');
  assert.equal(v1, 1);
  assert.equal(p.forgetVersionOf('u_a'), 1);
  assert.equal(p.forgetVersionOf('u_nobody'), 0, '没记录时读版本不能建行');
});

test('persons：落盘可重载，空壳不写进文件', (t) => {
  const { file } = fresh(t);
  const p = createPersons({ file, log: () => {} });
  p.see('u_a', { name: '小明', qq: '10001' });
  p.setNoMemory('u_b', true); // 只有标记、没名字 —— 也要留（否则遗忘失效）
  p.get('u_never'); // 只读不建

  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.schemaVersion, PERSONS_SCHEMA_VERSION);
  assert.ok(raw.persons['u_a']);
  assert.ok(raw.persons['u_b'], '只有 noMemory 标记的记录必须落盘');
  assert.equal(raw.persons['u_never'], undefined);

  const p2 = createPersons({ file, log: () => {} });
  assert.equal(p2.remembers('u_b'), false, '重启后遗忘标记还在');
  assert.deepEqual(p2.get('u_a').names, ['小明']);
});

test('persons：坏文件 / 非对象结构不影响启动', (t) => {
  const { file } = fresh(t);
  writeFileSync(file, '{ 这不是 json');
  const p = createPersons({ file, log: () => {} });
  assert.equal(p.remembers('u_a'), true, '坏文件当成空表');

  writeFileSync(file, JSON.stringify({ persons: { a: null, b: { id: 'b', names: 'oops' } } }));
  const p2 = createPersons({ file, log: () => {} });
  assert.equal(p2.get('a'), null, 'null 记录跳过');
  assert.deepEqual(p2.get('b').names, [], '非法 names 归一成空数组');
});

/* ---------------- pending-aliases ---------------- */

test('pending-aliases：提议进队列、累加 hits，确认后出队且不自动写权威', (t) => {
  const { file } = fresh(t, 'pending-aliases.json');
  const q = createPendingAliases({ file, log: () => {} });
  q.see({ alias: '小明', person: '10001' });
  q.see({ alias: '小明', person: '10001' });
  q.see({ alias: '明明', person: '10001' });
  const list = q.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].alias, '小明', 'hits 多的排前面');
  assert.equal(list[0].hits, 2);

  const got = q.confirm('小明');
  assert.deepEqual({ alias: got.alias, person: got.person }, { alias: '小明', person: '10001' });
  assert.equal(q.size, 1, '确认后出队');
  assert.equal(q.list().length, 1);
  assert.equal(existsSync(file), true);
});

test('pending-aliases：同一个别名指向两个人时不自动合并，各记一条', (t) => {
  const { file } = fresh(t, 'pending-aliases.json');
  const q = createPendingAliases({ file, log: () => {} });
  q.see({ alias: '小明', person: '10001' });
  q.see({ alias: '小明', person: '10002' });
  assert.equal(q.list().length, 2, '冲突留给主人裁决');
  assert.equal(q.confirm('小明', '10002').person, '10002', '按 person 精确确认');
  assert.equal(q.list().length, 1);
});

test('pending-aliases：忽略后不再重复入队；空值/自己指向自己不收', (t) => {
  const { file } = fresh(t, 'pending-aliases.json');
  const q = createPendingAliases({ file, log: () => {} });
  assert.equal(q.see({ alias: '', person: '10001' }), null);
  assert.equal(q.see({ alias: '小明', person: '' }), null);
  assert.equal(q.see({ alias: '小明', person: '小明' }), null, '自己指向自己无意义');

  q.see({ alias: '小明', person: '10001' });
  q.ignore('小明');
  assert.equal(q.size, 0);
});
