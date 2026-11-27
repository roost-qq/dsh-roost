// 相关链接（`links`）：同一实体的不同阶段，两条都活着且互相能找到。
//
// 判据**交给模型**（`buildLinkPrompt` + 巩固收尾那次调用），因为字符相似度
// 在这件事上是反的——本仓实测：「狗叫 Max」vs「带 Max 露营」0.21、
// 「跑步五公里」vs「跑步把膝盖伤了」0.13，而「喜欢咖啡」vs「喜欢喝茶」0.57。
//
// 这一层只钉三件事：① 模型给的编号要能被校验 ② 落账前必须确认"两条都在这一层、都还活着"
// ③ 开关关着时**一次请求都不多发**、输出形状不变。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemory, factIdOf, LINKS_MAX } from '../src/memory.js';
import { createJournal } from '../src/journal.js';
import { createConsolidate, buildLinkPrompt, yesterdayOf } from '../src/consolidate.js';
import { normalizeEntry } from '../src/dry-run.js';
import { restoreRetentionRows } from '../src/backup.js';

const noop = () => {};

function memRig() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-links-'));
  const prev = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = dir;
  const file = join(dir, 'memory.json');
  writeFileSync(file, JSON.stringify({ global: [], chats: {}, meta: { global: {}, chats: {} } }), 'utf8');
  return {
    dir, file,
    m: () => createMemory({ now: () => 1000, log: noop }),
    raw: () => JSON.parse(readFileSync(file, 'utf8')),
    done: () => {
      if (prev === undefined) delete process.env.DSH_ROOST_DATA; else process.env.DSH_ROOST_DATA = prev;
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch {}
    },
  };
}

const A = '主人养的狗叫Max';
const B = '主人带Max去露营了';

/* ---------------- 纯数据层 ---------------- */

test('link：两条都在、都活着 → 双向链接，且都不作废', () => {
  const f = memRig();
  try {
    const m = f.m();
    m.add('', A, 'global', {});
    m.add('', B, 'global', {});
    const r = m.link('', A, B, { scope: 'global' });
    assert.equal(r.ok, true, r.why);
    const raw = f.raw();
    assert.deepEqual(raw.meta.global[A].links, [factIdOf(B)]);
    assert.deepEqual(raw.meta.global[B].links, [factIdOf(A)], '必须双向：单向等于没链');
    assert.equal(raw.meta.global[A].until, undefined, '链接不是作废');
  } finally { f.done(); }
});

test('link：有一句不在这层 / 已作废 / 自己对自己 → 整对丢弃（宁漏不误）', () => {
  const f = memRig();
  try {
    const m = f.m();
    m.add('', A, 'global', {});
    m.add('', B, 'global', {});
    assert.equal(m.link('', A, '根本不存在的句子', { scope: 'global' }).ok, false);
    assert.equal(m.link('', A, A, { scope: 'global' }).ok, false, '自己对自己不算');
    m.retention.expire([{ scope: 'global', chatId: '', text: B }], 500);
    assert.equal(m.link('', A, B, { scope: 'global' }).ok, false, '作废的不链');
    assert.equal(f.raw().meta.global[A].links, undefined, '失败不能留半条边');
  } finally { f.done(); }
});

test('link：每边最多 3 条、不重复', () => {
  const f = memRig();
  try {
    const m = f.m();
    m.add('', A, 'global', {});
    const others = ['带Max去打疫苗', '给Max换了大笼子', 'Max今天不肯吃饭', 'Max的毛掉了不少'];
    for (const t of others) m.add('', t, 'global', {});
    for (const t of others) m.link('', A, t, { scope: 'global' });
    const links = f.raw().meta.global[A].links || [];
    assert.equal(links.length, LINKS_MAX, `上限 ${LINKS_MAX}`);
    assert.equal(new Set(links).size, links.length, '不能重复');
  } finally { f.done(); }
});

test('listFull 透出 links（面板显示「相关 N」）', () => {
  const f = memRig();
  try {
    const m = f.m();
    m.add('', A, 'global', {});
    m.add('', B, 'global', {});
    m.link('', A, B, { scope: 'global' });
    const row = m.listFull('', []).global.find((r) => r.text === A);
    assert.deepEqual(row.links, [factIdOf(B)]);
  } finally { f.done(); }
});

test('没有链时字段不落盘（老库与精简口径不变）', () => {
  const f = memRig();
  try {
    const m = f.m();
    m.add('', '主人今天买了一把伞', 'global', {});
    assert.equal(f.raw().meta.global['主人今天买了一把伞'].links, undefined);
  } finally { f.done(); }
});

