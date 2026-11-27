// 顶替判据的**现状锁定表**（不是"理想表"）。
//
// 为什么要锁：这套判据是 `similarityOf`（bigram Dice）+ `conflicting()`，
// 阈值 0.75。任何一次"顺手调一下"都会让一批事实静默失效或静默并存，
// 而两条矛盾事实同时注入 = 她会说错话。所以先把现状写成表，改判据必须同步改表。
//
// 量出来的结论（2026-11-27）跟直觉相反：
//   · **假阳性 0 条**——不存在"过度去重"。0.75 很保守，`Max 露营` / `妈妈住苏州`
//     这类"同一实体、不同事件"的相似度只有 0.21–0.45，本来就不会被顶掉。
//   · **假阴性 8 条**——真正的问题是"该顶的没顶"：`住在杭州` vs `搬到上海`
//     只有 0.10，两条会长期并存。
// 所以**没有加"防过度去重"守卫**——那会挡住真改口，把问题做得更糟。
// 提升召回是另一件事（改阈值/改判据），必须单独一轮 + 这批样本做 A/B。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { similarityOf, conflicting } from '../src/memory.js';

const SUPERSEDE_SIM = 0.75;

/** now = 现在的实际结果；target = 应有的结果（两者不同的行就是待改进项） */
const CASES = [
  { a: '主人住在杭州', b: '主人住在杭州市', now: 'supersede', target: 'supersede' },
  { a: '主人住在杭州', b: '主人搬到上海了', now: 'keep', target: 'supersede' },
  { a: '主人喜欢喝咖啡', b: '主人喜欢喝美式咖啡', now: 'keep', target: 'supersede' },
  { a: '主人养的狗叫Max', b: '主人带Max去露营了', now: 'keep', target: 'keep' },
  { a: '主人养的狗叫Max', b: '主人养的猫叫小白', now: 'keep', target: 'keep' },
  { a: '主人对花生过敏', b: '主人对花生不过敏了', now: 'keep', target: 'supersede' },
  { a: '主人这周三加班', b: '主人这周四加班', now: 'keep', target: 'supersede' },
  { a: '主人在杭州工作', b: '主人在杭州工作两年了', now: 'keep', target: 'supersede' },
  { a: '主人的妈妈住在苏州', b: '主人的爸爸住在苏州', now: 'keep', target: 'keep' },
  { a: '主人每天早上跑步五公里', b: '主人每天早上跑步三公里', now: 'keep', target: 'supersede' },
  { a: '主人不喜欢吃香菜', b: '主人现在喜欢吃香菜了', now: 'keep', target: 'supersede' },
  { a: '主人用iPhone手机', b: '主人用安卓手机', now: 'keep', target: 'supersede' },
  { a: '主人有个弟弟叫小明', b: '主人有个妹妹叫小红', now: 'keep', target: 'keep' },
];

const verdictOf = (a, b) => (similarityOf(a, b) >= SUPERSEDE_SIM && !conflicting(a, b) ? 'supersede' : 'keep');

test('顶替判据现状：逐条锁定（改判据必须同步改这张表）', () => {
  for (const c of CASES) {
    assert.equal(verdictOf(c.a, c.b), c.now, `${c.a} ⇄ ${c.b}`);
  }
});

test('顶替判据：不存在"过度去重"——该并存的四条一条都没被顶掉', () => {
  const keepRows = CASES.filter((c) => c.target === 'keep');
  assert.equal(keepRows.length, 4);
  for (const c of keepRows) {
    assert.equal(verdictOf(c.a, c.b), 'keep', `${c.a} ⇄ ${c.b} 不该被顶掉`);
  }
});

test('顶替判据：已知欠顶替清单（将来提升召回时照这张单子验收）', () => {
  const missing = CASES.filter((c) => c.now !== c.target).map((c) => c.a);
  assert.equal(missing.length, 8, `欠顶替 ${missing.length} 条：${missing.join(' / ')}`);
});
