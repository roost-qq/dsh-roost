import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createExtRules,
  MAX_RULE_CHARS,
  MAX_RULES,
  MAX_TOTAL_CHARS,
  RULE_KINDS,
} from '../src/ext-rules.js';

/**
 * 这一层决定「扩展能不能给她立规矩」。要证明四件事：
 *   1. 整份替换（不是增量），空数组能清干净；
 *   2. `kind` 真的按场景过滤，`all` 任何场景都在；
 *   3. 预算是硬拦，且半份不会被偷偷写进去；
 *   4. 停用的扩展不再立规矩，重新启用立刻回来。
 */

const mk = () => createExtRules({ log: () => {} });

test('整份替换：第二次提交覆盖第一次，不是追加', () => {
  const s = mk();
  assert.equal(s.set('ext-a', ['旧规则']).ok, true);
  assert.equal(s.set('ext-a', ['新规则']).ok, true);
  const out = s.render('private');
  assert.match(out, /新规则/);
  assert.doesNotMatch(out, /旧规则/);
  assert.equal(s.list('ext-a').length, 1);
});

test('空数组清空；纯空串也算没内容', () => {
  const s = mk();
  s.set('ext-a', ['要删的']);
  assert.match(s.render('group'), /要删的/);

  assert.equal(s.set('ext-a', []).ok, true);
  assert.equal(s.render('group'), '');
  assert.deepEqual(s.list('ext-a'), []);

  /** 全是空串 / 空白：等于清空，不该留一个空 bullet */
  s.set('ext-a', ['  ', '']);
  assert.equal(s.render('group'), '');
});

test('kind 按场景过滤：all 都在，private / group 各归各的', () => {
  const s = mk();
  s.set('ext-a', [
    '所有场合都听',
    { text: '只在私聊', kind: 'private' },
    { text: '只在群聊', kind: 'group' },
  ]);

  const priv = s.render('private');
  assert.match(priv, /所有场合都听/);
  assert.match(priv, /只在私聊/);
  assert.doesNotMatch(priv, /只在群聊/);

  const grp = s.render('group');
  assert.match(grp, /所有场合都听/);
  assert.match(grp, /只在群聊/);
  assert.doesNotMatch(grp, /只在私聊/);
});

test('不传 kind 等于 all（字符串形式最省事）', () => {
  const s = mk();
  s.set('ext-a', ['一句话规则']);
  assert.equal(s.list('ext-a')[0].kind, 'all');
  assert.match(s.render('private'), /一句话规则/);
  assert.match(s.render('group'), /一句话规则/);
});

test('不认识的 kind 整份拒绝，不当成 all 静默放行', () => {
  const s = mk();
  const r = s.set('ext-a', [{ text: 'x', kind: 'space' }]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /kind/);
  assert.ok(r.reason.includes(RULE_KINDS.join(' / ')), '要把可选值列给调用方，否则它只能猜');
  assert.equal(s.render('private'), '', '拒绝之后一条都不该进去');
});

test('预算三道都会拦：单条 / 条数 / 合计', () => {
  const s = mk();
  const r1 = s.set('ext-a', ['a'.repeat(MAX_RULE_CHARS + 1)]);
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /单条/);

  const many = Array.from({ length: MAX_RULES + 1 }, (_, i) => `规则${i}`);
  const r2 = s.set('ext-a', many);
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /最多/);

  /** 合计：一个扩展自己就能填满，填满之后别人一条都进不来 */
  const chunk = 'b'.repeat(MAX_RULE_CHARS);
  const full = Array.from({ length: MAX_RULES }, () => chunk);   // 6000 字 > 3000 上限
  const r3 = s.set('ext-old', full);
  assert.equal(r3.ok, false, '单扩展也不能越过合计上限');
  assert.match(r3.reason, /合计/);

  /** 正好顶到上限要放行（边界不能差一） */
  const exact = Array.from({ length: Math.floor(MAX_TOTAL_CHARS / MAX_RULE_CHARS) }, () => chunk);
  assert.equal(s.set('ext-old', exact).ok, true, '正好到上限应该能进');
  assert.equal(s.size, exact.length * MAX_RULE_CHARS);

  assert.equal(s.set('ext-new', ['还想加一条']).ok, false, '满额之后别人进不来');
});

