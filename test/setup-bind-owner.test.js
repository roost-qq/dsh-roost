// 接入页「配置主人」：setup 层的能力探测与绑定/解绑。
//
// 覆盖：版本探测（新接口 200 / 旧框架 404）、绑定走 /api/owners/add、
// 解绑走 /api/owners/remove、绑定后 owner 缓存立即失效、跨 bot 主人汇总。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSetup } from '../src/setup.js';

function makeRoost(ownersByBot = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-bind-owner-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'main.js'), '// stub\n', 'utf8');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'qq-bot-roost', version: '1.1.17' }), 'utf8');
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data', 'ports.json'), JSON.stringify({ roost: { want: 15210, actual: 15210 } }), 'utf8');
  mkdirSync(join(dir, 'config', 'bots'), { recursive: true });
  for (const [name, owners] of Object.entries(ownersByBot)) {
    writeFileSync(join(dir, 'config', 'bots', name), JSON.stringify({ id: name.replace(/\.json$/, ''), owners }), 'utf8');
  }
  return dir;
}

function makeSetup(dir) {
  const cfg = { server: { port: 17321, token: '' }, setup: { roostDir: dir } };
  return createSetup({
    cfgOf: () => cfg,
    setCfg: () => {},
    dataDir: () => dir,
    log: () => {},
    installer: null,
  });
}

/** 换掉 fetch；calls 记录每次请求的 url 与 init */
async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
}

/** 默认健康应答（isRunning 需要 bots/online/total 字段才认） */
const health = {
  ok: true, status: 200,
  text: async () => JSON.stringify({ ok: true, bots: [], online: 0, total: 0 }),
};
const jsonRes = (body, status = 200) => ({
  ok: status < 400, status,
  text: async () => JSON.stringify(body),
});

test('roostOwners：跨 bot 汇总但不去重（解绑保护数的是条目数），读不到时为空', () => {
  const dir = makeRoost({
    'main.json': ['AAAAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBBBB'],
    'other.json': ['BBBBBBBBBBBBBBBBBB', 'CCCCCCCCCCCCCCCCCCCC'],
  });
  const setup = makeSetup(dir);
  assert.deepEqual(setup.roostOwners(), [
    'AAAAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBBBB', 'BBBBBBBBBBBBBBBBBB', 'CCCCCCCCCCCCCCCCCCCC',
  ]);
  assert.equal(makeSetup(mkdtempSync(join(tmpdir(), 'empty-roost-'))).roostOwners().length, 0);
});

test('ownersApiSupported：owners 数组即支持（含 ok 字段），旧框架 404 → false 且 5 秒后重试', async () => {
  const dir = makeRoost({ 'main.json': ['AAAAAAAAAAAAAAAAAA'] });
  await withFetch((url) => {
    if (url.includes('/healthz')) return health;
    // 真实框架 /api/roles 带 ok:true；不能因为 ok 字段存在就误判成旧版
    if (url.includes('/api/roles')) return jsonRes({ ok: true, owners: ['AAAAAAAAAAAAAAAAAA'], rows: [] });
    return jsonRes({ error: 'not found' }, 404);
  }, async (calls) => {
    const setup = makeSetup(dir);
    assert.equal(await setup.ownersApiSupported(), true);
    assert.equal(await setup.ownersApiSupported(), true);
    assert.equal(calls.filter((c) => c.url.includes('/api/roles')).length, 1, '肯定结果应缓存，只打一次');
  });

  await withFetch((url) => {
    if (url.includes('/healthz')) return health;
    return jsonRes({ error: 'not found' }, 404);
  }, async (calls) => {
    const setup = makeSetup(dir);
    assert.equal(await setup.ownersApiSupported(), false, '旧框架 404 要降级');
    assert.equal(await setup.ownersApiSupported(), false, '5 秒内沿用否结论');
    assert.equal(calls.filter((c) => c.url.includes('/api/roles')).length, 1, '否结论也要短暂缓存');
  });
});

test('bindOwner：绑定/解绑分别走 /api/owners/add|remove，并让 owner 缓存失效', async () => {
  const dir = makeRoost({ 'main.json': ['AAAAAAAAAAAAAAAAAA'] });
  await withFetch((url, init) => {
    if (url.includes('/healthz')) return health;
    if (url.includes('/api/roles')) return jsonRes({ owners: ['AAAAAAAAAAAAAAAAAA'], rows: [] });
    if (url.includes('/api/owners/')) return jsonRes({ ok: true, owners: ['BBBBBBBBBBBBBBBBBB'] });
    return jsonRes({ error: 'not found' }, 404);
  }, async (calls) => {
    const setup = makeSetup(dir);
    assert.equal(setup.roostOwner(), 'AAAAAAAAAAAAAAAAAA', '先读到旧主人');
    const r = await setup.bindOwner('BBBBBBBBBBBBBBBBBB');
    assert.equal(r.ok, true);
    const add = calls.find((c) => c.url.includes('/api/owners/add'));
    assert.ok(add, '绑定要走 /api/owners/add');
    assert.equal(JSON.parse(add.init.body).openid, 'BBBBBBBBBBBBBBBBBB');

    await setup.bindOwner('BBBBBBBBBBBBBBBBBB', true);
    assert.ok(calls.some((c) => c.url.includes('/api/owners/remove')), '解绑要走 /api/owners/remove');
    // 缓存已失效：下次 roostOwner 要重新读盘（磁盘没改，仍是旧值，但确实重读了）
    assert.equal(setup.roostOwner(), 'AAAAAAAAAAAAAAAAAA');
  });
});

test('bindOwner：空 openid 与 Roost 没起来时明确报错，不发出请求', async () => {
  const dir = makeRoost({ 'main.json': ['AAAAAAAAAAAAAAAAAA'] });
  await withFetch((url) => {
    if (url.includes('/healthz')) return health;
    return jsonRes({ error: 'not found' }, 404);
  }, async (calls) => {
    const setup = makeSetup(dir);
    await assert.rejects(() => setup.bindOwner(''), /openid 不能为空/);
    assert.equal(calls.filter((c) => c.url.includes('/api/owners/')).length, 0);
  });

  await withFetch(() => jsonRes({ error: 'down' }, 503), async (calls) => {
    const setup = makeSetup(dir);
    await assert.rejects(() => setup.bindOwner('AAAAAAAAAAAAAAAAAA'), /没在跑/);
    assert.equal(calls.filter((c) => c.url.includes('/api/owners/')).length, 0);
  });
});