test('四处白名单：entries/normalizeEntry/backup/insertRaw 都保 links', () => {
  const f = memRig();
  try {
    const m = f.m();
    m.add('', A, 'global', {});
    m.add('', B, 'global', {});
    m.link('', A, B, { scope: 'global' });
    const row = m.retention.entries().find((e) => e.text === A);
    assert.deepEqual(row.links, [factIdOf(B)], 'entries 导出');
    assert.deepEqual(normalizeEntry({ ...row }, 'facts').links, row.links, 'dry-run 白名单');

    let inserted = null;
    const fakeMemory = { retention: { entries: () => [] }, insertRaw: (r) => { inserted = r; return true; } };
    restoreRetentionRows({ payload: { facts: [row], journal: [] }, memory: fakeMemory, journal: {} });
    assert.deepEqual(inserted?.links, row.links, 'backup 白名单');

    const f2 = memRig();
    try {
      f2.m().insertRaw(row);
      assert.deepEqual(f2.raw().meta.global[A].links, row.links, 'insertRaw 落盘');
    } finally { f2.done(); }
  } finally { f.done(); }
});

/* ---------------- 巩固里的那次判定 ---------------- */

test('buildLinkPrompt：分组编号 + 明确"不要只因句式像就配"', () => {
  const p = buildLinkPrompt([
    { key: 'global', texts: [A, B] },
    { key: 'group:G1', texts: ['群里说周末聚餐'] },
  ]);
  assert.match(p, /—— global ——/);
  assert.match(p, /1\. 主人养的狗叫Max/);
  assert.match(p, /2\. 主人带Max去露营了/);
  assert.match(p, /—— group:G1 ——/);
  assert.match(p, /不要.*句式像/);
  assert.match(p, /"links"/);
});

function consRig({ linksEnabled = false, linkPairs = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-linkpass-'));
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  const prev = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = data;
  const now = Date.parse('2026-11-27T10:00:00');
  const day = yesterdayOf(now);
  const base = Date.parse(`${day}T09:00:00`);
  const j = createJournal({ file: join(data, 'j.sqlite'), log: noop });
  j.add({ id: 'r1', at: base, chatId: 'g1', sender: '甲', role: 'user', kind: 'chat', text: '我家狗叫Max' });
  j.add({ id: 'r2', at: base + 1000, chatId: 'g1', sender: '甲', role: 'user', kind: 'chat', text: '周末带Max去露营' });

  const m = createMemory({ now: () => now, log: noop });
  m.add('g1', A, 'chat', {});
  m.add('g1', B, 'chat', {});

  const prompts = [];
  const generate = async (p) => {
    prompts.push(p);
    if (p.includes('两两配对')) {
      return JSON.stringify({ links: linkPairs || [{ l: 'g1', a: 1, b: 2 }] });
    }
    return '{}';
  };
  const c = createConsolidate({
    journal: j, graph: null, memory: m, generate,
    aliasesOf: () => [], log: noop, now: () => now,
    linksEnabled: typeof linksEnabled === 'function' ? linksEnabled : () => linksEnabled,
  });
  return {
    m, j, c, day, prompts,
    run: () => c.run({ day }),
    links: () => m.listFull('g1', []).chat.find((x) => x.text === A)?.links,
    done: () => {
      try { j.close(); } catch {}
      if (prev === undefined) delete process.env.DSH_ROOST_DATA; else process.env.DSH_ROOST_DATA = prev;
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch {}
    },
  };
}

test('巩固：开关关着时一次链接判定都不发', async () => {
  const r = consRig({ linksEnabled: false });
  try {
    const st = await r.run();
    assert.equal(st.ok, true, st.reason);
    assert.equal(r.prompts.some((p) => p.includes('两两配对')), false, '不该多发请求');
    assert.equal((r.links() || []).length, 0, '不该写链接');
  } finally { r.done(); }
});

test('巩固：开关打开时判一次，模型给的编号落成双向链接', async () => {
  const r = consRig({ linksEnabled: true });
  try {
    const st = await r.run();
    assert.equal(st.ok, true, st.reason);
    assert.equal(r.prompts.filter((p) => p.includes('两两配对')).length, 1, '只判一次');
    assert.deepEqual(r.links(), [factIdOf(B)]);
    assert.equal(st.links, 1, 'stats 里报对数');
  } finally { r.done(); }
});

test('巩固：模型给了越界编号 / 不存在的分组 → 静默丢弃，不写半条边', async () => {
  const r = consRig({ linksEnabled: true, linkPairs: [{ l: 'g1', a: 1, b: 99 }, { l: '不存在', a: 1, b: 2 }] });
  try {
    const st = await r.run();
    assert.equal(st.ok, true, st.reason);
    assert.equal((r.links() || []).length, 0, '编号非法就整对丢弃');
  } finally { r.done(); }
});

test('默认关：config 里是 false，宿主把开关热读接进巩固，面板能显示条数', () => {
  const root = new URL('../', import.meta.url);
  const cfg = readFileSync(new URL('src/config.js', root), 'utf8');
  assert.match(cfg, /links: \{ enabled: false \}/, '默认必须关（关着不多发请求）');
  const host = readFileSync(new URL('src/host.js', root), 'utf8');
  assert.match(host, /linksEnabled: \(\) => cfg\.memory\?\.links\?\.enabled === true/, '开关要热读');
  const cli = readFileSync(new URL('client/client.js', root), 'utf8');
  assert.match(cli, /parts\.push\(`相关 \$\{d\.links\.length\}`\)/, '面板要能看到「相关 N」');
})
