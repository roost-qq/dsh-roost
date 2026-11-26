/**
 * P2 三项：引用媒体摘要 / BMP 分层 / 显式引用回复
 * ==============================================
 *
 * 三项都刻意做成「默认零变化」，所以测试里「不带新特征时和以前一样」
 * 比「带新特征时生效」更重要。
 *
 * 跑法：node --test test/p2-context.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  describeQuoteAttachments, renderInbound, clipQuote,
} from '../src/inbound.js';
import { buildRendered, guessMime, sniffImageType } from '../src/roost-payload.js';
import { parseOutboundActions, createActionRunner } from '../src/outbound-actions.js';

/* ---------------- 1. 引用媒体摘要 ---------------- */

const quoteEls = (attachments) => ({
  elements: [{ type: 'quote', content: '你看这个', msgIdx: 'REFIDX_1', attachments }],
});

test('引用里带图：补上结构化摘要，并如实说看不到内容', () => {
  const evt = quoteEls([{
    type: 'image', filename: 'cat.png', width: 320, height: 240, size: 20480, contentType: 'image/png',
  }]);
  const lines = describeQuoteAttachments(evt);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /引用的消息里有张图/);
  assert.match(lines[0], /cat\.png/);
  assert.match(lines[0], /320×240/);
  assert.match(lines[0], /20KB/);
  assert.match(lines[0], /我看不到图的内容/, '不能谎称能看到');
});

test('引用里带语音：ASR 有就给文字，没有就说明没转出', () => {
  const withAsr = describeQuoteAttachments(quoteEls([{ type: 'voice', asrText: '明天见' }]));
  assert.match(withAsr[0], /转成文字是：明天见/);
  const noAsr = describeQuoteAttachments(quoteEls([{ type: 'voice', asrText: '' }]));
  assert.match(noAsr[0], /没转出文字/);
});

test('引用里带视频/文件/未知类型都有一句人话', () => {
  const lines = describeQuoteAttachments(quoteEls([
    { type: 'video', filename: 'a.mp4' },
    { type: 'file', filename: 'report.pdf', size: 1024 },
    { type: 'other', contentType: 'application/zip', filename: 'x.zip' },
  ]));
  assert.equal(lines.length, 3);
  assert.match(lines[0], /视频.*a\.mp4/);
  assert.match(lines[1], /文件：report\.pdf/);
  assert.match(lines[2], /application\/zip/);
});

test('没有 quote 元素 / 元素没附件 → 空数组（默认零变化）', () => {
  assert.deepEqual(describeQuoteAttachments({}), []);
  assert.deepEqual(describeQuoteAttachments({ elements: [{ type: 'text' }] }), []);
  assert.deepEqual(describeQuoteAttachments(quoteEls([])), []);
  assert.deepEqual(describeQuoteAttachments({ elements: null }), []);
});

test('两条渲染路径逐字一致（带引用附件时也必须一致）', () => {
  const long = '引'.repeat(2500);
  for (const evt of [{ quoted: long }, { quoted: '在吗', ...quoteEls([{ type: 'image', filename: 'a.png' }]) }]) {
    const viaFallback = renderInbound({ ...evt, text: '在吗' });
    const viaRendered = buildRendered(evt, '在吗');
    assert.equal(viaFallback, viaRendered);
  }
  /** 引用正文仍按 2000 截断，摘要不该把正文撑回去 */
  const out = buildRendered({ quoted: long, ...quoteEls([{ type: 'image' }]) }, '在吗');
  assert.ok(out.includes('…'));
  assert.ok(!out.includes('引'.repeat(2001)));
});

test('journal-bridge 的 quotedOf 不受影响（引用正文仍可反解）', () => {
  assert.equal(clipQuote('短引用'), '短引用');
  assert.match(renderInbound({ quoted: '原话' }), /（引用了这句：原话）/);
});

/* ---------------- 2. BMP 分层 ---------------- */

const bmp = () => Buffer.concat([Buffer.from([0x42, 0x4d]), Buffer.alloc(20)]);
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);

test('sniffImageType 认 BMP，guessMime 仍不认（模型白名单不变）', () => {
  assert.equal(sniffImageType(bmp()), 'image/bmp');
  assert.equal(guessMime(bmp(), 'image/png'), 'image/png', '原行为保留：认不出就退声明');
  assert.equal(guessMime(bmp(), ''), '');
});

test('sniffImageType 对四种受支持格式与 guessMime 一致', () => {
  assert.equal(sniffImageType(png()), 'image/png');
  assert.equal(sniffImageType(png()), guessMime(png(), ''));
  assert.equal(sniffImageType(Buffer.alloc(0)), '');
  assert.equal(sniffImageType(null), '');
});

