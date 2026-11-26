// `qq_retract` 工具定义。
//
// 这个工具的失败方式不是崩溃，是**社交事故**：撤错了别人的消息、或者
// 撤失败却不说清原因让模型原地重试。所以断言盯「注册条件」和「拒绝路径」。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildQqToolDefs } from '../src/qq-tools.js';

function make({ retractOf = null, chatId = 'g1', kind = 'group' } = {}) {
  const box = { calls: [] };
  const defs = buildQqToolDefs({
    callerOf: () => ({ chatId, kind, said: '', hasPayload: true, bucket: 'member' }),
    sendOf: async () => ({ ok: true }),
    closeOf: () => ({ ok: true }),
    ...(retractOf
      ? {
        retractOf: async (a) => {
          box.calls.push(a);
          return retractOf(a);
        },
      }
      : {}),
  });
  const tool = defs.find((d) => d.name === 'qq_retract') ?? null;
  return { defs, tool, box };
}

test('没注入 retractOf 就不注册（注册一个必然失败的壳子等于教模型做不成的事）', () => {
  const { tool, defs } = make();
  assert.equal(tool, null);
  assert.ok(!defs.some((d) => d.name === 'qq_retract'));
});

test('注入后注册，且描述里写明「只能撤自己的」和「2 分钟」', () => {
  const { tool } = make({ retractOf: async () => ({ ok: true }) });
  assert.ok(tool, '应该注册');
  assert.match(tool.description, /你自己/);
  assert.match(tool.description, /2 分钟/);
  assert.doesNotMatch(tool.description, /撤别人的|别人的消息/, '不能教它撤别人的');
});

test('参数里**没有** message_id（模型填不出来，那是必错项）', () => {
  const { tool } = make({ retractOf: async () => ({ ok: true }) });
  const keys = Object.keys(tool.parameters);
  assert.deepEqual(keys.sort(), ['index', 'why']);
  assert.ok(!keys.includes('msgId') && !keys.includes('msg_id') && !keys.includes('message_id'));
});

test('调用透传 chatId / kind / index / why', async () => {
  const { tool, box } = make({ retractOf: async () => ({ ok: true, message: '撤回了' }) });
  const r = await tool.execute({ index: 2, why: '说错了' });
  assert.equal(r.ok, true);
  assert.equal(box.calls.length, 1);
  assert.equal(box.calls[0].chatId, 'g1');
  assert.equal(box.calls[0].kind, 'group');
  assert.equal(box.calls[0].index, 2);
  assert.equal(box.calls[0].why, '说错了');
});

test('宿主返回失败时原样转达，不改写成成功', async () => {
  const { tool } = make({
    retractOf: async () => ({ ok: false, message: '超过 2 分钟了，官方不让撤。别重试。' }),
  });
  const r = await tool.execute({});
  assert.equal(r.ok, false);
  assert.match(r.message, /2 分钟/);
});

test('retractOf 抛异常时包成 ok:false，不把这一轮带崩', async () => {
  const { tool } = make({ retractOf: async () => { throw new Error('通道断了'); } });
  const r = await tool.execute({ index: 1 });
  assert.equal(r.ok, false);
  assert.match(r.message, /通道断了/);
});

test('why 不填时传空串（不要 undefined 混进日志）', async () => {
  const { tool, box } = make({ retractOf: async () => ({ ok: true }) });
  await tool.execute({});
  assert.equal(box.calls[0].why, '');
});
