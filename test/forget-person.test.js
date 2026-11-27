// 按人遗忘的三档编排：断链 / 归档 / 彻底删。
//
// 这几档最容易「看着做了其实反了」：unlink 把正文删了（不可逆）、
// hard 只打标记（没真删）、restore 把别人的遗忘也一起撤销。
// 所以断言全部盯**盘上**与**别人的数据有没有被牵连**。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPersons } from '../src/persons.js';
import { createForgetFilter } from '../src/forget-filter.js';
import { createForgetPerson } from '../src/forget-person.js';
import { createJournal, ERASED } from '../src/journal.js';
import { createMemory } from '../src/memory.js';
import { createGraph } from '../src/graph.js';
import { createProfiles } from '../src/profiles.js';

function rig(t) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-fp-'));
  process.env.DSH_ROOST_DATA = dir;
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  const persons = createPersons({ file: join(dir, 'persons.json'), log: () => {} });
  const filter = createForgetFilter({ persons, log: () => {} });
  const journal = createJournal({ file: join(dir, 'journal.sqlite'), log: () => {} });
  const memory = createMemory({ factFilter: filter, log: () => {} });
  const graph = createGraph({ file: join(dir, 'graph.sqlite'), forgetFilter: filter, log: () => {} });
  const profiles = createProfiles({
    file: join(dir, 'profiles.json'),
    isForgotten: (k) => !filter.remembers(k),
    log: () => {},
  });
  const audits = [];
  const fp = createForgetPerson({
    persons, forgetFilter: filter, profiles, memory, journal, graph,
    file: join(dir, 'forget-archive.json'),
    log: () => {},
    audit: (e) => audits.push(e),
  });

  /** 造一个「小明」：档案 + 3 条事实 + 3 条日记（私聊 2 + 群 1）+ 1 条图谱边 */
  persons.see('10001', { name: '小明' });
  profiles.note({ who: '小明', openid: '10001', impression: '喜欢打游戏' });
  memory.add('private:10001', '小明爱打游戏', 'global', { about: '10001', src: { speaker: '小明' } });
  memory.add('private:10001', '小明在准备考试', 'global', { src: { speaker: '小明' } });
  memory.add('private:10001', '主人喜欢喝咖啡', 'global', {});
  journal.add({ id: 'j1', at: 1700000001000, chatId: 'private:10001', sender: '小明', role: 'user', text: '我最近在准备考试' });
  journal.add({ id: 'j2', at: 1700000002000, chatId: 'private:10001', sender: '小明', role: 'user', text: '昨天打游戏到很晚' });
  journal.add({ id: 'j3', at: 1700000003000, chatId: 'group:G1', sender: '小明', role: 'member', text: '群里也在说考试' });
  journal.add({ id: 'k1', at: 1700000004000, chatId: 'group:G1', sender: '阿猫', role: 'member', text: '猫粮买好了' });
  graph.addEdge({ src: '主人', rel: '朋友', dst: '小明', chatId: 'private:10001' });
  filter.invalidate();
  return { dir, persons, filter, journal, memory, graph, profiles, fp, audits };
}

test('unlink：日记只打标记不删正文，事实一条不少，读路径全看不见', (t) => {
  const { dir, persons, memory, journal, profiles, fp } = rig(t);

  const plan = fp.plan('10001');
  assert.equal(plan.ok, true);
  assert.equal(plan.affects.facts >= 2, true, `事实影响面应该≥2，实际 ${plan.affects.facts}`);

  const r = fp.run('10001', { mode: 'unlink' });
  assert.equal(r.ok, true);
  assert.equal(r.steps.journal, 3, '三行日记都被断链');

  /** 盘上正文一字不动 */
  const raw = JSON.parse(readFileSync(join(dir, 'memory.json'), 'utf8'));
  assert.equal(raw.global.includes('小明爱打游戏'), true, 'unlink 不删事实');
  const rows = journal.listChat('private:10001', 0);
  assert.equal(rows.length, 0, '注入/读路径看不到这个人的日记');
  const invalidated = journal.invalidated({ chatId: 'private:10001', aliases: [] });
  assert.equal(invalidated.length, 2, '行还在，只是失效了');
  assert.match(String(invalidated[0].text), /考试|游戏/, '正文保留，可恢复');

  assert.equal(memory.list('private:10001').global.length, 1, '只剩无关那条');
  assert.equal(persons.remembers('10001'), false);
  assert.equal(profiles.text({ day: '2026-11-28' }), '', '档案段不再注入');
});

