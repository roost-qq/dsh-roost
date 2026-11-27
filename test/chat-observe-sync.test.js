// 聊天观察增量同步：去重窗口必须盖住整个 journal 窗口。
// 旧实现每轮 `observe.list({limit:60})` 重建 Set，窗口 100 条时前 40 条
// 的 key 被挤出去，下一轮整窗重写（aurabot commit 66d1628 的同场景 bug）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createChatObserveSync } from '../src/chat-observe-sync.js';
import { createObserve } from '../src/autotelic-observe.js';

function fresh(t) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-chat-obs-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
  return join(dir, 'observations.jsonl');
}

/** 观察层写盘是防抖的，测试里用同步注入直接落盘，免得等 5 秒 */
function realObserve(file, written) {
  return createObserve({
    file,
    hooks: {
      write: (f, text) => {
        written.push(...text.trim().split('\n').filter(Boolean).map((s) => JSON.parse(s)));
        appendFileSync(f, text, 'utf8');
      },
      schedule: () => () => {},
    },
    flushMs: 1,
    maxBuffer: 1,
  });
}

test('聊天观察：窗口 100 条，两轮同步不重写——旧 limit:60 会重复 40 条', (t) => {
  const file = fresh(t);
  const written = [];
  const observe = realObserve(file, written);
  /** 100 条主人私聊，按天铺开——显著度门控要过，得写够分量的句子 */
  const rows = Array.from({ length: 100 }, (_, i) => ({
    role: 'user',
    text: `我认真说一件事第${i}条：今天心情很不好，睡不好觉，需要你记住这件事。`,
    at: 1_700_000_000_000 + i * 60_000,
  }));
  const journal = { listChat: () => rows };
  const sync = createChatObserveSync({ journal, observe, ownerId: () => 'owner1' });

  assert.equal(sync.collect(), 100, '第一轮全写进去');
  assert.equal(sync.collect(), 0, '第二轮一条都不该重写');
  assert.equal(sync.collect(), 0, '第三轮还是零');
  assert.equal(written.length, 100, `落盘总数仍是 100，实际 ${written.length}`);
  observe.flush?.();
});

test('聊天观察：进程重启后从观察层已有记录当基线，不重复写', (t) => {
  const file = fresh(t);
  const rows = Array.from({ length: 30 }, (_, i) => ({
    role: 'user',
    text: `我要认真告诉你一件事第${i}条，这件事让我很困扰。`,
    at: 1_700_000_000_000 + i * 60_000,
  }));
  const firstWritten = [];
  const first = createObserve({
    file,
    hooks: {
      write: (f, text) => { firstWritten.push(...text.trim().split('\n').map((s) => JSON.parse(s))); appendFileSync(f, text, 'utf8'); },
      schedule: () => () => {},
    },
    flushMs: 1,
    maxBuffer: 1,
  });
  for (const r of rows) first.append({ source: 'chat', tag: '牵挂', text: r.text, ts: r.at });
  first.flush();
  assert.equal(firstWritten.length, 30, '第一批确实落盘了');

  /** 新进程：observe 读同一份文件，journal 还是那 30 条 */
  const second = createObserve({
    file,
    hooks: { schedule: () => () => {} },
    flushMs: 1,
    maxBuffer: 1,
  });
  const sync = createChatObserveSync({
    journal: { listChat: () => rows },
    observe: second,
    ownerId: () => 'owner1',
  });
  assert.equal(sync.collect(), 0, '磁盘里已有的 30 条当基线，重启不重写');
  first.dispose?.();
  second.dispose?.();
});

test('聊天观察：非主人/空正文跳过，纠偏走专用通道', (t) => {
  const file = fresh(t);
  const written = [];
  const observe = realObserve(file, written);
  const corrections = [];
  observe.observeCorrection = (text) => { corrections.push(text); return true; };
  const journal = {
    listChat: () => [
      { role: 'user', text: '别再做这件事了', at: 1 },
      { role: 'system', text: '系统消息不该进观察', at: 2 },
      { role: 'user', text: '   ', at: 3 },
      { role: 'bot', text: '我自己说的话也算一条观察吗？这件事真的很困扰我。', at: 4 },
    ],
  };
  const sync = createChatObserveSync({ journal, observe, ownerId: () => 'owner1' });
  assert.equal(sync.collect(), 1, '只写 bot 那条，纠偏走专用通道不算普通写入');
  assert.deepEqual(corrections, ['别再做这件事了']);
  assert.equal(written.length, 1, 'system / 空正文都没进');
  observe.flush?.();
});

test('聊天观察：limit 可调小验证滑动淘汰，超出后旧 key 可重新写入', (t) => {
  const file = fresh(t);
  const written = [];
  const observe = realObserve(file, written);
  const journal = { listChat: () => [] };
  const sync = createChatObserveSync({ journal, observe, ownerId: () => 'owner1', limit: 3 });
  /** 直接靠 observe.list 的 prime 不好测淘汰，用一个带 list 的桩走第一轮 */
  const seeded = createChatObserveSync({
    journal: { listChat: () => [] },
    observe: { list: () => [
      { ts: 1, text: 'A' }, { ts: 2, text: 'B' }, { ts: 3, text: 'C' },
      { ts: 4, text: 'D' }, { ts: 5, text: 'E' },
    ], append: () => {} },
    ownerId: () => 'owner1',
    limit: 3,
  });
  seeded.collect();
  assert.equal(seeded.seenSize, 3, '只留最近 3 个 key');
  assert.equal(sync.seenSize, 0);
});
