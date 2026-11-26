import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PEER } from '../src/fence.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'roost-route-auth-'));

/**
 * 假宿主：只收 route 对象，不跑任何鉴权。
 *
 * `connection` 传什么就决定 `fence()` 走哪条路：
 *   - 不传 / undefined → 宿主没有 connection 服务，降级为本地回环判定
 *   - 传 `{ admit }` → 旧宿主的真实鉴权入口
 */
function makeCtx(dir, routes, connection, cleanups) {
  const noop = () => () => {};
  return {
    agents: { get: () => null, list: () => [], create: async () => ({ id: 'a', ctx: {} }) },
    sessions: { get: () => null, list: () => [], create: () => ({ id: 's' }) },
    systemPrompt: { context: noop },
    webServer: {
      register: (r) => {
        routes.set(r.path, r);
        return noop;
      },
    },
    config: {},
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    effect: (cb) => {
      const off = cb();
      if (typeof off === 'function') cleanups.push(off);
      return noop;
    },
    on: () => noop,
    get: (name) => (name === 'connection' ? connection : undefined),
    dataDir: join(dir, 'data'),
    dir,
  };
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    end(s) {
      this.body = s ? JSON.parse(s) : undefined;
    },
  };
}

/** 按宿主的方式调 handler：传 peer 就是新版，不传就是旧版。 */
function call(route, req, peer) {
  const res = makeRes();
  const out = peer === undefined ? route.handler(req, res) : route.handler(req, res, peer);
  return Promise.resolve(out).then(() => res);
}

const loopbackReq = () => ({ headers: { host: '127.0.0.1:8931' }, url: '/roost/api/status' });
const foreignReq = () => ({ headers: { host: 'evil.example.com' }, url: '/roost/api/status' });

async function withHost(fn, connection) {
  const host = await import('../src/host.js');
  const dir = tmp();
  const oldEnv = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = join(dir, 'data');
  const routes = new Map();
  const cleanups = [];
  try {
    host.apply(makeCtx(dir, routes, connection, cleanups));
    await fn(routes);
  } finally {
    if (oldEnv === undefined) delete process.env.DSH_ROOST_DATA;
    else process.env.DSH_ROOST_DATA = oldEnv;
    for (const c of cleanups) {
      try {
        await c();
      } catch {}
    }
    // sqlite 句柄释放要一拍；Windows 上立即删会 EBUSY
    await new Promise((r) => setTimeout(r, 50));
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test('路由声明：面板 API 是 required，扩展静态页是 anonymous', async () => {
  await withHost(async (routes) => {
    const status = routes.get('/roost/api/status');
    const ext = routes.get('/roost/api/ext-pages');
    assert.ok(status, '没注册 /status');
    assert.ok(ext, '没注册 /ext-pages');
    assert.equal(status.auth, 'required', '面板 API 必须声明 required');
    assert.equal(ext.auth, 'anonymous', '扩展静态页必须声明 anonymous');
  });
});

test('旧宿主（handler 只收两个参数）：仍然走 fence，回环放行', async () => {
  await withHost(async (routes) => {
    const status = routes.get('/roost/api/status');
    const res = await call(status, loopbackReq());
    assert.equal(res.statusCode, 200, `状态 ${res.statusCode}：${JSON.stringify(res.body)}`);
  });
});

test('旧宿主：fence 仍然能拒掉非回环来源', async () => {
  await withHost(async (routes) => {
    const status = routes.get('/roost/api/status');
    const res = await call(status, foreignReq());
    assert.equal(res.statusCode, 403, '非回环 Host 必须被拒');
  });
});

test('旧宿主 + 有 connection 服务：admit 拒绝时照样 403', async () => {
  await withHost(async (routes) => {
    const status = routes.get('/roost/api/status');
    const res = await call(status, loopbackReq());
    assert.equal(res.statusCode, 403, 'connection.admit 拒绝必须生效');
  }, { admit: () => ({ rejection: 403 }) });
});

test('新宿主：用宿主交回的 peer，不再调 fence', async () => {
  await withHost(async (routes) => {
    const status = routes.get('/roost/api/status');
    const req = foreignReq();
    const peer = { id: 'peer-owner-1', principal: { kind: 'owner' } };
    const res = await call(status, req, peer);
    assert.equal(res.statusCode, 200, `状态 ${res.statusCode}：${JSON.stringify(res.body)}`);
    assert.equal(req[PEER], peer, 'peer 要挂到 req 上给审计用');
  });
});

test('新宿主：非 owner 的 peer 仍然 403', async () => {
  await withHost(async (routes) => {
    const status = routes.get('/roost/api/status');
    const res = await call(status, loopbackReq(), { id: 'p-member', principal: { kind: 'member' } });
    assert.equal(res.statusCode, 403, '非 owner 必须被拒');
  });
});

test('扩展静态页：两代宿主都不走 fence', async () => {
  await withHost(async (routes) => {
    const ext = routes.get('/roost/api/ext-pages');
    const req = () => ({ headers: { host: 'evil.example.com' }, url: '/roost/api/ext-pages?id=x&file=y' });
    const oldHost = await call(ext, req());
    const newHost = await call(ext, req(), undefined);
    assert.notEqual(oldHost.statusCode, 403, `旧宿主把静态页拦了：${JSON.stringify(oldHost.body)}`);
    assert.notEqual(newHost.statusCode, 403, `新宿主把静态页拦了：${JSON.stringify(newHost.body)}`);
  });
});