test('BMP 落盘项：data 空 + unsupported 标记，下游不会喂模型', async () => {
  const { createPayloadBuilder } = await import('../src/roost-payload.js');
  const evt = {
    msgId: 'm1', eventId: 'e1', chat: { chatId: 'c1', kind: 'c2c' },
    sender: { openid: 'u1' }, at: Date.now(), content: '',
    attachments: [{ type: 'image', url: 'https://example.test/a.png', contentType: 'image/png' }],
  };
  const build = createPayloadBuilder({
    rpc: async () => ({ ok: true }),
    fetchImpl: async () => ({
      ok: true, status: 200,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => bmp().buffer.slice(bmp().byteOffset, bmp().byteOffset + bmp().byteLength),
    }),
    log: () => {},
  });
  const p = await build(evt);
  assert.equal(p.images.length, 1);
  assert.equal(p.images[0].unsupported, true);
  assert.equal(p.images[0].data, '', '空 data：turn.js / ext-llm 会自然跳过');
  assert.equal(p.images[0].mediaType, 'image/bmp');
  assert.match(p.images[0].name, /\.bmp$/, '落盘后缀校正了');
  assert.equal(p.images[0].index, 0, 'index 仍占位，配对不错位');
  assert.match(p.rendered, /BMP/);
  assert.match(p.rendered, /转成 PNG \/ JPG 重发/);
});

/* ---------------- 3. 显式引用回复 ---------------- */

function fakeChannel() {
  const calls = [];
  return {
    calls,
    async send(p) { calls.push(p); return { ok: true, id: 'm1' }; },
  };
}

test('不写 <<quote:>> 时 messageReference 是 null（默认零变化）', async () => {
  const ch = fakeChannel();
  const run = createActionRunner({ channel: () => ch });
  await run({ text: '普通回复', target: 'c1', replyTo: 'REFIDX_9' });
  assert.equal(ch.calls[0].messageReference, null);
});

test('<<quote: 索引>> 显式挂引用', async () => {
  const ch = fakeChannel();
  const run = createActionRunner({ channel: () => ch });
  await run({ text: '回你 <<quote: REFIDX_7>>', target: 'c1' });
  assert.deepEqual(ch.calls[0].messageReference, { message_id: 'REFIDX_7' });
  assert.doesNotMatch(ch.calls[0].text, /<</, '标记要摘干净');
});

test('<<quote:>> 留空时退回入站 replyTo', async () => {
  const ch = fakeChannel();
  const run = createActionRunner({ channel: () => ch });
  await run({ text: '回你 <<quote:>>', target: 'c1', replyTo: 'REFIDX_3' });
  assert.deepEqual(ch.calls[0].messageReference, { message_id: 'REFIDX_3' });
});

test('既没索引也没 replyTo：降级普通回复并留日志', async () => {
  const ch = fakeChannel();
  const logs = [];
  const run = createActionRunner({ channel: () => ch, log: (m) => logs.push(m) });
  await run({ text: '回你 <<quote:>>', target: 'c1' });
  assert.equal(ch.calls[0].messageReference, null);
  assert.ok(logs.some((m) => /没给索引/.test(m)));
});

test('parseOutboundActions 把 quote 单独摘出，不被通用兜底吃掉', () => {
  const { text, actions } = parseOutboundActions('好 <<quote: A>> <<pick: B|b>>');
  assert.doesNotMatch(text, /<</);
  assert.deepEqual(actions.map((a) => a.type), ['pick', 'quote']);
});

/* ---------------- 3b. 自动引用（宿主掷骰子给的 quoteRef） ---------------- */

test('自动引用：顶层 quoteRef 会挂到 messageReference 上', async () => {
  /**
   * **顶层，不是 `extra.quoteRef`。** 2026-11-26 这里写成 `extra.quoteRef`，
   * 宿主却在顶层传 `quoteRef` → 这个参数被解构丢掉，概率设 100% 也一条都不引用，
   * 而且不报错、不写日志（主人就是这么发现的）。这条测试锁住真实契约。
   */
  const ch = fakeChannel();
  const run = createActionRunner({ channel: () => ch });
  await run({ text: '普通回复', target: 'c1', quoteRef: 'REFIDX_AUTO' });
  assert.deepEqual(ch.calls[0].messageReference, { message_id: 'REFIDX_AUTO' });
});

test('自动引用：塞进 extra 不生效（位置写错要能被这条抓到）', async () => {
  const ch = fakeChannel();
  const run = createActionRunner({ channel: () => ch });
  await run({ text: '普通回复', target: 'c1', extra: { quoteRef: 'REFIDX_AUTO' } });
  assert.equal(ch.calls[0].messageReference, null);
});

test('显式 <<quote:>> 优先于自动引用（模型明确要求不该被概率覆盖）', async () => {
  const ch = fakeChannel();
  const run = createActionRunner({ channel: () => ch });
  await run({ text: '回你 <<quote: REFIDX_7>>', target: 'c1', quoteRef: 'REFIDX_AUTO' });
  assert.deepEqual(ch.calls[0].messageReference, { message_id: 'REFIDX_7' });
});

test('自动引用为空串时和以前完全一样（null）', async () => {
  const ch = fakeChannel();
  const run = createActionRunner({ channel: () => ch });
  await run({ text: '普通回复', target: 'c1', quoteRef: '' });
  assert.equal(ch.calls[0].messageReference, null);
});

