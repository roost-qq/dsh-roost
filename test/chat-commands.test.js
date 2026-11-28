/**
 * 聊天内宿主命令（2026-11-28）
 * ======================
 *
 * 框架 1.2.0 起，外接客户端能在 roost 侧注册聊天命令。这一层钉三件事：
 *
 *   · **清单形状**：下发的 `host.commands` 前缀、权限、单条开关；
 *   · **解析**：别名能命中、`args` 不重新切正文；
 *   · **改到哪儿**：`/model` 写 `model.byChat`、`/silent` 写 `group.responseModes`，
 *     不是「回一句好听的但什么都没改」。
 *
 * 另外钉住扩展声明 `ui.commands` 的校验：只能转调已声明的动作，
 * 免得「扩展可以随便在宿主里挂入口」。
 *
 * 跑法：node --test test/chat-commands.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { HOST_COMMANDS, canonicalCommand, hostCommandSpecs, createChatCommands } from '../src/chat-commands.js';
import { normalizeUiSpec } from '../src/ext-ui.js';

function fakeApi(over = {}) {
  const calls = [];
  const api = {
    modelState: (chatId, kind) => {
      calls.push(['modelState', chatId, kind]);
      return {
        effective: { provider: 'prov', model: 'big' },
        override: null,
        effort: '',
        defaultSel: null,
        global: null,
      };
    },
    modelList: async () => [
      { provider: 'prov', model: 'm1' },
      { provider: 'prov', model: 'm2' },
    ],
    pickModel: async (n) => (Number(n) === 2 ? { provider: 'prov', model: 'm2' } : null),
    setModel: (o) => {
      calls.push(['setModel', o]);
      return { ok: true };
    },
    setEffort: (chatId, effort) => {
      calls.push(['setEffort', chatId, effort]);
      return { ok: true };
    },
    setResponseMode: (chatId, mode) => {
      calls.push(['setResponseMode', chatId, mode]);
      return mode;
    },
    remember: (chatId, text) => {
      calls.push(['remember', chatId, text]);
      return true;
    },
    diary: (chatId, text) => {
      calls.push(['diary', chatId, text]);
      return true;
    },
    resetSession: (chatId) => {
      calls.push(['resetSession', chatId]);
      return { had: true };
    },
    setEnabled: (on) => {
      calls.push(['setEnabled', on]);
      return on;
    },
    status: () => ({
      model: { effective: { provider: 'prov', model: 'big' }, effort: 'high', override: null },
      responseMode: 'chat',
      sessionId: 'sess-1',
      rounds: 3,
      facts: 7,
      journal: 2,
      enabled: true,
    }),
    mood: () => ({ valence: 0.4, energy: 0.6, sociability: 0.5, reason: '被夸了' }),
    speakList: () => ['openid-a'],
    speakAdd: (x) => {
      calls.push(['speakAdd', x]);
      return { ok: true, count: 2 };
    },
    speakDel: (x) => {
      calls.push(['speakDel', x]);
      return { ok: true, count: 0 };
    },
    ...over,
  };
  return { api, calls };
}

const msgOf = (args = [], content = '', extra = {}) => ({
  chat: { chatId: 'group-1', kind: 'group', ...(extra.chat ?? {}) },
  sender: { openid: 'openid-a', name: '张三' },
  args,
  content: content || `/x ${args.join(' ')}`,
  ...extra,
});

function mk(over = {}) {
  const { api, calls } = fakeApi(over.api ?? {});
  const cmds = createChatCommands({ prefix: () => '!', api, log: () => {} });
  return { cmds, calls, api };
}

/* ------------------------------------------------------------------ */
/* 清单                                                                */
/* ------------------------------------------------------------------ */

test('清单：默认 14 条、usage 跟着前缀走、不注册 /help', () => {
  const specs = hostCommandSpecs({ prefix: '!' });
  assert.equal(specs.length, HOST_COMMANDS.length);
  const names = specs.map((s) => s.name);
  assert.ok(!names.includes('help'), '/help 要留给框架内核');
  assert.ok(!names.includes('persona'), '/persona 走软切换，注册成真命令会把那条路拦死');
  for (const s of specs) {
    assert.ok(s.desc && s.desc.length <= 60, `${s.name} 缺 desc`);
    assert.ok(s.usage.startsWith('!'), `${s.name} 的 usage 没用当前前缀：${s.usage}`);
  }
  assert.equal(specs.find((s) => s.name === 'model').admin, true);
  assert.equal(specs.find((s) => s.name === 'reset').ownerOnly, true);
  assert.equal(specs.find((s) => s.name === 'dstatus').admin, false);
});

