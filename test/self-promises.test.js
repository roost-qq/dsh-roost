// B-lite（2026-11-28）：她写自述 → 主人勾「算数」→ 才进「你答应过自己的」注入段。
//
// 为什么不走"模型提案改性格"那一套：那要改巩固 prompt，影响**所有**巩固输出，
// 还得防她自我强化（「我应该更顺从」这种提案最危险）。让她照旧自由地写、
// 主人从里面挑，不用改 prompt，也顺手补了「面板看不到她写了什么」这个真空。
//
// 三条硬约束：
//   1. **没勾过的绝不注入**——勾之前的行为与升级前逐字节一致；
//   2. 勾过的**不再重复注**（自述段把它让给「答应过自己的」那一段）；
//   3. 正文被改写 / 被遗忘 → 勾选标记作废（主人批的不是新那句）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSelf } from '../src/self.js';

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-self-'));
  const prev = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = dir;
  let clock = 1000;
  const s = createSelf({ now: () => clock, log: () => {} });
  return {
    s, dir,
    tick: (t) => { clock = t; },
    raw: () => JSON.parse(readFileSync(join(dir, 'self.json'), 'utf8')),
    done: () => {
      if (prev === undefined) delete process.env.DSH_ROOST_DATA; else process.env.DSH_ROOST_DATA = prev;
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch {}
    },
  };
}

test('B-lite：没勾过时 promises() 是空串（升级前后注入一致）', () => {
  const f = rig();
  try {
    f.s.add({ text: '今天话太多了，明天简短点', day: '2026-11-27' });
    assert.equal(f.s.promises(), '');
    /** 自述照旧能读到 */
    assert.match(f.s.text(3), /今天话太多了/);
  } finally { f.done(); }
});

test('B-lite：勾了之后进「你答应过自己的」，且自述段不再重复注', () => {
  const f = rig();
  try {
    f.s.add({ text: '今天话太多了，明天简短点', day: '2026-11-27' });
    const r = f.s.mark({ day: '2026-11-27', on: true });
    assert.equal(r.ok, true, r.why);
    assert.equal(f.raw().notes[0].kept, true);

    const pr = f.s.promises();
    assert.match(pr, /你答应过自己的/);
    assert.match(pr, /明天简短点/);
    assert.match(pr, /照着做/, '要说清这是拿来做的，不是拿来念的');
    /** 同一句不能既在自述段又在承诺段：两处都注 = 双份预算、双重暗示 */
    assert.equal(f.s.text(3).includes('明天简短点'), false);
  } finally { f.done(); }
});

test('B-lite：取消勾选 → 回到自述段，不再进承诺段', () => {
  const f = rig();
  try {
    f.s.add({ text: '别老用感叹号', day: '2026-11-27' });
    f.s.mark({ day: '2026-11-27', on: true });
    f.s.mark({ day: '2026-11-27', on: false });
    assert.equal(f.s.promises(), '');
    assert.match(f.s.text(3), /别老用感叹号/);
    assert.equal(f.raw().notes[0].kept, undefined, '取消要真删字段，不留 false');
  } finally { f.done(); }
});

test('B-lite：同一天重写，正文没变 → 保留勾选；正文变了 → 标记作废', () => {
  const f = rig();
  try {
    f.s.add({ text: '今天有点急', day: '2026-11-27' });
    f.s.mark({ day: '2026-11-27', on: true });

    /** 巩固重跑，写出同一句：主人批的这句还在，不该丢 */
    f.s.add({ text: '今天有点急', day: '2026-11-27' });
    assert.equal(f.raw().notes[0].kept, true, '同一句重写要保留标记');

    /** 换了一句：主人批过的不是这句，标记必须作废 */
    f.s.add({ text: '今天很有耐心', day: '2026-11-27' });
    assert.equal(f.raw().notes[0].kept, undefined, '正文变了标记作废');
    assert.equal(f.s.promises(), '');
  } finally { f.done(); }
});

test('B-lite：被遗忘的自述不注入，勾选也一并作废', () => {
  const f = rig();
  try {
    f.s.add({ text: '和小明聊天要更耐心', day: '2026-11-27' });
    f.s.mark({ day: '2026-11-27', on: true });
    assert.match(f.s.promises(), /小明/);
    f.s.forget('小明');
    assert.equal(f.s.promises(), '', '换成"已遗忘"之后不该还挂着勾');
    assert.equal(f.raw().notes[0].kept, undefined);
  } finally { f.done(); }
});

test('B-lite：mark 找不到那条就返回 ok:false（不猜、不凭空建）', () => {
  const f = rig();
  try {
    assert.equal(f.s.mark({ day: '2026-01-01', on: true }).ok, false);
    assert.equal(f.s.mark({ on: true }).ok, false, '缺日期也不认');
    assert.equal(f.s.all().notes.length, 0);
  } finally { f.done(); }
});

test('B-lite：接线守门（quick op + 边界注入 + 面板 + 权限登记）', () => {
  const root = new URL('../', import.meta.url);
  const host = readFileSync(new URL('src/host.js', root), 'utf8');
  assert.match(host, /case 'self\.keep':/, '要有 quick op');
  assert.match(host, /const pr = self\.promises\(3\);/, '会话边界要注入承诺段');
  assert.match(host, /kept: n\.kept === true/, '/memory 要把勾选状态给面板');
  const cli = readFileSync(new URL('client/client.js', root), 'utf8');
  assert.match(cli, /quick\('self\.keep', \{ day: n2\.day, text: n2\.text, on: !n2\.kept \}\)/, '面板要能勾');
  const scopes = readFileSync(new URL('src/ext-quick-scopes.js', root), 'utf8');
  assert.match(scopes, /'self\.keep': 'prompt:write'/, '权限要登记');
});
