import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FEATURES,
  FEATURE_GROUPS,
  FEATURE_HOME,
  featureIdsOn,
  featureHomeGaps,
  visibleFeatures,
} from '../src/features.js';

/**
 * 2026-11-26 面板信息架构调整的护栏。
 *
 * 背景：权限页 Sec「她会做什么」原本是 33 个功能开关的唯一入口，
 * 现在按 `FEATURE_HOME` 搬到各功能页。搬迁最容易出的错不是写错逻辑，
 * 而是**某个开关谁都没接**——界面上静默消失，代码和测试全绿。
 *
 * 所以这里把「零遗漏」变成红线：
 * 1. 每个可见开关必须恰好有一个家；
 * 2. 家里不能有已经不存在的开关（防止脏配置指路到空白页）；
 * 3. 每个家必须是真实存在的页签；
 * 4. 拆组后不能有任何一项在 `FEATURE_GROUPS` 里领不到（组表也要跟着一致）。
 */

/** 面板里真实存在的二级页签 key（与 client.js 的 TABS 对齐，只列本次涉及开关的页） */
const REAL_TABS = new Set([
  'overview', 'talk', 'her', 'mood', 'memory', 'people',
  'caps', 'express', 'stickers', 'groupchat', 'awake', 'security', 'ext',
]);

test('每个可见开关都恰好有一个家，没有遗漏', () => {
  const { missing, unknown } = featureHomeGaps();
  assert.deepEqual(missing, [], `这些开关没有页面承接，会从界面上消失：${missing.join(', ')}`);
  assert.deepEqual(unknown, [], `FEATURE_HOME 指向了不存在的开关：${unknown.join(', ')}`);
});

test('FEATURE_HOME 覆盖数 = 可见开关数 = 33', () => {
  const visible = visibleFeatures();
  assert.equal(visible.length, 33);
  assert.equal(Object.keys(FEATURE_HOME).length, visible.length);
});

test('每个家都是真实页签', () => {
  for (const [id, tab] of Object.entries(FEATURE_HOME)) {
    assert.ok(REAL_TABS.has(tab), `开关 ${id} 被指到了不存在的页签「${tab}」`);
  }
});

test('按家分组后不重不漏：所有 id 并集等于全部可见开关', () => {
  const seen = [];
  for (const tab of REAL_TABS) seen.push(...featureIdsOn(tab));
  assert.equal(seen.length, new Set(seen).size, '同一个开关被两个页面同时承接');
  assert.deepEqual(
    [...seen].sort(),
    visibleFeatures().map((f) => f.id).sort(),
    '有开关没被任何页面接住，或有重复承接',
  );
});

test('拆组是显式的：talk / memory / work 三组必须跨页', () => {
  const crossOf = (groupId) => {
    const group = FEATURE_GROUPS.find((g) => g.id === groupId);
    const homes = new Set(group.ids.map((id) => FEATURE_HOME[id]));
    return [...homes].sort();
  };
  // 整组渲染会在这几组上出错：表情包去图库、语音去语音页、
  // 引用/撤回回群聊策略页（那里已有唯一控件）、closing 去聊天…
  assert.deepEqual(crossOf('talk'), ['express', 'groupchat', 'stickers', 'talk']);
  assert.deepEqual(crossOf('memory'), ['memory', 'talk']);
  assert.deepEqual(crossOf('work'), ['her', 'talk']);
  // queue / proactive / run 是整组同页
  assert.deepEqual(crossOf('queue'), ['talk']);
  assert.deepEqual(crossOf('proactive'), ['awake']);
  assert.deepEqual(crossOf('run'), ['overview']);
});

test('引用/撤回三项归群聊策略页，不在聊天页重复渲染', () => {
  for (const id of ['qqRetract', 'quoteReply', 'quotePercent']) {
    assert.equal(FEATURE_HOME[id], 'groupchat', `${id} 会与群聊策略页的现有控件重复`);
  }
});

test('FEATURES 与 FEATURE_GROUPS 双向一致：每个开关都至少属于一个组', () => {
  const inGroups = new Set(FEATURE_GROUPS.flatMap((g) => g.ids));
  const orphans = FEATURES.filter((f) => !f.staged && !inGroups.has(f.id)).map((f) => f.id);
  assert.deepEqual(orphans, [], `这些开关不在任何 FEATURE_GROUPS 里：${orphans.join(', ')}`);
  const dupes = FEATURE_GROUPS.flatMap((g) => g.ids)
    .filter((id, i, arr) => arr.indexOf(id) !== i);
  assert.deepEqual(dupes, [], `这些开关被多个组重复声明：${dupes.join(', ')}`);
});

test('retention 四项必须整组同家（dry-run 预览跟着走）', () => {
  const four = ['retentionFactsMode', 'retentionJournalMode', 'retentionThresholdPct', 'retentionMinProtectDays'];
  for (const id of four) assert.equal(FEATURE_HOME[id], 'memory');
});