test('清单：单条开关能过滤（commands.disabled）', () => {
  const specs = hostCommandSpecs({ prefix: '/', allow: (n) => n !== 'model' });
  assert.ok(!specs.some((s) => s.name === 'model'));
  assert.ok(specs.some((s) => s.name === 'dstatus'));
});

test('别名能命中规范名，未知名字回 null', () => {
  assert.equal(canonicalCommand('模型'), 'model');
  assert.equal(canonicalCommand('换模型'), 'model');
  assert.equal(canonicalCommand('状态'), 'dstatus');
  assert.equal(canonicalCommand('MODEL'), 'model');
  assert.equal(canonicalCommand('不存在的'), null);
});

/* ------------------------------------------------------------------ */
/* /model                                                              */
/* ------------------------------------------------------------------ */

test('/model 无参：报当前模型与「没单独设过」', async () => {
  const { cmds } = mk();
  const out = await cmds.run({ name: 'model', msg: msgOf([], '!model') });
  assert.match(out, /本会话模型：prov\/big/);
  assert.match(out, /没单独设过/);
  assert.match(out, /!model list/);
});

test('/model 带覆盖时能看出单独设过', async () => {
  const { cmds } = mk({
    api: { modelState: () => ({ effective: { provider: 'p', model: 'm' }, override: { provider: 'p', model: 'o' } }) },
  });
  const out = await cmds.run({ name: 'model', msg: msgOf([], '!model') });
  assert.match(out, /单独设过：p\/o/);
});

test('/model list：编号列出，且提示怎么切', async () => {
  const { cmds } = mk();
  const out = await cmds.run({ name: 'model', msg: msgOf(['list'], '!model list') });
  assert.match(out, /1\. prov\/m1/);
  assert.match(out, /2\. prov\/m2/);
  assert.match(out, /!model <序号>/);
});

test('/model 序号：按缓存清单取第二条并写 byChat（带 kind）', async () => {
  const { cmds, calls } = mk();
  const out = await cmds.run({ name: 'model', msg: msgOf(['2'], '!model 2') });
  const set = calls.find((c) => c[0] === 'setModel');
  assert.deepEqual(set[1], { chatId: 'group-1', kind: 'group', provider: 'prov', model: 'm2' });
  assert.match(out, /prov\/m2/);
});

test('/model 序号越界：提示先看清单，不乱改', async () => {
  const { cmds, calls } = mk();
  const out = await cmds.run({ name: 'model', msg: msgOf(['9'], '!model 9') });
  assert.match(out, /没有第 9 个/);
  assert.equal(calls.filter((c) => c[0] === 'setModel').length, 0);
});

test('/model off：没设过就直说，设过才清', async () => {
  const a = mk();
  const out1 = await a.cmds.run({ name: 'model', msg: msgOf(['off'], '!model off') });
  assert.match(out1, /本来就没/);
  assert.equal(a.calls.filter((c) => c[0] === 'setModel').length, 0);

  const b = mk({
    api: { modelState: () => ({ effective: { provider: 'p', model: 'm' }, override: { provider: 'p', model: 'o' } }) },
  });
  await b.cmds.run({ name: 'model', msg: msgOf(['off'], '!model off') });
  const set = b.calls.find((c) => c[0] === 'setModel');
  assert.deepEqual(set[1], { chatId: 'group-1', off: true });
});

test('/model provider/model 直填；格式不对给例子', async () => {
  const a = mk();
  await a.cmds.run({ name: 'model', msg: msgOf(['anthropic/claude'], '!model anthropic/claude') });
  assert.deepEqual(a.calls.find((c) => c[0] === 'setModel')[1], {
    chatId: 'group-1',
    kind: 'group',
    provider: 'anthropic',
    model: 'claude',
  });

  const b = mk();
  const out = await b.cmds.run({ name: 'model', msg: msgOf(['没有斜杠'], '!model 没有斜杠') });
  assert.match(out, /要写成 provider\/model/);
  assert.equal(b.calls.filter((c) => c[0] === 'setModel').length, 0);
});

test('/model 中文别名等价于 /model', async () => {
  const { cmds } = mk();
  const out = await cmds.run({ name: '模型', msg: msgOf(['list'], '!模型 list') });
  assert.match(out, /可用模型/);
});

/* ------------------------------------------------------------------ */
/* /effort /silent /quiet /normal /active                              */
/* ------------------------------------------------------------------ */

