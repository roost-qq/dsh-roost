// 框架自带更新：dsh-roost 只做「读状态 / 转发触发」，不实现下载验签。
//
// 这里钉的是方案里最容易写错的几件事：
//   1. 开关默认关（detect 回生效值，不会 undefined）；
//   2. 状态来自框架 services 快照，老框架 / 没跑都要说人话，不能红字；
//   3. 自动装只在「开关开 + 有新版 + 本次没装过 + 不在等重启」时发生；
//   4. 装完不重启 —— 没有 stopOnce/startOnce，needsRestart 常驻提示；
//   5. 手动触发不受开关限制。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSetup } from '../src/setup.js';
import { DEFAULTS } from '../src/config.js';

function makeRoost({ port = 15211 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fw-update-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'main.js'), '// stub\n', 'utf8');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'qq-bot-roost', version: 'v1.2.0' }), 'utf8');
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data', 'ports.json'), JSON.stringify({ roost: { want: port, actual: port } }), 'utf8');
  return dir;
}

function makeSetup(dir, setupCfg = {}) {
  const cfg = { server: { port: 17321 }, setup: { roostDir: dir, version: 'v1.2.0', ...setupCfg } };
  return createSetup({
    cfgOf: () => cfg,
    setCfg: () => {},
    dataDir: () => mkdtempSync(join(tmpdir(), 'dsh-data-')),
    log: () => {},
  });
}

async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const healthRes = () => ({
  ok: true, status: 200,
  text: async () => JSON.stringify({ ok: true, bots: [], online: 0, total: 0 }),
});
/** 带 key 的 GET 会带 /api/services；POST /api/update/apply 单独处理 */
function router({ services, apply } = {}) {
  return async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/healthz')) return healthRes();
    if (u.includes('/api/services')) {
      return { ok: true, status: 200, text: async () => JSON.stringify(services || {}) };
    }
    if (u.includes('/api/update/apply')) {
      if (String(init.method).toUpperCase() !== 'POST') {
        return { ok: false, status: 405, text: async () => '{}' };
      }
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify(apply || { ok: true, from: '1.2.0', to: '1.2.1' }),
      };
    }
    return { ok: false, status: 404, text: async () => '{}' };
  };
}
const withUpdate = (last, extra = {}) => ({
  extra: { autoUpdate: { last, checkedAt: 1700000000000, state: 'running', detail: '', ...extra } },
});

test('开关默认关：DEFAULTS 与 detect 的生效值都是 false', async () => {
  assert.equal(DEFAULTS.setup.frameworkAutoUpdate, false, '默认关是用户明确的选择');
  const dir = makeRoost();
  await withFetch(router({ services: withUpdate({ ok: true, hasUpdate: false }) }), async () => {
    const off = await makeSetup(dir).detect();
    assert.equal(off.frameworkAutoUpdate, false, '没写过键要显示成关');
    const on = await makeSetup(dir, { frameworkAutoUpdate: true }).detect();
    assert.equal(on.frameworkAutoUpdate, true, '显式 true 才是开');
  });
});

test('状态：读框架 services 快照，规范化 current/latest/hasUpdate/needsRestart', async () => {
  const dir = makeRoost();
  const setup = makeSetup(dir);
  const last = { ok: true, current: '1.2.0', latest: '1.2.1', hasUpdate: true, needsRestart: false };
  await withFetch(router({ services: withUpdate(last) }), async () => {
    const r = await setup.frameworkUpdateStatus();
    assert.equal(r.ok, true);
    assert.equal(r.running, true);
    assert.equal(r.supported, true);
    assert.equal(r.current, '1.2.0');
    assert.equal(r.latest, '1.2.1');
    assert.equal(r.hasUpdate, true);
    assert.equal(r.needsRestart, false);
  });
});

test('状态：框架没跑 / 老框架 / 刚启动没结果，都返回可读原因不抛', async () => {
  const dir = makeRoost();
  const setup = makeSetup(dir);
  // 没跑：fetch 全拒绝
  await withFetch(async () => { throw new Error('ECONNREFUSED'); }, async () => {
    const r = await setup.frameworkUpdateStatus();
    assert.equal(r.ok, false);
    assert.equal(r.running, false);
    assert.match(r.error, /没在跑/);
  });
  // 老框架：没 extra.autoUpdate
  await withFetch(router({ services: {} }), async () => {
    const r = await setup.frameworkUpdateStatus();
    assert.equal(r.supported, false);
    assert.match(r.error, /版本太旧/);
  });
  // 刚启动：last 还没查出来
  await withFetch(router({ services: { extra: { autoUpdate: { last: null, checkedAt: 0 } } } }), async () => {
    const r = await setup.frameworkUpdateStatus();
    assert.equal(r.ok, true);
    assert.equal(r.pending, true);
  });
});

test('自动更新：默认关时连框架状态都不读，开关开才装', async () => {
  const dir = makeRoost();
  const last = { ok: true, current: '1.2.0', latest: '1.2.1', hasUpdate: true, needsRestart: false };
  const seen = [];
  const handler = async (url, init) => {
    seen.push(String(url) + (init?.method ? ' ' + init.method : ''));
    return router({ services: withUpdate(last) })(url, init);
  };
  await withFetch(handler, async () => {
    const r1 = await makeSetup(dir).maybeAutoUpdate();
    assert.deepEqual(r1, { ok: true, skipped: 'disabled' });
    assert.ok(!seen.some((u) => u.includes('/api/services')), '关着就不该读框架状态');
    assert.ok(!seen.some((u) => u.includes('/api/update/apply')), '关着就不该触发更新');
  });

  seen.length = 0;
  await withFetch(handler, async () => {
    const r2 = await makeSetup(dir, { frameworkAutoUpdate: true }).maybeAutoUpdate();
    assert.equal(r2.ok, true);
    assert.equal(r2.applied, true);
    assert.equal(r2.to, '1.2.1');
    assert.ok(seen.some((u) => u.includes('/api/update/apply POST')), '开着要触发框架更新');
  });
});

