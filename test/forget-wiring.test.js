/**
 * 按人遗忘的真 host 接线：走真实 `apply(ctx)` + 真路由，
 * 不手工塞数据、不 mock 记忆层。
 *
 * 钉住四件事（都是「看起来做了其实没生效」的高发点）：
 *   1. `persona.noMemory` 走新语义：只断链、档案正文不删、可恢复；
 *   2. `/person/forget/plan` 只数不改；
 *   3. `/person/forgotten` 与 `/person/forget/restore` 闭环；
 *   4. 断链之后 `/memory` 里读不到关于他的话，撤回后又能读到。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const noop = () => () => {};

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-forget-wire-'));
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  const oldEnv = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = data;
  const cleanups = [];
  writeFileSync(join(data, 'config.json'), JSON.stringify({
    server: { port: 17332 },
    ownerAliases: ['owner1'],
    memory: { enabled: true },
    profiles: { enabled: true },
  }), 'utf8');
  writeFileSync(join(data, 'profiles.json'), JSON.stringify([
    { key: '10001', name: '小明', impression: '爱打球', tips: '聊球话多', at: 1, hits: 2 },
  ]), 'utf8');
  writeFileSync(join(data, 'memory.json'), JSON.stringify({
    schemaVersion: 3,
    global: ['小明在准备考试', '主人喜欢喝咖啡'],
    chats: {},
    meta: {
      global: {
        小明在准备考试: { w: 1, at: 1700000000000, src: { speaker: '小明' } },
        主人喜欢喝咖啡: { w: 1, at: 1700000000000 },
      },
      chats: {},
    },
  }), 'utf8');
  /** 一条待确认别名（模型提议的真实入口在巩固链路里，这里直接落文件） */
  writeFileSync(join(data, 'pending-aliases.json'), JSON.stringify({
    items: [{ alias: '小明', person: '10001', hits: 2, src: 'auto', firstAt: 1, lastAt: 2 }],
  }), 'utf8');

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
  const host = await import(`../src/host.js?fw=${Date.now()}-${Math.random()}`);
  host.apply(ctx);

  const call = async (path, body, method = 'POST') => {
    const res = {
      statusCode: 0, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(s) { try { this.body = JSON.parse(s); } catch { this.body = s; } },
    };
    const req = {
      method, url: path, headers: { host: '127.0.0.1:8932' },
      async *[Symbol.asyncIterator]() { if (body) yield JSON.stringify(body); },
    };
    const key = path.split('?')[0];
    const h = routes.get(path) || routes.get(key);
    assert.ok(h, `路由没注册：${path}`);
    await h(req, res);
    return { ...res.body, status: res.statusCode };
  };
  return {
    /** 面板实际打的入口：`/quick`（`viaExt: '@panel'`） */
    quick: (op, arg) => call('/roost/api/quick', { viaExt: '@panel', op, arg }),
    call,
    facts: async () => (await call('/roost/api/memory?chatId=', null, 'GET')).facts || { global: [] },
    read: (f) => { try { return JSON.parse(readFileSync(join(data, f), 'utf8')); } catch { return null; } },
    done: () => {
      for (const c of cleanups) { try { c(); } catch {} }
      if (oldEnv === undefined) delete process.env.DSH_ROOST_DATA;
      else process.env.DSH_ROOST_DATA = oldEnv;
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

test('断链：/memory 读不到关于他的话，档案正文不删、可恢复', async () => {
  const b = await boot();
  try {
    const before = await b.facts();
    assert.equal(before.global.includes('小明在准备考试'), true, '断链前事实在');

    const r = await b.quick('persona.noMemory', { key: '10001', enabled: true });
    assert.equal(r.ok, true, r.message);

    const mid = await b.facts();
    assert.equal(mid.global.includes('小明在准备考试'), false, '断链后注入列表里没有他');
    assert.equal(mid.global.includes('主人喜欢喝咖啡'), true, '无关事实不受影响');

    /** 盘上正文还在（unlink 不擦除） */
    const disk = b.read('memory.json');
    assert.equal(disk.global.includes('小明在准备考试'), true);
    assert.equal(b.read('persons.json').persons['10001'].noMemory, true);
    assert.equal(b.read('profiles.json')[0].impression, '爱打球', '档案正文不删');

    const back = await b.quick('persona.noMemory', { key: '10001', enabled: false });
    assert.equal(back.ok, true, back.message);
    const after = await b.facts();
    assert.equal(after.global.includes('小明在准备考试'), true, '撤回后又能读到');
  } finally { b.done(); }
});

test('/person/forget/plan 只数不改；/person/forgotten 与 restore 闭环', async () => {
  const b = await boot();
  try {
    const plan = await b.call('/roost/api/person/forget/plan?id=10001');
    assert.equal(plan.ok, true, plan.message);
    assert.equal(plan.affects.facts >= 1, true, `影响面应≥1，实际 ${plan.affects.facts}`);
    assert.equal(b.read('persons.json'), null, '预览不许落盘');

    await b.call('/roost/api/person/forget', { id: '10001', mode: 'unlink' });
    const list = await b.call('/roost/api/person/forgotten', null, 'GET');
    assert.equal(list.ok, true);
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].id, '10001');
    assert.deepEqual(list.items[0].names, ['小明']);

    const r = await b.call('/roost/api/person/forget/restore', { id: '10001' });
    assert.equal(r.ok, true);
    const list2 = await b.call('/roost/api/person/forgotten', null, 'GET');
    assert.equal(list2.items.length, 0);
  } finally { b.done(); }
});