test('/effort 无参报当前；带档位写全局；「默认」清空', async () => {
  const { cmds, calls } = mk();
  const a = await cmds.run({ name: 'effort', msg: msgOf([], '!effort') });
  assert.match(a, /跟随模型默认/);

  await cmds.run({ name: 'effort', msg: msgOf(['高'], '!effort 高') });
  assert.deepEqual(calls.find((c) => c[0] === 'setEffort'), ['setEffort', 'group-1', '高']);

  await cmds.run({ name: 'effort', msg: msgOf(['默认'], '!effort 默认') });
  assert.equal(calls.filter((c) => c[0] === 'setEffort')[1][2], '');
});

test('/silent 在私聊里不假装成功（那张表只有群在用）', async () => {
  const { cmds, calls } = mk();
  const out = await cmds.run({ name: 'silent', msg: msgOf([], '!silent', { chat: { chatId: 'user-1', kind: 'c2c' } }) });
  assert.match(out, /只在群里有用/);
  assert.equal(calls.filter((c) => c[0] === 'setResponseMode').length, 0);
});

test('/silent /quiet /normal /active 落到 responseModes', async () => {
  const { cmds, calls } = mk();
  await cmds.run({ name: 'silent', msg: msgOf([], '!silent') });
  await cmds.run({ name: 'quiet', msg: msgOf([], '!quiet') });
  await cmds.run({ name: 'normal', msg: msgOf([], '!normal') });
  await cmds.run({ name: 'active', msg: msgOf([], '!active') });
  const modes = calls.filter((c) => c[0] === 'setResponseMode').map((c) => c[2]);
  assert.deepEqual(modes, ['off', 'observe', null, null]);
});

/* ------------------------------------------------------------------ */
/* 记忆 / 会话 / 开关 / 状态 / 心情 / 日记 / 搭话                       */
/* ------------------------------------------------------------------ */

test('/remember：空内容提示，有内容写进本会话', async () => {
  const { cmds, calls } = mk();
  const empty = await cmds.run({ name: 'remember', msg: msgOf([], '!remember') });
  assert.match(empty, /要记什么/);
  assert.equal(calls.filter((c) => c[0] === 'remember').length, 0);

  const ok = await cmds.run({ name: 'remember', msg: msgOf(['我', '喜欢', '猫'], '!remember 我 喜欢 猫') });
  assert.equal(ok, '记下了。');
  assert.deepEqual(calls.find((c) => c[0] === 'remember'), ['remember', 'group-1', '我 喜欢 猫']);
});

test('/remember 带空格的内容不丢字（按 content 回切）', async () => {
  const { cmds, calls } = mk();
  await cmds.run({ name: 'remember', msg: msgOf(['今天', '买了', '车'], '!remember 今天 买了 车') });
  assert.equal(calls.find((c) => c[0] === 'remember')[2], '今天 买了 车');
});

test('/remember 英文内容不被首字母误切（a banana 不能变成 ana）', async () => {
  const { cmds, calls } = mk();
  await cmds.run({ name: 'remember', msg: msgOf(['a', 'banana'], '!remember a banana') });
  assert.equal(calls.find((c) => c[0] === 'remember')[2], 'a banana');
});

test('前缀不是 / 时，提示文案跟着换（不写死）', async () => {
  const { cmds } = mk();
  const off = await cmds.run({ name: 'off', msg: msgOf([]) });
  assert.match(off, /!on/);
  assert.doesNotMatch(off, /\/on/);
});

test('/diary 写入，失败时如实说', async () => {
  const ok = mk();
  assert.equal(await ok.cmds.run({ name: 'diary', msg: msgOf(['今天很好'], '!diary 今天很好') }), '记到日记里了。');

  const bad = mk({ api: { diary: () => false } });
  const out = await bad.cmds.run({ name: 'diary', msg: msgOf(['x'], '!diary x') });
  assert.match(out, /没写进去/);
});

test('/reset 有上下文与没上下文两种回执', async () => {
  const a = mk();
  assert.match(await a.cmds.run({ name: 'reset', msg: msgOf([], '!reset') }), /清空/);

  const b = mk({ api: { resetSession: () => ({ had: false }) } });
  assert.match(await b.cmds.run({ name: 'reset', msg: msgOf([], '!reset') }), /本来就没有上下文/);
});

test('/on 与 /off 写总开关并回显', async () => {
  const { cmds, calls } = mk();
  assert.equal(await cmds.run({ name: 'on', msg: msgOf([], '!on') }), '开机了。');
  assert.equal(await cmds.run({ name: 'off', msg: msgOf([], '!off') }), '关机了，之后的消息都不回。发 !on 才能再开。');
  assert.deepEqual(calls.filter((c) => c[0] === 'setEnabled').map((c) => c[1]), [true, false]);
});