test('unlink 撤回：只放回这个人的日记，不牵连别人', (t) => {
  const { fp, persons, journal, memory } = rig(t);
  /** 另一个人也被遗忘过 */
  persons.see('20002', { name: '阿猫' });
  journal.add({ id: 'm1', at: 1700000005000, chatId: 'group:G1', sender: '阿猫', role: 'member', text: '猫的事' });
  fp.run('20002', { mode: 'unlink' });
  fp.run('10001', { mode: 'unlink' });

  const back = fp.restore('10001');
  assert.equal(back.ok, true);
  assert.equal(back.journal, 3, '只恢复小明那三行');
  assert.equal(persons.remembers('10001'), true);
  assert.equal(persons.remembers('20002'), false, '别人的遗忘没被撤销');
  assert.equal(memory.list('private:10001').global.length >= 2, true, '事实自动回到注入');
});

test('archive：断链之外留一份快照（含档案与事实）', (t) => {
  const { dir, fp } = rig(t);
  const r = fp.run('10001', { mode: 'archive' });
  assert.equal(r.steps.archive, 1);
  const raw = JSON.parse(readFileSync(join(dir, 'forget-archive.json'), 'utf8'));
  assert.equal(raw.items.length, 1);
  const item = raw.items[0];
  assert.equal(item.id, '10001');
  assert.equal(item.profile?.impression, '喜欢打游戏');
  assert.equal(item.facts.length >= 2, true, '事实快照在里面');

  const list = fp.archived();
  assert.equal(list.length, 1);
  assert.equal(list[0].facts >= 2, true);
});

test('hard：日记正文抹成占位符、事实真删、不可恢复', (t) => {
  const { dir, fp, memory, journal, persons } = rig(t);
  const r = fp.run('10001', { mode: 'hard' });
  assert.equal(r.ok, true);
  assert.equal(r.steps.journal, 3, '三行被抹');

  const raw = JSON.parse(readFileSync(join(dir, 'memory.json'), 'utf8'));
  assert.equal(raw.global.includes('小明爱打游戏'), false, '事实物理删除');
  assert.equal(raw.global.includes('小明在准备考试'), false, '按名字命中的也删');
  assert.equal(raw.global.includes('主人喜欢喝咖啡'), true, '无关事实不动');

  /** 行还在（时间线），正文是占位符 */
  const all = journal.listChat('private:10001', 0);
  assert.equal(all.length, 0, '抹完还打了失效标记，读不到');
  const stale = journal.invalidated({ chatId: 'private:10001', aliases: [] });
  assert.equal(stale.length >= 2, true);
  assert.equal(stale.some((x) => String(x.text) === ERASED), true, '正文变占位符');

  /** 恢复也回不来 */
  fp.restore('10001');
  assert.equal(journal.listChat('private:10001', 0).length, 0, 'hard 不可逆');
  assert.equal(memory.list('private:10001').global.length, 1, '事实回不来');
  assert.equal(persons.remembers('10001'), true, '标记撤销后也不复活数据');
});

test('hard 必须留审计；unlink 也记一笔', (t) => {
  const { fp, audits } = rig(t);
  fp.run('10001', { mode: 'unlink' });
  assert.equal(audits.at(-1).op, 'person.forget.unlink');
  fp.run('10001', { mode: 'hard' });
  assert.equal(audits.at(-1).op, 'person.forget.hard');
});

test('count 模式只数不改：预览不能有副作用', (t) => {
  const { fp, journal, persons } = rig(t);
  const plan = fp.plan('10001');
  assert.equal(plan.affects.journal, 3);
  assert.equal(journal.listChat('private:10001', 0).length, 2, '日记还在');
  assert.equal(persons.remembers('10001'), true, '预览不标遗忘');
});

test('没有身份记录的人：照样能按名字清（但只按名字），不崩', (t) => {
  const { fp, memory } = rig(t);
  const r = fp.run('小明', { mode: 'unlink' });
  assert.equal(r.ok, true);
  assert.equal(memory.list('private:10001').global.length, 1, '按名字命中');
});