test('hard 必须二次确认，不带 confirm 直接 400 且数据不动', async () => {
  const b = await boot();
  try {
    const r = await b.call('/roost/api/person/forget', { id: '10001', mode: 'hard' });
    assert.equal(r.ok, false);
    assert.match(r.message, /不可恢复/);
    assert.equal(b.read('memory.json').global.includes('小明在准备考试'), true, '没确认就不许删');

    const r2 = await b.call('/roost/api/person/forget', { id: '10001', mode: 'hard', confirm: true });
    assert.equal(r2.ok, true, r2.message);
    assert.equal(b.read('memory.json').global.includes('小明在准备考试'), false, '确认后真删');
  } finally { b.done(); }
});

test('待确认别名：确认后写进 persons.aliases，队列出队', async () => {
  const b = await boot();
  try {
    const q = await b.call('/roost/api/person/alias/pending', null, 'GET');
    assert.equal(q.items.length, 1);
    assert.equal(q.items[0].alias, '小明');

    const c = await b.call('/roost/api/person/alias/confirm', { alias: '小明', person: '10001' });
    assert.equal(c.ok, true, c.message);
    assert.deepEqual(b.read('persons.json').persons['10001'].aliases, ['小明']);

    const q2 = await b.call('/roost/api/person/alias/pending', null, 'GET');
    assert.equal(q2.items.length, 0, '确认后出队');

    /** 不存在的条目要如实报错，不能静默 ok */
    const miss = await b.call('/roost/api/person/alias/confirm', { alias: '不存在', person: '1' });
    assert.equal(miss.ok, false);
  } finally { b.done(); }
});

test('/memory/node 删「这个人」= 断链，不是只删一行档案（否则当晚又长回来）', async () => {
  const b = await boot();
  try {
    const r = await b.call('/roost/api/memory/node', { kind: 'profile', id: '10001' });
    assert.equal(r.ok, true, r.message);
    assert.equal(b.read('persons.json').persons['10001'].noMemory, true, '要走完整遗忘，立身份标记');
    assert.equal(b.read('profiles.json').length, 1, '档案行还在（可恢复），不是物理删');
    const back = await b.facts();
    assert.equal(back.global.includes('小明在准备考试'), false, '断链后事实也不再注入');
  } finally { b.done(); }
});

test('回填：确认别名之后，老事实补上归属（只补确认过的）', async () => {
  const b = await boot();
  try {
    await b.call('/roost/api/person/alias/confirm', { alias: '小明', person: '10001' });
    const r = await b.call('/roost/api/person/alias/backfill', {});
    assert.equal(r.ok, true, r.message);
    assert.equal(r.changed, 1, '只有「小明说的那条」能精确归属');
    const disk = b.read('memory.json');
    assert.equal(disk.meta.global['小明在准备考试'].about, '10001');
    assert.equal(disk.meta.global['主人喜欢喝咖啡'].about, undefined);
  } finally { b.done(); }
});
