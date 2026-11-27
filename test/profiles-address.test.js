// 称呼映射（T1/T3）：`addresses`（我该怎么叫）与 `nicknames`（别人怎么叫）分开存。
//
// 盯四件最容易做错的事：
//   · 把「别人叫他老王」当成「我该叫他老王」（rabbit 专门写了一句提醒就是踩过这坑）；
//   · 换群串称呼（档案段按天冻结，称呼必须跟着会话现算，不能并进去）；
//   · 面板填了 `alias` 却没人读（这条以前是假功能，现在当全局兜底）；
//   · 老库没有这两个字段时，注入内容必须与升级前逐字节一致（空串）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createProfiles } from '../src/profiles.js';

function fresh(t) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-addr-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
  return { file: join(dir, 'profiles.json'), dir };
}

function withPerson(t, key = '10001', name = '小明') {
  const f = fresh(t);
  const p = createProfiles({ file: f.file, now: () => 1000, log: () => {} });
  p.note({ who: name, openid: key, impression: '爱打球' });
  return { ...f, p };
}

test('称呼：全局写 `*`，本群写 chatId，读取时本群优先', (t) => {
  const { p } = withPerson(t);
  assert.equal(p.setAddress('10001', '小明').ok, true, '默认写全局');
  assert.equal(p.setAddress('10001', '老王', { scope: 'group:A' }).ok, true);

  assert.match(p.addressText({ chatId: 'group:A' }), /叫他「老王」/);
  assert.match(p.addressText({ chatId: 'group:B' }), /叫他「小明」/, '别的群用全局称呼');
  assert.match(p.addressText({ chatId: '' }), /叫他「小明」/);
});

test('称呼：清空本群称呼 = 回到全局，不残留空值', (t) => {
  const { p, file } = withPerson(t);
  p.setAddress('10001', '小明');
  p.setAddress('10001', '老王', { scope: 'group:A' });
  p.setAddress('10001', '', { scope: 'group:A' });
  assert.match(p.addressText({ chatId: 'group:A' }), /叫他「小明」/);
  const row = JSON.parse(readFileSync(file, 'utf8'))[0];
  assert.deepEqual(row.addresses, { '*': '小明' }, '本群那条要真删掉');
});

test('称呼：老字段 alias 当全局兜底（以前填了没人读，现在真的生效）', (t) => {
  const { p, file } = withPerson(t);
  /** 模拟老数据：面板填过 alias，没有 addresses */
  const rows = JSON.parse(readFileSync(file, 'utf8'));
  rows[0].alias = '小明同学';
  writeFileSync(file, JSON.stringify(rows), 'utf8');
  const p2 = createProfiles({ file, now: () => 2000, log: () => {} });
  assert.match(p2.addressText({ chatId: 'group:A' }), /叫他「小明同学」/);

  /** 设了 addresses 之后以新表为准，alias 只是兜底 */
  p2.setAddress('10001', '老王');
  assert.match(p2.addressText({ chatId: 'group:A' }), /叫他「老王」/);
  assert.doesNotMatch(p2.addressText({ chatId: 'group:A' }), /小明同学/);
});

test('称呼：别人怎么叫 ≠ 我该怎么叫（两段分开说）', (t) => {
  const { p } = withPerson(t);
  p.setAddress('10001', '老王');
  p.addNickname('10001', '明明', { scope: 'group:A' });
  const text = p.addressText({ chatId: 'group:A' });
  assert.match(text, /叫他「老王」/, '称呼用我设的');
  assert.match(text, /别人也说「明明」/, '别名只作"别人在说谁"的线索');
  assert.doesNotMatch(text.replace(/别人也说[^\n]*/, ''), /叫他「明明」/, '绝不能拿别名当称呼');
});

test('别名：只增不覆盖、重复不写盘、没档案的人不建空档案', (t) => {
  const { p, file } = withPerson(t);
  assert.equal(p.addNickname('10001', '明明'), true);
  assert.equal(p.addNickname('10001', '明明'), false, '重复返回 false（不写盘）');
  assert.equal(p.addNickname('99999', '路人'), false, '没档案的人跳过');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).length, 1, '不能为一条 @ 建空档案');
  assert.match(p.addressText({ chatId: '' }), /别人也说「明明」/);
});

test('别名：同一个人在不同群各记各的，不串', (t) => {
  const { p } = withPerson(t);
  p.addNickname('10001', '明明', { scope: 'group:A' });
  p.addNickname('10001', '小明明', { scope: 'group:B' });
  assert.match(p.addressText({ chatId: 'group:A' }), /明明/);
  assert.doesNotMatch(p.addressText({ chatId: 'group:A' }), /小明明/);
});

test('不再记住：称呼与别名一起清掉，注入段不再出现他', (t) => {
  const { p, file } = withPerson(t);
  p.setAddress('10001', '老王');
  p.addNickname('10001', '明明');
  assert.notEqual(p.addressText({ chatId: '' }), '');

  p.setNoMemory('10001', true);
  assert.equal(p.addressText({ chatId: '' }), '', '清理后不注入');
  const row = JSON.parse(readFileSync(file, 'utf8'))[0];
  assert.equal(row.addresses, undefined);
  assert.equal(row.nicknames, undefined);

  p.setNoMemory('10001', false);
  assert.equal(p.addressText({ chatId: '' }), '', '撤回不会自动长回来（正文已清）');
});

test('称呼：没有内容时返回空串（老库与未设置时逐字节一致）', (t) => {
  const { p } = withPerson(t);
  assert.equal(p.addressText({ chatId: 'group:A' }), '', '没设称呼就是空串，不占预算');
});

test('称呼：拿不到人类可读名字的人不进注入段（不把 openid 塞给模型）', (t) => {
  const f = fresh(t);
  const p = createProfiles({ file: f.file, now: () => 1000, log: () => {} });
  /** 只有 openid 当名字的情况 */
  p.note({ who: 'CBF1E6B3A2D4E5F6A7B8', openid: 'CBF1E6B3A2D4E5F6A7B8', impression: '聊过两句' });
  p.setAddress('CBF1E6B3A2D4E5F6A7B8', '老王');
  assert.equal(p.addressText({ chatId: '' }), '', '名字太长（像 openid）就跳过');
});
