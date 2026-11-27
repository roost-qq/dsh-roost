/**
 * 阶段6 接线测试：persona.edit / persona.noMemory 在真 host 里跑通。
 * 钉住阶段1 的 config 作用域错同类问题 + scope fail-closed + 标签护栏端到端生效。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const noop = () => () => {};

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-pw-wire-'));
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  const oldEnv = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = data;
  const cleanups = [];
  writeFileSync(join(data, 'config.json'), JSON.stringify({
    server: { port: 17331 },
    ownerAliases: ['owner1'],
  }), 'utf8');
  writeFileSync(join(data, 'profiles.json'), JSON.stringify([
    { key: 'u123', name: '小明', impression: '爱打球', tips: '聊球话多', dislikes: '', at: 1, hits: 2 },
  ]), 'utf8');
  const routes = new Map();
  const ctx = {
    agents: { get: () => null, list: () => [], create: async () => ({ id: 'a', ctx: {} }) },
    sessions: { get: () => null, list: () => [], create: () => ({ id: 's' }) },
    systemPrompt: { context: () => noop },
    webServer: { register: (r) => { routes.set(r.path, r.handler); return noop; } },
    config: {},
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    effect: (cb) => { const off = typeof cb === 'function' ? cb() : null; if (typeof off === 'function') cleanups.push(off); return noop; },
    on: () => noop,
    dataDir: data,
    dir,
  };
  const host = await import(`../src/host.js?pw=${Date.now()}-${Math.random()}`);
  host.apply(ctx);
  const call = async (path, body, method = 'POST') => {
    const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(s) { this.body = JSON.parse(s); } };
    const req = { method, url: path, headers: { host: '127.0.0.1:8931' }, async *[Symbol.asyncIterator]() { if (body) yield JSON.stringify(body); } };
    const h = routes.get(path) || routes.get(path.split('?')[0]);
    assert.ok(h, `路由没注册：${path}`);
    await h(req, res);
    return res.body;
  };
  return {
    quick: (op, arg) => call('/roost/api/quick', { viaExt: '@panel', op, arg }),
    call,
    profiles: () => JSON.parse(readFileSync(join(data, 'profiles.json'), 'utf8')),
    persons: () => { try { return JSON.parse(readFileSync(join(data, 'persons.json'), 'utf8')); } catch { return { persons: {} }; } },
    done: () => {
      for (const c of cleanups) { try { c(); } catch {} }
      if (oldEnv === undefined) delete process.env.DSH_ROOST_DATA;
      else process.env.DSH_ROOST_DATA = oldEnv;
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

test('quick(persona.edit) 真 host 跑通：写印象+标签', async () => {
  const b = await boot();
  try {
    const r = await b.quick('persona.edit', { key: 'u123', patch: { impression: '爱打篮球', tags: ['喜欢', '球友'] } });
    assert.equal(r.ok, true, `编辑失败：${r.message}`);
    const row = b.profiles()[0];
    assert.equal(row.impression, '爱打篮球');
    assert.deepEqual(row.tags, ['喜欢', '球友']);
    assert.equal(row.tagsBy, 'owner');
    assert.equal(row.tips, '聊球话多'); // 没给的字段保留
  } finally { b.done(); }
});

test('quick(persona.edit) 标签护栏端到端生效', async () => {
  const b = await boot();
  try {
    const r = await b.quick('persona.edit', { key: 'u123', patch: { tags: ['喜欢', '讨厌'] } });
    assert.equal(r.ok, false);
    assert.match(r.message, /不能同时/);
  } finally { b.done(); }
});

test('quick(persona.noMemory) 真 host 跑通：标记与撤销（权威在 persons，档案正文不动）', async () => {
  const b = await boot();
  try {
    let r = await b.quick('persona.noMemory', { key: 'u123', enabled: true });
    assert.equal(r.ok, true);
    /** 新语义：默认 unlink 只断链，档案正文一个字都不删（可恢复） */
    assert.equal(b.persons().persons['u123']?.noMemory, true, 'persons 里立了标记');
    assert.equal(b.profiles()[0].impression, '爱打球', '断链不擦除：正文还在');

    r = await b.quick('persona.noMemory', { key: 'u123', enabled: false });
    assert.equal(r.ok, true);
    /** 撤回后标记不再为 true（空壳记录会被清掉，所以不能断言 === false） */
    assert.notEqual(b.persons().persons['u123']?.noMemory, true, '撤回后标记清掉');
  } finally { b.done(); }
});