test('校验不过时**一条都不写**（半份生效比整份拒绝更难排查）', () => {
  const s = mk();
  s.set('ext-a', ['原有的']);
  const r = s.set('ext-a', ['新的合法一条', { text: 'x', kind: 'nope' }]);
  assert.equal(r.ok, false);
  assert.match(s.render('private'), /原有的/, '旧状态必须原样保留');
  assert.doesNotMatch(s.render('private'), /新的合法一条/);
});

test('扩展之间按 extId 排序拼装，互不覆盖', () => {
  const s = mk();
  s.set('ext-b', ['B 的规则']);
  s.set('ext-a', ['A 的规则']);
  const out = s.render('group');
  assert.ok(out.indexOf('A 的规则') < out.indexOf('B 的规则'), '顺序要稳定，便于排查');
  assert.ok(out.startsWith('【扩展规则】'), '要有标题，认出这批话从哪来');
});

test('停用的扩展不再立规矩；重新启用立刻回来；内容不丢', () => {
  let alive = true;
  const s = createExtRules({ log: () => {}, isEnabled: () => alive });
  s.set('ext-a', ['A 立的规矩']);
  assert.match(s.render('private'), /A 立的规矩/);

  alive = false;
  assert.equal(s.render('private'), '', '停用后不能再影响她');
  assert.equal(s.size, 0, '停用的不占预算');
  assert.equal(s.list('ext-a').length, 1, '停用不等于删规则');

  alive = true;
  assert.match(s.render('private'), /A 立的规矩/);
});

test('没有 extId 一律拒绝（来源不能自报）', () => {
  const s = mk();
  assert.equal(s.set('', ['x']).ok, false);
  assert.equal(s.set(null, ['x']).ok, false);
});

test('rules 不是数组就拒绝，别把字符串拆成字符', () => {
  const s = mk();
  const r = s.set('ext-a', '一句话');
  assert.equal(r.ok, false);
  assert.match(r.reason, /数组/);
});

test('已经带「-」的条目不再叠一个（双横线会被当成上一条的子项）', () => {
  const s = mk();
  s.set('ext-a', ['- 自带横线的一句', '没带横线的一句']);
  const out = s.render('private');
  assert.match(out, /\n- 自带横线的一句/);
  assert.doesNotMatch(out, /- - /);
  assert.match(out, /\n- 没带横线的一句/);
});

test('换行被压成空格：不然第二行会像另起一段的独立指令', () => {
  const s = mk();
  s.set('ext-a', [
    '第一句\n第二句',
    { text: '  多  空格\n\n第三行  ', kind: 'all' },
    '带\r\n回车',
  ]);

  const out = s.render('private');
  /** 每条规则必须是**一行** bullet：正文里不该再有换行 */
  const bullets = out.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(bullets.length, 3, '三条规则应该正好三行');
  assert.match(out, /- 第一句 第二句/);
  assert.match(out, /- 多 空格 第三行/);
  assert.match(out, /- 带 回车/);
  /** 存进去的就是会被注入的，`list()` 不能给回原文 */
  assert.equal(s.list('ext-a')[0].text, '第一句 第二句');
});

test('长度按压平后的算：400 字符里 200 个换行不算字数，真写长了才拦', () => {
  const s = mk();
  /** 200 字 + 200 个换行 = 400 字符；压平（换行变一个空格再 trim）后 200 字，应该收 */
  const padded = `${'一'.repeat(200)}${'\n'.repeat(200)}`;
  assert.equal(padded.length, 400);
  assert.equal(s.set('ext-a', [padded]).ok, true, '换行不是内容，不该占额度');
  assert.equal(s.list('ext-a')[0].text.length, 200, '尾部的空白被 trim 掉，只剩 200 个字');

  const tooLong = '一'.repeat(MAX_RULE_CHARS + 1);
  const r = s.set('ext-a', [tooLong]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /单条最多/);
});
