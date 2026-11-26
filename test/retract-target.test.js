// `qq_retract` 的两块纯逻辑：挑哪条、失败怎么说。
//
// 挑错 = 撤了不该撤的消息（社交事故）；失败说错 = 模型原地重试、白烧一轮。
// 两种都不会抛异常，所以只能靠断言钉住。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RETRACT_LIMIT_MS,
  RETRACT_MAX_INDEX,
  pickRetractTarget,
  explainRetractFailure,
} from '../src/retract-target.js';

/** 造一份「最近发过的消息」，最新在前（`recentSentOf` 的顺序） */
const listOf = (...ages) => ages.map((age, i) => ({
  id: `m${i + 1}`,
  kind: 'group',
  at: 1_000_000 - age,
}));

const NOW = 1_000_000;

test('时限是官方那 2 分钟', () => {
  assert.equal(RETRACT_LIMIT_MS, 120_000);
});

test('index 缺省 = 最近一条', () => {
  const r = pickRetractTarget(listOf(1_000, 5_000), undefined, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.n, 1);
  assert.equal(r.rec.id, 'm1');
});

test('index=2 拿倒数第二条', () => {
  const r = pickRetractTarget(listOf(1_000, 5_000), 2, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.rec.id, 'm2');
});

test('越界 / 负数 / 小数夹到 1..5，不报错也不撤错人', () => {
  for (const [input, want] of [[0, 1], [-3, 1], [2.7, 2], [99, RETRACT_MAX_INDEX], ['3', 3]]) {
    const r = pickRetractTarget(listOf(1, 2, 3, 4, 5, 6, 7), input, NOW);
    assert.equal(r.ok, true, `index=${input}`);
    assert.equal(r.n, want, `index=${input} 应夹到 ${want}`);
  }
});

test('超出实际条数时拒绝，不返回 undefined 崩在后面', () => {
  const r = pickRetractTarget(listOf(1_000), 3, NOW);
  assert.equal(r.ok, false);
  assert.match(r.message, /没拿到消息号/);
});

test('消息号缺失就拒绝（主动消息 / 试运行没有 id）', () => {
  const r = pickRetractTarget([{ id: '', kind: 'group', at: NOW }], 1, NOW);
  assert.equal(r.ok, false);
  assert.match(r.message, /撤不了/);
});

test('刚好 2 分钟还放行，超 1 毫秒才拒（临界交给服务端）', () => {
  const atLimit = pickRetractTarget(listOf(RETRACT_LIMIT_MS), 1, NOW);
  assert.equal(atLimit.ok, true, '正好 120 秒不该本地拦');

  const over = pickRetractTarget(listOf(RETRACT_LIMIT_MS + 1), 1, NOW);
  assert.equal(over.ok, false);
  assert.match(over.message, /120 秒/);
  assert.match(over.message, /别重试/, '超时必须劝阻重试');
});

test('列表为空 / 不是数组都不抛', () => {
  for (const list of [[], null, undefined, 'x']) {
    const r = pickRetractTarget(list, 1, NOW);
    assert.equal(r.ok, false);
  }
});

test('失败翻译：40064004 说超时且劝别重试', () => {
  const s = explainRetractFailure({ qqCode: 40064004, message: 'raw' });
  assert.match(s, /2 分钟/);
  assert.match(s, /别重试/);
  assert.doesNotMatch(s, /raw/, '不要把官方原文直接丢给模型');
});

test('失败翻译：40062003 说权限，且点明「撤别人的要先设群管理员」', () => {
  const s = explainRetractFailure({ qqCode: 40062003 });
  assert.match(s, /权限/);
  assert.match(s, /群管理员/);
  assert.match(s, /别重试/);
});

test('未知失败带上原始 message 并劝阻反复重试', () => {
  const s = explainRetractFailure({ message: 'HTTP 500' });
  assert.match(s, /HTTP 500/);
  assert.match(s, /别反复重试/);
});

test('失败翻译对空输入不抛', () => {
  assert.match(explainRetractFailure(), /没撤成/);
  assert.match(explainRetractFailure({}), /没撤成/);
});
