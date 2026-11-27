// 事实归属（`meta[*].about`）+ v2→v3 迁移 + 老数据精确回填。
//
// 这一层的价值只有一个：**删人时有精确条件**。老数据没有归属，只能靠
// 显示名猜——会改名、会重名，猜就是删错人。所以这里的硬规矩是：
//   · 没传 about 的写入，盘上字节必须和升级前完全一致（默认零变化）；
//   · 迁移只加结构位，**不猜归属**；
//   · 回填只认调用方给的、已确认的别名，解不出来留空（宁漏不误）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemory, MEMORY_SCHEMA_VERSION } from '../src/memory.js';

function freshDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-about-'));
  process.env.DSH_ROOST_DATA = dir;
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

const readRaw = () => JSON.parse(readFileSync(join(process.env.DSH_ROOST_DATA, 'memory.json'), 'utf8'));

test('about：写入时带归属，listFull 读得回来（全局层与会话层）', (t) => {
  freshDir(t);
  const m = createMemory({ log: () => {} });
  m.add('private:u1', '小明在准备考试', 'global', { about: '10001', src: { speaker: '小明' } });
  m.add('group:G1', '小明这周加班', 'chat', { about: '10001' });
  m.add('private:u1', '主人喜欢喝咖啡', 'global', {});

  const g = m.listFull('', []).global;
  assert.equal(g.find((r) => r.text === '小明在准备考试').about, '10001');
  assert.equal(g.find((r) => r.text === '主人喜欢喝咖啡').about, '', '没传 about → 空串（面板好判）');

  const c = m.listFull('group:G1', []).chat;
  assert.equal(c.find((r) => r.text === '小明这周加班').about, '10001');
});

test('about：没传归属时盘上不出现该字段（老调用方字节不变）', (t) => {
  freshDir(t);
  const m = createMemory({ log: () => {} });
  m.add('private:u1', '主人喜欢喝咖啡', 'global', {});
  assert.equal(readRaw().meta.global['主人喜欢喝咖啡'].about, undefined, '不传就不落盘');
});

test('about：重提一句不带归属，不抹掉已有归属', (t) => {
  freshDir(t);
  const m = createMemory({ log: () => {} });
  m.add('private:u1', '小明在准备考试', 'global', { about: '10001' });
  m.add('private:u1', '小明在准备考试', 'global', {}); // 重提，没带归属
  assert.equal(readRaw().meta.global['小明在准备考试'].about, '10001');
});

test('迁移：无版本老库升到 v3，数据一条不丢、也不硬塞 about', (t) => {
  const dir = freshDir(t);
  writeFileSync(join(dir, 'memory.json'), JSON.stringify({
    global: ['主人住在杭州', '小明爱打游戏'],
    chats: { 'private:u1': ['他最近在准备考试'] },
    meta: {
      global: { 主人住在杭州: { w: 2, at: 1700000000000, src: { speaker: '主人' } } },
      chats: { 'private:u1': { 他最近在准备考试: { w: 1, at: 1700000000000, src: { speaker: '小明' } } } },
    },
  }));
  const m = createMemory({ log: () => {} });
  assert.equal(m.listFull('', []).global.length, 2, '全局两条都在');
  assert.equal(m.listFull('private:u1', []).chat.length, 1, '会话一条在');

  /** 触发一次写盘（懒升级） */
  m.add('private:u1', '新增一条', 'global', {});
  const raw = readRaw();
  assert.equal(raw.schemaVersion, MEMORY_SCHEMA_VERSION);
  assert.equal(MEMORY_SCHEMA_VERSION, 3);
  assert.equal(raw.meta.global['主人住在杭州'].about, undefined, '迁移不猜归属');
  assert.equal(raw.meta.chats['private:u1']['他最近在准备考试'].about, undefined);
  assert.equal(raw.meta.global['主人住在杭州'].src.speaker, '主人', '原有出处保留');
});

test('回填：只认 resolve 给出的确认别名，其余留空', (t) => {
  const dir = freshDir(t);
  writeFileSync(join(dir, 'memory.json'), JSON.stringify({
    schemaVersion: 2,
    global: ['小明爱打游戏', '阿猫喜欢猫', '不知道是谁说的'],
    chats: {},
    meta: {
      global: {
        小明爱打游戏: { w: 1, at: 1700000000000, src: { speaker: '小明' } },
        阿猫喜欢猫: { w: 1, at: 1700000000000, src: { speaker: '阿猫' } },
        不知道是谁说的: { w: 1, at: 1700000000000 },
      },
      chats: {},
    },
  }));
  const m = createMemory({ log: () => {} });
  /** 只确认了「小明 → 10001」；「阿猫」没确认过 */
  const confirmed = new Map([['小明', '10001']]);
  const r = m.backfillAbout({ resolve: (sp) => confirmed.get(sp) || '' });
  assert.equal(r.changed, 1, '只补确认过的那一条');
  assert.equal(r.checked, 3);

  const raw = readRaw();
  assert.equal(raw.meta.global['小明爱打游戏'].about, '10001');
  assert.equal(raw.meta.global['阿猫喜欢猫'].about, undefined, '没确认的一律不动');
  assert.equal(raw.meta.global['不知道是谁说的'].about, undefined, '没 speaker 的猜不出');
});

test('回填：幂等——已有归属的不再改', (t) => {
  freshDir(t);
  const m = createMemory({ log: () => {} });
  m.add('', '小明爱打游戏', 'global', { about: '10001', src: { speaker: '小明' } });
  const r1 = m.backfillAbout({ resolve: () => '99999' });
  assert.equal(r1.changed, 0);
  assert.equal(readRaw().meta.global['小明爱打游戏'].about, '10001', '已有归属不被覆盖');
});

test('回填：没给 resolve 直接空跑，不留半截状态', (t) => {
  freshDir(t);
  const m = createMemory({ log: () => {} });
  m.add('', '小明爱打游戏', 'global', { src: { speaker: '小明' } });
  assert.deepEqual(m.backfillAbout({}), { checked: 0, changed: 0 });
  assert.deepEqual(m.backfillAbout(), { checked: 0, changed: 0 });
});
