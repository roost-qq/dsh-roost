// 自动引用回复：要不要挂、引用谁。
//
// 这段判错的两种方式都不报错：该挂的不挂（信息丢了，看不出来）、
// 不该挂的每句都挂（群里刷屏，也看不出来）。所以断言盯边界，不盯措辞。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pickQuoteRef, DEFAULT_QUOTE_PERCENT } from '../src/quote-auto.js';

/** 固定随机源：返回给定值，让「掷骰子」变成确定行为 */
const fixed = (v) => () => v;

test('默认概率是 40（和 config.js 的 qqTools.quote.percent 一致）', () => {
  assert.equal(DEFAULT_QUOTE_PERCENT, 40);
});

test('开关关着永不引用：false 和字符串 "false" 都算关', () => {
  for (const enabled of [false, 'false', 'FALSE', ' false ']) {
    const out = pickQuoteRef({ enabled, percent: 100, refIdx: 'REFIDX_1', rand: fixed(0) });
    assert.equal(out, '', `enabled=${JSON.stringify(enabled)} 应该关掉`);
  }
});

test('percent=0 永不引用，percent=100 必引用', () => {
  assert.equal(pickQuoteRef({ percent: 0, refIdx: 'REFIDX_1', rand: fixed(0) }), '');
  assert.equal(pickQuoteRef({ percent: 100, refIdx: 'REFIDX_1', rand: fixed(0.999) }), 'REFIDX_1');
});

test('40% 的边界：0.39 命中、0.40 不命中', () => {
  /** 用 `<` 而不是 `<=`：百分位是 [0,100) 均匀分布，0.4 落在第 40 个百分位之后 */
  assert.equal(pickQuoteRef({ percent: 40, refIdx: 'REFIDX_1', rand: fixed(0.39) }), 'REFIDX_1');
  assert.equal(pickQuoteRef({ percent: 40, refIdx: 'REFIDX_1', rand: fixed(0.4) }), '');
});

test('没有引用索引就不挂（频道消息 / 主动搭话轮）', () => {
  for (const refIdx of ['', '   ', null, undefined]) {
    assert.equal(pickQuoteRef({ percent: 100, refIdx, rand: fixed(0) }), '', `${refIdx} 不该挂`);
  }
});

test('越界概率夹到 0..100，不会变成「负数=必挂」或「200=必挂两次」', () => {
  assert.equal(pickQuoteRef({ percent: -10, refIdx: 'REFIDX_1', rand: fixed(0.5) }), '');
  assert.equal(pickQuoteRef({ percent: 200, refIdx: 'REFIDX_1', rand: fixed(0.999) }), 'REFIDX_1');
});

test('概率是 NaN / 非数字时按缺省 40 算，不靠运气', () => {
  for (const percent of ['abc', NaN, null, undefined]) {
    assert.equal(pickQuoteRef({ percent, refIdx: 'R', rand: fixed(0.39) }), 'R', `${percent} 应该按 40 算`);
    assert.equal(pickQuoteRef({ percent, refIdx: 'R', rand: fixed(0.41) }), '', `${percent} 应该按 40 算`);
  }
});

test('索引两侧空白会被修掉，超长按 512 截断', () => {
  assert.equal(pickQuoteRef({ percent: 100, refIdx: '  REFIDX_1  ', rand: fixed(0) }), 'REFIDX_1');
  const long = 'R'.repeat(600);
  assert.equal(pickQuoteRef({ percent: 100, refIdx: long, rand: fixed(0) }).length, 512);
});

test('135 字符的真实 REFIDX 必须原样保留（2026-11-26 的 7 字符截断事故）', () => {
  /**
   * 官方 `msg_idx` 是 `REFIDX_` + 128 位 base64 = **135 字符**。以前这里截到
   * 128，正好砍掉最后 7 位：报文照样发得出去，QQ 静默忽略这个非法的
   * `message_reference`，表现就是「概率设 100% 也不引用」，不报错不写日志，
   * 投递记录还显示 sent。主人连问三次才查出来。
   *
   * 这条锁住「别再把合法索引切坏」——`MAX_REF_IDX` 只能往大改，不能往小改。
   */
  const real = 'REFIDX_86oJDKVht5SLXUzGblNw4MCtHZUdvB90T97HRccvq2g9OK8tEVTk5s3R+L0vnHaF3dvEja3HLV5Kw2IJTgE3zODnij5vA1LMd0kadewsdY/uqu98iBBiEdnGC8JkBQQN';
  assert.equal(real.length, 135, '这是从真机事件里抄下来的长度');
  assert.equal(pickQuoteRef({ percent: 100, refIdx: real, rand: fixed(0) }), real);
});

test('引用的是本条消息自己的索引，不是 replyTo', () => {
  /**
   * 这条不是测函数，是测「别把 replyTo 传进来」的约定。
   * `replyTo` 是「用户这条消息引用了谁」，传错就会引用到更早的第三个人头上。
   */
  const out = pickQuoteRef({ percent: 100, refIdx: 'REFIDX_SELF', rand: fixed(0) });
  assert.equal(out, 'REFIDX_SELF');
});