test('/dstatus 一屏内给出模型 / 上下文 / 记忆 / 开关', async () => {
  const { cmds } = mk();
  const out = await cmds.run({ name: 'dstatus', msg: msgOf([], '!dstatus') });
  assert.match(out, /模型：prov\/big/);
  assert.match(out, /思考强度：high/);
  assert.match(out, /已聊 3 轮/);
  assert.match(out, /7 条事实 \/ 2 条日记/);
  assert.match(out, /总开关：开/);
});

test('/mood 读心情，带原因', async () => {
  const { cmds } = mk();
  const out = await cmds.run({ name: 'mood', msg: msgOf([], '!mood') });
  assert.match(out, /偏正面/);
  assert.match(out, /精力 60%/);
  assert.match(out, /被夸了/);

  const none = mk({ api: { mood: () => null } });
  assert.match(await none.cmds.run({ name: 'mood', msg: msgOf([], '!mood') }), /读不到心情/);
});

test('/speak 列表 / 加 / 删 / 参数不全', async () => {
  const { cmds, calls } = mk();
  const list = await cmds.run({ name: 'speak', msg: msgOf([], '!speak') });
  assert.match(list, /openid-a/);

  await cmds.run({ name: 'speak', msg: msgOf(['add', 'openid-b'], '!speak add openid-b') });
  assert.ok(calls.some((c) => c[0] === 'speakAdd' && c[1] === 'openid-b'));

  await cmds.run({ name: 'speak', msg: msgOf(['del', 'openid-a'], '!speak del openid-a') });
  assert.ok(calls.some((c) => c[0] === 'speakDel' && c[1] === 'openid-a'));

  const bad = await cmds.run({ name: 'speak', msg: msgOf(['add'], '!speak add') });
  assert.match(bad, /给一个 openid/);
});

/* ------------------------------------------------------------------ */
/* 兜底                                                                */
/* ------------------------------------------------------------------ */

test('未知命令回一句人话，不抛', async () => {
  const { cmds } = mk();
  assert.match(await cmds.run({ name: 'nope', msg: msgOf([], '!nope') }), /没有这个命令/);
});

test('api 抛错被兜成回执，不让框架挂到超时', async () => {
  const { cmds } = mk({
    api: {
      setModel: () => {
        throw new Error('配置写不进去');
      },
    },
  });
  const out = await cmds.run({ name: 'model', msg: msgOf(['p/m'], '!model p/m') });
  assert.match(out, /\/model 没跑成：配置写不进去/);
});

/* ------------------------------------------------------------------ */
/* 扩展声明 ui.commands                                                */
/* ------------------------------------------------------------------ */

const uiBase = (extra = {}) => ({
  nav: { label: '测试页' },
  view: { kind: 'log', source: { file: 'data.json' } },
  actions: [{ id: 'do', label: '执行' }],
  ...extra,
});

test('ui.commands：合法声明进 spec', () => {
  const r = normalizeUiSpec(uiBase({ commands: [{ name: 'bili', aliases: ['哔哩'], desc: 'B 站', action: 'do', admin: true }] }));
  assert.equal(r.ok, true, r.errors.join('；'));
  assert.deepEqual(r.spec.commands, [
    { name: 'bili', aliases: ['哔哩'], desc: 'B 站', action: 'do', admin: true, ownerOnly: false },
  ]);
});

test('ui.commands：不写就是空数组', () => {
  const r = normalizeUiSpec(uiBase());
  assert.equal(r.ok, true);
  assert.deepEqual(r.spec.commands, []);
});

test('ui.commands：转调未声明的动作要报错', () => {
  const r = normalizeUiSpec(uiBase({ commands: [{ name: 'bili', desc: 'B 站', action: 'ghost' }] }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /没在 ui\.actions 里声明过/);
});

test('ui.commands：名字大写 / 缺 action / desc 太长都拦下', () => {
  const bad1 = normalizeUiSpec(uiBase({ commands: [{ name: 'Bili', desc: 'x', action: 'do' }] }));
  assert.equal(bad1.ok, false);
  const bad2 = normalizeUiSpec(uiBase({ commands: [{ name: 'bili', desc: 'x' }] }));
  assert.equal(bad2.ok, false);
  const bad3 = normalizeUiSpec(uiBase({ commands: [{ name: 'bili', desc: 'x'.repeat(31), action: 'do' }] }));
  assert.equal(bad3.ok, false);
});

test('ui.commands：超过 6 条拦下', () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ name: `c${i}`, desc: 'x', action: 'do' }));
  const r = normalizeUiSpec(uiBase({ commands: many }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /最多 6 条/);
});
