// 待整理进度（/memory/backlog）：面板回答「还有多少日记没整理」。
//
// 唯一的硬要求：**判据必须和定时器同源**。定时器用 `done(day, chat)`
// （那天那个会话有没有 `day:<day>:<chat>` 摘要行），这里也必须用它——
// 换一套口径，就会出现「面板说整理完了，凌晨还在跑」或者反过来的假象。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJournal, dayOf } from '../src/journal.js';
import { createConsolidate } from '../src/consolidate.js';

const noop = () => {};
const AT = Date.parse('2026-11-27T12:00:00');

function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-backlog-'));
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  const oldEnv = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = data;
  const j = createJournal({ file: join(data, 'j.sqlite'), log: noop });

  /** 造三天的日记：昨天两个群、前天一个群、大前天一个群 */
  const days = [1, 2, 3].map((i) => dayOf(AT - i * 86_400_000));
  const add = (day, chatId, n = 2) => {
    for (let i = 0; i < n; i += 1) {
      j.add({
        id: `${day}-${chatId}-${i}`,
        at: Date.parse(`${day}T10:00:00`) + i * 1000,
        chatId,
        sender: '甲',
        role: 'user',
        kind: 'chat',
        text: `${chatId} 的第 ${i} 句话`,
      });
    }
  };
  add(days[0], 'g:A', 3);
  add(days[0], 'g:B', 2);
  add(days[1], 'g:A', 1);
  add(days[2], 'g:C', 4);

  const c = createConsolidate({ journal: j, graph: null, memory: null, generate: null, aliasesOf: () => [], log: noop, now: () => AT });
  return {
    j, c, days, add,
    markDone: (day, chatId) => j.add({
      id: `day:${day}:${chatId}`, at: Date.parse(`${day}T23:00:00`), chatId,
      role: 'bot', kind: 'digest', level: 'digest', text: `${day} 的摘要`,
    }),
    done: () => {
      try { j.close(); } catch {}
      if (oldEnv === undefined) delete process.env.DSH_ROOST_DATA;
      else process.env.DSH_ROOST_DATA = oldEnv;
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch {}
    },
  };
}

test('backlog：全没整理时，按「天 × 会话」逐个数，并给出积压条数与最早一天', () => {
  const r = rig();
  try {
    const b = r.c.backlog({ days: 7, at: AT });
    assert.equal(b.pending, 4, '昨天两个群 + 前天一个 + 大前天一个');
    assert.equal(b.rows, 10, '3+2+1+4');
    assert.equal(b.newest, r.days[0], '最新在前');
    assert.equal(b.oldest, r.days[2]);
    assert.equal(b.items[0].rows, 3, '第一个是昨天 g:A 的三条');
  } finally { r.done(); }
});

test('backlog：某天某群写了摘要行就不再算缺（判据与定时器同源）', () => {
  const r = rig();
  try {
    r.markDone(r.days[0], 'g:A');
    const b = r.c.backlog({ days: 7, at: AT });
    assert.equal(b.pending, 3, '昨天 g:A 已完成');
    assert.equal(b.rows, 7, '3 条不再计入');
    assert.ok(!b.items.some((x) => x.day === r.days[0] && x.chatId === 'g:A'));
  } finally { r.done(); }
});

test('backlog：另一个群没整理，不能因为同一天的别人整理过就被算完成', () => {
  const r = rig();
  try {
    r.markDone(r.days[0], 'g:A');
    const b = r.c.backlog({ days: 7, at: AT });
    assert.ok(b.items.some((x) => x.day === r.days[0] && x.chatId === 'g:B'), 'g:B 仍应待整理');
  } finally { r.done(); }
});

test('backlog：全都整理完时 pending 为 0（面板据此说"都整理完了"）', () => {
  const r = rig();
  try {
    r.markDone(r.days[0], 'g:A');
    r.markDone(r.days[0], 'g:B');
    r.markDone(r.days[1], 'g:A');
    r.markDone(r.days[2], 'g:C');
    const b = r.c.backlog({ days: 7, at: AT });
    assert.equal(b.pending, 0);
    assert.equal(b.rows, 0);
    assert.equal(b.oldest, '');
  } finally { r.done(); }
});

test('backlog：days 只扫最近 N 天（积压更早的不算，避免一次扫全库）', () => {
  const r = rig();
  try {
    const b = r.c.backlog({ days: 2, at: AT });
    assert.equal(b.scannedDays, 2);
    assert.equal(b.pending, 3, '昨天两个 + 前天一个；大前天的 g:C 不在窗口内');
  } finally { r.done(); }
});

test('接线守门：路由与面板都在，且用的是同一个 backlog()', () => {
  const root = new URL('../', import.meta.url);
  const host = readFileSync(new URL('src/host.js', root), 'utf8');
  assert.match(host, /route\('\/memory\/backlog'/, '路由要注册');
  assert.match(host, /consolidate\.backlog\(\{ days:/, '必须调 consolidation 的那份判据');
  const cli = readFileSync(new URL('client/client.js', root), 'utf8');
  assert.match(cli, /get\('\/memory\/backlog'\)/, '面板要有入口');
  assert.match(cli, /还有 \$\{r\.pending\} 个「天 × 会话」没整理/, '文案要说清是什么单位');
});
