// 抽取噪声：她对自己能力的元评论、模糊的自我性格评价，不该进长期事实。
//
// 这条线必须划在「说的是谁」上：
//   我有点社恐      → 拦（她照着演）
//   主人有点社恐    → 不拦（关于主人的有用事实）
// 显式入口（<<remember>> / 面板手记）根本不走这里，用户意思优先于启发式。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isNoiseFact, normalizeAgreement } from '../src/consolidate.js';

test('噪声：自我元评论会被拦', () => {
  assert.equal(isNoiseFact('我可以帮你记住这件事'), true);
  assert.equal(isNoiseFact('她会提醒你的'), true);
  assert.equal(isNoiseFact('我的记忆力不太好'), true);
  assert.equal(isNoiseFact('我能记住这些'), true);
});

test('噪声：模糊自我性格评价会被拦', () => {
  assert.equal(isNoiseFact('我有点社恐'), true);
  assert.equal(isNoiseFact('她比较内向'), true);
  assert.equal(isNoiseFact('我有点emo'), true);
  assert.equal(isNoiseFact('我不擅长聊天'), true);
});

test('噪声：关于主人的同类描述不拦（最容易误伤的地方）', () => {
  assert.equal(isNoiseFact('主人有点社恐'), false, '说的是主人，不是她自己');
  assert.equal(isNoiseFact('主人让我提醒他周四交材料'), false, '「提醒」是她要做的事，不是元评论');
  assert.equal(isNoiseFact('主人记忆力不太好，重要的事要重复一遍'), false);
  assert.equal(isNoiseFact('主人比较内向，群里不太说话'), false);
});

test('噪声：普通约定与正常事实一律不拦', () => {
  assert.equal(isNoiseFact('主人要求周五前把方案发出去'), false);
  assert.equal(isNoiseFact('约定：以后用 Markdown 回复'), false);
  assert.equal(isNoiseFact(''), false);
  assert.equal(isNoiseFact(null), false);
});

test('接线：normalizeAgreement 把噪声条目退化成空 text（调用方 continue 跳过）', () => {
  /** 输出形状不变：不新增字段，只让 text 变空 */
  const noise = normalizeAgreement({ text: '我有点社恐', op: 'add' });
  assert.equal(noise.text, '', '噪声条目 text 为空');
  assert.deepEqual(Object.keys(noise).sort(), ['old', 'op', 'status', 'text'], '不新增输出字段');

  const ok = normalizeAgreement({ text: '主人要求周五前把方案发出去', op: 'add' });
  assert.equal(ok.text, '主人要求周五前把方案发出去');

  /** 老格式（纯字符串）仍然按新增处理，噪声同样被挡 */
  assert.equal(normalizeAgreement('我有点社恐').text, '');
  assert.equal(normalizeAgreement('主人喜欢吃辣').text, '主人喜欢吃辣');
});

test('接线：被拦的条目不会带出 followUp（否则会挂一条永远问不出口的跟进）', () => {
  const r = normalizeAgreement({ text: '我会提醒你的', op: 'add', followUp: { inDays: 3, question: '提醒了吗' } });
  assert.equal(r.text, '');
  assert.equal(r.followUp, undefined);
});
