// 遗忘闸门：把「不再记住这个人」翻译成各处读路径都能用的判断。
//
// 这一层最容易「看着做了其实没生效」：只挡浅注入、deep 派生块还在；
// 只挡档案、facts 里照样搜得到；只挡 facts、图谱关系还在 prompt 里。
// 所以这里的断言全部盯**副作用**：盘上有没有、读出来有没有、渲染有没有。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPersons } from '../src/persons.js';
import { createForgetFilter } from '../src/forget-filter.js';
import { createMemory } from '../src/memory.js';
import { createGraph } from '../src/graph.js';
import { createProfiles } from '../src/profiles.js';
import { createSelf } from '../src/self.js';

function freshDir(t, name = 'roost-forget-') {
  const dir = mkdtempSync(join(tmpdir(), name));
  process.env.DSH_ROOST_DATA = dir;
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

test('闸门：没人被遗忘时一个字都不拦（默认行为零变化）', (t) => {
  const dir = freshDir(t);
  const persons = createPersons({ file: join(dir, 'persons.json'), log: () => {} });
  const f = createForgetFilter({ persons });
  assert.equal(f.active, false);
  assert.equal(f.keep({ text: '小明爱打游戏', about: '10001' }), true);
  assert.equal(f.mentions('小明在准备考试'), false);
  assert.equal(f.remembers('10001'), true);
});

test('闸门：about 命中即拦，未确认的名字也能拦（老数据靠这个）', (t) => {
  const dir = freshDir(t);
  const persons = createPersons({ file: join(dir, 'persons.json'), log: () => {} });
  persons.see('10001', { name: '小明' });
  persons.setNoMemory('10001', true);
  const f = createForgetFilter({ persons });

  assert.equal(f.keep({ text: '小明爱打游戏', about: '10001' }), false, 'about 精确命中');
  assert.equal(f.keep({ text: '小明爱打游戏', about: '' }), false, '老数据无 about，按名字命中');
  assert.equal(f.keep({ text: '主人喜欢喝咖啡', about: '' }), true, '无关事实不受影响');
  assert.equal(f.keep({ text: '小明爱打游戏', about: '20002' }), false, '名字仍然命中，不能只看 about');
});

test('闸门：单字名不参与匹配（宁漏不误）', (t) => {
  const dir = freshDir(t);
  const persons = createPersons({ file: join(dir, 'persons.json'), log: () => {} });
  persons.see('10001', { name: '明' });
  persons.setNoMemory('10001', true);
  const f = createForgetFilter({ persons });
  assert.equal(f.keep({ text: '明天要开会', about: '' }), true, '「明」单字会误伤一片，必须不参与');
});

test('闸门：撤回后名单立刻失效（invalidate 之后又能看到）', (t) => {
  const dir = freshDir(t);
  const persons = createPersons({ file: join(dir, 'persons.json'), log: () => {} });
  persons.see('10001', { name: '小明' });
  persons.setNoMemory('10001', true);
  const f = createForgetFilter({ persons });
  assert.equal(f.keep({ text: '小明爱打游戏' }), false);

  persons.setNoMemory('10001', false);
  assert.equal(f.keep({ text: '小明爱打游戏' }), false, '缓存还没失效，仍是旧的');
  f.invalidate();
  assert.equal(f.keep({ text: '小明爱打游戏' }), true, '失效后立刻恢复');
});

test('记忆：读路径全挡住，写路径不再写进来', (t) => {
  freshDir(t);
  const persons = createPersons({ file: join(process.env.DSH_ROOST_DATA, 'persons.json'), log: () => {} });
  const f = createForgetFilter({ persons });
  const m = createMemory({ factFilter: f, log: () => {} });

  m.add('private:u1', '小明在准备考试', 'global', { about: '10001', src: { speaker: '小明' } });
  m.add('private:u1', '主人喜欢喝咖啡', 'global', {});
  /** 老数据：没有 about，只有显示名 */
  m.add('private:u1', '小明这周加班', 'global', { src: { speaker: '小明' } });

  assert.equal(m.list('private:u1').global.length, 3, '还没遗忘时三条都在');
  assert.equal(m.listFull('private:u1', []).global.length, 3);

  persons.see('10001', { name: '小明' });
  persons.setNoMemory('10001', true);
  f.invalidate();

  const shallow = m.list('private:u1').global;
  assert.deepEqual(shallow, ['主人喜欢喝咖啡'], '浅读只留无关那条');
  assert.equal(m.listRanked('private:u1', []).global.length, 1, '注入路径也挡住');
  assert.deepEqual(m.listFull('private:u1', []).global.map((r) => r.text), ['主人喜欢喝咖啡'], 'deep 派生块同样挡住');

  /** 写：关于这个人的事不再落盘 */
  m.add('private:u1', '小明换了工作', 'global', { about: '10001' });
  const raw = JSON.parse(readFileSync(join(process.env.DSH_ROOST_DATA, 'memory.json'), 'utf8'));
  assert.equal(raw.global.includes('小明换了工作'), false, '写入闸门生效');
  assert.equal(raw.global.includes('小明在准备考试'), true, '旧数据仍在盘上（断链不擦除）');
});

test('记忆：没接闸门时行为与升级前一致（现状不变）', (t) => {
  freshDir(t);
  const m = createMemory({ log: () => {} });
  m.add('private:u1', '小明在准备考试', 'global', { about: '10001' });
  assert.equal(m.list('private:u1').global.length, 1);
});

test('图谱：已遗忘的实体不注入、也不再新建关系', (t) => {
  const dir = freshDir(t, 'roost-forget-g-');
  const persons = createPersons({ file: join(dir, 'persons.json'), log: () => {} });
  persons.see('10001', { name: '小明' });
  const f = createForgetFilter({ persons });
  const g = createGraph({ file: join(dir, 'graph.sqlite'), forgetFilter: f, log: () => {} });

  g.addEdge({ src: '主人', rel: '朋友', dst: '小明', chatId: 'private:u1' });
  g.addEdge({ src: '主人', rel: '养', dst: '猫', chatId: 'private:u1' });
  const before = g.text({ chatId: 'private:u1' });
  assert.match(before, /小明/, '遗忘前能看到这条关系');

  persons.setNoMemory('10001', true);
  f.invalidate();
  const after = g.text({ chatId: 'private:u1' });
  assert.equal(after.includes('小明'), false, '遗忘后关系不再注入');
  assert.match(after, /猫/, '别人的关系不受影响');

  const added = g.addEdge({ src: '小明', rel: '同事', dst: '小李', chatId: 'private:u1' });
  assert.equal(added, 0, '已遗忘的实体不再新建边');
});

test('自我叙述：提到已遗忘的人那一条不注入，别人那几条照旧', (t) => {
  const dir = freshDir(t);
  const persons = createPersons({ file: join(dir, 'persons.json'), log: () => {} });
  const f = createForgetFilter({ persons });
  /** 自述是自由文本，这里用真实的 self 模块（按 DSH_ROOST_DATA 落盘） */
  const s = createSelf({ log: () => {}, hideText: (x) => f.mentions(x) });
  s.add({ text: '今天和小明聊了很久，他最近在准备考试', day: '2026-11-25' });
  s.add({ text: '今天天气很好，心情不错', day: '2026-11-26' });
  assert.match(s.text(3), /小明/, '遗忘前照常注入');

  persons.see('10001', { name: '小明' });
  persons.setNoMemory('10001', true);
  f.invalidate();
  const txt = s.text(3);
  assert.equal(txt.includes('小明'), false, '提到他的那条不注入');
  assert.match(txt, /天气很好/, '无关的自述不受影响');
  assert.match(s.all().notes.map((n) => n.text).join('|'), /小明/, '原文不动（断链不擦除）');
});

test('档案：note 不再写回已遗忘的人，render 也不再注入', (t) => {
  const dir = freshDir(t);
  const persons = createPersons({ file: join(dir, 'persons.json'), log: () => {} });
  const f = createForgetFilter({ persons });
  const p = createProfiles({
    file: join(dir, 'profiles.json'),
    isForgotten: (key) => !f.remembers(key),
    log: () => {},
  });
  p.note({ who: '小明', openid: '10001', impression: '喜欢打游戏' });
  assert.match(p.text({ day: '2026-11-27' }), /小明/);

  persons.setNoMemory('10001', true);
  f.invalidate();
  /** 换一天让渲染缓存失效，验证的是过滤器而不是缓存 */
  assert.equal(p.text({ day: '2026-11-28' }), '', '已遗忘的人不进档案段');

  p.note({ who: '小明', openid: '10001', impression: '又记了一笔' });
  assert.equal(p.recent().find((r) => r.key === '10001').impression, '喜欢打游戏', '不再写回');
});