test('/person 详情带出 tags/alias/noMemory/interactions', async () => {
  const b = await boot();
  try {
    await b.quick('persona.edit', { key: 'u123', patch: { alias: '小明明', tags: ['球友'] } });
    const r = await b.call('/roost/api/person?key=u123&chatId=', null, 'GET');
    assert.equal(r.ok, true, `详情失败：${r.message}`);
    assert.equal(r.person.alias, '小明明');
    assert.deepEqual(r.person.tags, ['球友']);
    assert.equal(r.person.noMemory, false);
    assert.equal(typeof r.person.interactions, 'number');
  } finally { b.done(); }
});

test('scopeOfOp 认得两个新 op（fail-closed 不误伤）', async () => {
  const { scopeOfOp } = await import('../src/ext-quick-scopes.js');
  for (const op of ['persona.edit', 'persona.noMemory']) {
    const s = scopeOfOp(op);
    assert.equal(s.ok, true, `${op} 没登记 scope`);
    assert.equal(s.scope, 'prompt:write');
  }
});

test('G7：quick(persona.edit) 真 host 写 style/persona，40 字上限', async () => {
  const b = await boot();
  try {
    const r = await b.quick('persona.edit', { key: 'u123', patch: { style: '说话直', persona: '急性子' } });
    assert.equal(r.ok, true, `编辑失败：${r.message}`);
    let row = b.profiles()[0];
    assert.equal(row.style, '说话直');
    assert.equal(row.persona, '急性子');
    assert.equal(row.impression, '爱打球', '没给的字段保留');
    // 超长截断
    await b.quick('persona.edit', { key: 'u123', patch: { style: '字'.repeat(60) } });
    row = b.profiles()[0];
    assert.equal(Array.from(row.style).length, 40);
    assert.equal(row.persona, '急性子', '改 style 不丢 persona');
  } finally { b.done(); }
});

test('G7：/person 详情带出 style/persona（真 host）', async () => {
  const b = await boot();
  try {
    await b.quick('persona.edit', { key: 'u123', patch: { style: '说话直', persona: '急性子' } });
    const r = await b.call('/roost/api/person?key=u123', null, 'GET');
    assert.equal(r.ok !== false, true, r.message || '详情失败');
    assert.equal(r.person.style, '说话直');
    assert.equal(r.person.persona, '急性子');
  } finally { b.done(); }
});

test('quick(persona.address)：按场景写称呼，清空即删', async () => {
  const b = await boot();
  try {
    /** 全局 */
    let r = await b.quick('persona.address', { key: 'u123', value: '小明' });
    assert.equal(r.ok, true, r.message);
    /** 本群 */
    r = await b.quick('persona.address', { key: 'u123', scope: 'group:G1', value: '老王' });
    assert.equal(r.ok, true, r.message);

    let row = b.profiles()[0];
    assert.deepEqual(row.addresses, { '*': '小明', 'group:G1': '老王' });

    /** 清掉本群那条：不是写空串，是真删键 */
    r = await b.quick('persona.address', { key: 'u123', scope: 'group:G1', value: '' });
    assert.equal(r.ok, true);
    row = b.profiles()[0];
    assert.deepEqual(row.addresses, { '*': '小明' }, '本群那条要真删掉');
  } finally { b.done(); }
});

test('quick(persona.address)：没有档案的人返回 400（不建半条空档案）', async () => {
  const b = await boot();
  try {
    const r = await b.quick('persona.address', { key: 'nobody', value: '老王' });
    assert.equal(r.ok, false);
    assert.equal(b.profiles().length, 1, '不能为一次设称呼建空档案');
  } finally { b.done(); }
});
