// 按序号引用：一批攒了好几句时，让模型明确选「回的是哪句」。
//
// 2026-11-27 截图里的错位：回的是「时雨喜欢小男孩」，引用块却挂在随后补发的
// 狗图上——旧实现把 `batch.msg`（永远是末条）的 msgIdx 当引用目标。现在批里
// 每条带 #N 给模型看，映射由程序查表，绝不让她抄 135 字符的 REFIDX。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMerger } from '../src/roost-merge.js';
import { createActionRunner } from '../src/outbound-actions.js';

const evt = (content, refIdx, name = '甲') => ({
  chat: { chatId: 'g1', kind: 'group' },
  scene: { msgIdx: refIdx },
  content,
  sender: { openid: `u-${name}`, name },
  attachments: [],
});

/** 用真 merger 攒一批，拿到的是宿主实际交给 deliverBatch 的那个形状 */
async function flush(items) {
  let got = null;
  const m = createMerger({ waitSec: 0.02, groupWaitSec: 0.02, onFlush: (_chatId, b) => { got = b; } });
  for (const it of items) m.add(it);
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(got, '攒批没有 flush');
  return got;
}

function fakeChannel() {
  const calls = [];
  return {
    calls,
    async send(p) { calls.push(['send', p]); return { ok: true, id: 'm1' }; },
    async sendFile(p) { calls.push(['file', p]); return { ok: true }; },
    async sendVoice(p) { calls.push(['voice', p]); return { ok: true }; },
    async retract(p) { calls.push(['retract', p]); return { ok: true }; },
    async uploadMarkdownImage() { return { url: 'qqbot-media://x', imageId: 'i1' }; },
  };
}

/** 跑一次真实出站，返回发出去的 message_reference.message_id（没挂就是 null） */
async function refOf(text, { quoteRefs = [], quoteRef = '', replyTo = '' } = {}) {
  const ch = fakeChannel();
  const run = createActionRunner({ channel: () => ch });
  await run({ text, target: 'g1', quoteRefs, quoteRef, replyTo });
  const p = ch.calls.find((c) => c[0] === 'send')?.[1];
  return p?.messageReference?.message_id ?? null;
}

test('攒批保留每条的序号和引用索引；被动回复仍用末条', async () => {
  const b = await flush([
    evt('时雨喜欢小男孩', 'REFIDX_A', '奈波'),
    evt('', 'REFIDX_B', '好涩友友哦'),
  ]);
  assert.equal(b.count, 2);
  assert.equal(b.msg.scene.msgIdx, 'REFIDX_B', 'msgId/被动窗口不能跟着改，否则回不出去');
  assert.match(b.numberedText, /^#1 /);
  assert.match(b.numberedText, /#2 /);
  assert.deepEqual(b.refs, [
    { n: 1, refIdx: 'REFIDX_A' },
    { n: 2, refIdx: 'REFIDX_B' },
  ]);
});

test('<<quote: #1>> 引用第一条，不再是固定末条', async () => {
  const b = await flush([evt('时雨喜欢小男孩', 'REFIDX_A'), evt('', 'REFIDX_B')]);
  assert.equal(await refOf('诶？不是的哦 <<quote: #1>>', { quoteRefs: b.refs }), 'REFIDX_A');
  assert.equal(await refOf('对，就是这张 <<quote: #2>>', { quoteRefs: b.refs }), 'REFIDX_B');
});

test('编造的序号 / 旧文字写法 / replyTo 兜底都不引用（宁可不挂，不许挂错）', async () => {
  const b = await flush([evt('甲这句', 'REFIDX_A'), evt('乙这句', 'REFIDX_B')]);
  assert.equal(await refOf('回你 <<quote: #9>>', { quoteRefs: b.refs }), null, '本轮没有的序号不能引用');
  assert.equal(await refOf('回你 <<quote: 甲这句>>', { quoteRefs: b.refs }), null, '文字不是索引，别猜');
  assert.equal(
    await refOf('回你 <<quote:>>', { quoteRefs: b.refs, replyTo: 'MSG_ID_OF_SOMEONE' }),
    null,
    'replyTo 是用户引用了谁，不再是她回谁',
  );
});

test('显式序号优先于自动引用；单条消息的自动引用照旧工作', async () => {
  const b = await flush([evt('甲这句', 'REFIDX_A'), evt('乙这句', 'REFIDX_B')]);
  assert.equal(
    await refOf('回你 <<quote: #1>>', { quoteRefs: b.refs, quoteRef: 'REFIDX_B' }),
    'REFIDX_A',
    '明确点了序号就不该被概率覆盖',
  );
  assert.equal(
    await refOf('普通一句', { quoteRefs: [{ n: 1, refIdx: 'REFIDX_A' }], quoteRef: 'REFIDX_A' }),
    'REFIDX_A',
  );
});

test('没有 msgIdx 的事件（频道/主动轮）写 #N 也不硬凑索引', async () => {
  const b = await flush([evt('甲', ''), evt('乙', 'REFIDX_B')]);
  assert.equal(await refOf('回你 <<quote: #1>>', { quoteRefs: b.refs }), null);
  assert.equal(await refOf('回你 <<quote: #2>>', { quoteRefs: b.refs }), 'REFIDX_B');
});