test('135 字符的 REFIDX 原样进 messageReference，自动和显式两条路都不许截断', async () => {
  /**
   * 真机 `msg_idx` 是 135 字符。出站层以前也 `.slice(0, 128)`，和
   * `quote-auto.js` 犯的是同一个错——两处都修了，这里把两条路一起钉住。
   */
  const real = 'REFIDX_86oJDKVht5SLXUzGblNw4MCtHZUdvB90T97HRccvq2g9OK8tEVTk5s3R+L0vnHaF3dvEja3HLV5Kw2IJTgE3zODnij5vA1LMd0kadewsdY/uqu98iBBiEdnGC8JkBQQN';
  assert.equal(real.length, 135);

  const ch = fakeChannel();
  const run = createActionRunner({ channel: () => ch });
  await run({ text: '自动', target: 'c1', quoteRef: real });
  assert.deepEqual(ch.calls[0].messageReference, { message_id: real });

  ch.calls.length = 0;
  await run({ text: `显式 <<quote: ${real}>>`, target: 'c1' });
  assert.deepEqual(ch.calls[0].messageReference, { message_id: real });
});

test('自动引用**不改** markdown：真机验证过两者可以共存', async () => {
  /**
   * 2026-11-26 真机对照（`plugins/quotetest` 四条）：`msg_type=2` 与
   * `message_reference` 能同时出现，引用块正常、markdown 照常渲染。
   * 所以这里锁住「挂引用不降级」——将来谁想加「引用就转纯文本」，
   * 得先推翻这条测试并说明为什么。
   */
  const ch = fakeChannel();
  const run = createActionRunner({ channel: () => ch });
  await run({ text: '**粗体** 回复', target: 'c1', quoteRef: 'REFIDX_AUTO' });
  assert.equal(ch.calls[0].markdown, true);
  assert.equal(ch.calls[0].text, '**粗体** 回复', '正文不该被改成纯文本');
  assert.deepEqual(ch.calls[0].messageReference, { message_id: 'REFIDX_AUTO' });
});

/* ---------------- 3c. 撤回用的「最近发过的消息」环形 ---------------- */

/** 每次返回不同 id 的通道：`recentSentOf` 要按顺序分辨是哪条 */
function seqChannel() {
  const calls = [];
  let n = 0;
  return {
    calls,
    async send(p) {
      calls.push(p);
      n += 1;
      return { ok: true, id: `m${n}` };
    },
  };
}

test('recentSentOf：最新在前，各条 id 不串', async () => {
  const ch = seqChannel();
  const run = createActionRunner({ channel: () => ch });
  await run({ text: '第一句', target: 'c1' });
  await run({ text: '第二句', target: 'c1' });
  const list = run.recentSentOf('c1');
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 'm2', '最新的排最前');
  assert.equal(list[1].id, 'm1');
  assert.equal(list[0].kind, 'c2c', 'kind 要记下来，撤回频道消息靠它选端点');
  assert.ok(list[0].at > 0, 'at 要记下来，2 分钟预检靠它');
});

test('recentSentOf：按会话分开记，互不串味', async () => {
  const ch = seqChannel();
  const run = createActionRunner({ channel: () => ch });
  await run({ text: 'a', target: 'c1' });
  await run({ text: 'b', target: 'c2' });
  assert.equal(run.recentSentOf('c1').length, 1);
  assert.equal(run.recentSentOf('c2').length, 1);
  assert.equal(run.recentSentOf('c2')[0].id, 'm2');
  assert.deepEqual(run.recentSentOf('nobody'), []);
});

test('recentSentOf：最多留 8 条，老的自然挤掉', async () => {
  const ch = seqChannel();
  const run = createActionRunner({ channel: () => ch });
  for (let i = 0; i < 12; i += 1) await run({ text: `第${i}句`, target: 'c1' });
  const list = run.recentSentOf('c1');
  assert.equal(list.length, 8);
  assert.equal(list[0].id, 'm12');
  assert.equal(list[7].id, 'm5', '最老的应该是第 5 条（m5）');
});

test('recentSentOf：返回的是副本，调用方 reverse 不会把内部顺序搞反', async () => {
  const ch = seqChannel();
  const run = createActionRunner({ channel: () => ch });
  await run({ text: 'a', target: 'c1' });
  await run({ text: 'b', target: 'c1' });
  const first = run.recentSentOf('c1');
  first.reverse();
  first.push({ id: 'fake' });
  const again = run.recentSentOf('c1');
  assert.equal(again[0].id, 'm2', '内部顺序不能被外部改动影响');
  assert.equal(again.length, 2, '外部 push 不能污染内部');
});

test('recentSentOf：没拿到消息号的发送不记（主动消息 / 试运行）', async () => {
  const run = createActionRunner({ channel: () => ({ async send() { return { ok: true, id: '' }; } }) });
  await run({ text: 'x', target: 'c1' });
  assert.deepEqual(run.recentSentOf('c1'), [], '没有 id 就撤不了，不该记进去');
});