test('自动更新：needsRestart 时不重复装；装过一次后本次进程不再装', async () => {
  const dir = makeRoost();
  const seen = [];
  const handler = async (url, init) => {
    if (String(url).includes('/api/update/apply')) seen.push('apply');
    return router({ services: withUpdate({ ok: true, current: '1.2.1', latest: '1.2.1', hasUpdate: false, needsRestart: true }) })(url, init);
  };
  await withFetch(handler, async () => {
    const setup = makeSetup(dir, { frameworkAutoUpdate: true });
    const r = await setup.maybeAutoUpdate();
    assert.equal(r.skipped, 'needs_restart');
    assert.equal(seen.length, 0, '已更新待重启时不能重复装');
  });
});

test('手动更新不受开关限制；装完 needsRestart 变 true（不重启）', async () => {
  const dir = makeRoost();
  let last = { ok: true, current: '1.2.0', latest: '1.2.1', hasUpdate: true, needsRestart: false };
  const handler = async (url, init) => router({ services: withUpdate(last), apply: { ok: true, from: '1.2.0', to: '1.2.1', backup: 'data/backups/x' } })(url, init);
  await withFetch(handler, async () => {
    const setup = makeSetup(dir); // 默认关
    const r = await setup.frameworkUpdateApply();
    assert.equal(r.ok, true);
    assert.equal(r.to, '1.2.1');
    const st = await setup.frameworkUpdateStatus();
    assert.equal(st.needsRestart, true, '本进程装过就常驻提示重启');
    assert.equal(st.hasUpdate, true, '框架快照没刷新前仍报有版，但 needsRestart 挡住重复装');
  });
});

test('回归：框架重启后标记自动清除——提示消失，后续新版还能自动装', async () => {
  const dir = makeRoost();
  // 快照可变：装完没刷 → 用户重启框架 → 框架自己重算 needsRestart
  let last = { ok: true, current: '1.2.0', latest: '1.2.1', hasUpdate: true, needsRestart: false };
  let applyCount = 0;
  const handler = async (url, init = {}) => {
    if (String(url).includes('/api/update/apply')) applyCount++;
    return router({
      services: withUpdate(last),
      apply: { ok: true, from: '1.2.0', to: '1.2.1' },
    })(url, init);
  };
  await withFetch(handler, async () => {
    const setup = makeSetup(dir, { frameworkAutoUpdate: true });

    // 1) 装完：标记立住，提示需重启，本次进程不再重复装
    assert.equal((await setup.frameworkUpdateApply()).ok, true);
    assert.equal((await setup.frameworkUpdateStatus()).needsRestart, true);
    assert.equal((await setup.maybeAutoUpdate()).skipped, 'applied');
    assert.equal(applyCount, 1);

    // 2) 模拟重启框架：DSH 进程没动，但框架重算快照（pkg mtime <= 进程启动时间）
    last = { ok: true, current: '1.2.1', latest: '1.2.1', hasUpdate: false, needsRestart: false };

    // 3) 关键：不先刷面板，直接跑自动检查也应恢复，不能被旧标记永久挡住
    assert.equal((await setup.maybeAutoUpdate()).skipped, 'up_to_date');
    assert.equal((await setup.frameworkUpdateStatus()).needsRestart, false, '重启已生效，提示要消失');

    // 4) 又出新版：自动更新恢复工作
    last = { ok: true, current: '1.2.1', latest: '1.2.2', hasUpdate: true, needsRestart: false };
    assert.equal((await setup.maybeAutoUpdate()).applied, true);
    assert.equal(applyCount, 2);
  });
});

test('清标记要版本和 needsRestart 同时对上，只对一个都不清', async () => {
  const dir = makeRoost();
  let last = { ok: true, current: '1.2.0', latest: '1.2.1', hasUpdate: true, needsRestart: false };
  await withFetch(router({ services: withUpdate(last) }), async () => {
    const setup = makeSetup(dir, { frameworkAutoUpdate: true });
    assert.equal((await setup.frameworkUpdateApply()).ok, true); // appliedVersion = 1.2.1

    // 版本对上了，但框架仍说要重启 → 不能清
    last = { ok: true, current: '1.2.1', latest: '1.2.2', hasUpdate: true, needsRestart: true };
    assert.equal((await setup.frameworkUpdateStatus()).needsRestart, true);

    // needsRestart 变 false，但版本不是我们装的 → 也不能清
    last = { ok: true, current: '1.2.0', latest: '1.2.2', hasUpdate: true, needsRestart: false };
    assert.equal((await setup.frameworkUpdateStatus()).needsRestart, true);
  });
});

test('更新失败原样报错，不假装成功；框架没跑直接拒', async () => {
  const dir = makeRoost();
  await withFetch(async (url, init) => {
    if (String(url).includes('/healthz')) return healthRes();
    if (String(url).includes('/api/update/apply')) {
      return { ok: false, status: 400, text: async () => JSON.stringify({ error: '校验签名失败' }) };
    }
    return { ok: false, status: 404, text: async () => '{}' };
  }, async () => {
    const r = await makeSetup(dir).frameworkUpdateApply();
    assert.equal(r.ok, false);
    assert.match(r.error, /签名/);
  });
  await withFetch(async () => { throw new Error('ECONNREFUSED'); }, async () => {
    const r = await makeSetup(dir).frameworkUpdateApply();
    assert.equal(r.ok, false);
    assert.match(r.error, /没在跑/);
  });
});
