// 出站近似去重（`chat.dupSimilarity`）：挡「同一段被发两遍」，不是「这句话说过」。
//
// 三条保守线，任何一条放松都会把正常对话吃掉：
//   · 默认关（0）——升级当天不许改变任何人的现有行为；
//   · 短于 8 字不判重——「在的」「好」连发两次是自然的；
//   · 只跟上一条比 + 十分钟窗——十分钟前说过的事再提是对话。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createOutboundDedupe, diceOf, DUP_MIN_LEN } from '../src/outbound-dup.js';

test('默认关：阈值 0 时永远不拦', () => {
  const d = createOutboundDedupe({ similarityOf: () => 0, now: () => 1000 });
  const a = '我刚才看了下，这个方案有两个问题';
  assert.equal(d.check('u1', a).skip, false);
  assert.equal(d.check('u1', a).skip, false, '一字不差也不拦');
});

test('开启后：几乎一样的两条只留第一条', () => {
  let t = 1000;
  const d = createOutboundDedupe({ similarityOf: () => 0.9, now: () => t });
  const first = '我刚才看了下，这个方案有两个问题，主要是成本和排期。';
  const second = '我刚才看了下，这个方案有两个问题，主要是成本和排期';
  assert.equal(d.check('u1', first).skip, false);
  t += 5000;
  const r = d.check('u1', second);
  assert.equal(r.skip, true);
  assert.ok(r.score >= 0.9, `score=${r.score}`);
});

test('开启后：换了内容就不拦（同一实体、不同意思）', () => {
  let t = 1000;
  const d = createOutboundDedupe({ similarityOf: () => 0.9, now: () => t });
  d.check('u1', '这个方案的成本有点高，排期也紧');
  t += 5000;
  assert.equal(d.check('u1', '另外我建议先把风险列出来再定').skip, false);
});

test('短应答不判重：「在的」连发两次是自然的', () => {
  let t = 1000;
  const d = createOutboundDedupe({ similarityOf: () => 0.9, now: () => t });
  d.check('u1', '在的');
  t += 1000;
  assert.equal(d.check('u1', '在的').skip, false, `短于 ${DUP_MIN_LEN} 字放行`);
});

test('时间窗：十分钟内拦，超窗放行', () => {
  let t = 1000;
  const d = createOutboundDedupe({ similarityOf: () => 0.9, now: () => t, windowMs: 60_000 });
  const line = '这个方案的成本有点高，排期也紧';
  d.check('u1', line);
  t += 30_000;
  assert.equal(d.check('u1', line).skip, true);
  t += 120_000;
  assert.equal(d.check('u1', line).skip, false, '过了窗就当新话');
});

test('按目标分开记：A 群说过不影响 B 群', () => {
  let t = 1000;
  const d = createOutboundDedupe({ similarityOf: () => 0.9, now: () => t });
  const line = '这个方案的成本有点高，排期也紧';
  d.check('group:A', line);
  t += 1000;
  assert.equal(d.check('group:B', line).skip, false);
});

test('带卡片的消息不参与判重（正文常为空，判了没意义）', () => {
  let t = 1000;
  const d = createOutboundDedupe({ similarityOf: () => 0.9, now: () => t });
  const line = '这是你要的图，看看效果对不对';
  d.check('u1', line);
  t += 1000;
  assert.equal(d.check('u1', line, { hasCard: true }).skip, false);
});

test('连发三遍：第二、三条都拦住（记录的是最新一条）', () => {
  let t = 1000;
  const d = createOutboundDedupe({ similarityOf: () => 0.9, now: () => t });
  const line = '这个方案的成本有点高，排期也紧';
  assert.equal(d.check('u1', line).skip, false);
  t += 100; assert.equal(d.check('u1', line).skip, true);
  t += 100; assert.equal(d.check('u1', line).skip, true);
});

test('diceOf：完全一致 1、完全无关 0', () => {
  assert.equal(diceOf('这个方案的成本有点高', '这个方案的成本有点高'), 1);
  assert.equal(diceOf('abc', 'xyz'), 0);
});

test('接线守门：通道层在发送前调用，且宿主把配置热读传进来', () => {
  const ch = readFileSync(new URL('../src/channel.js', import.meta.url), 'utf8');
  assert.match(ch, /const dup = dedupe\.check\(String\(target\), t, \{ hasCard \}\)/, '要去重必须落在通道层');
  assert.match(ch, /skipped: 'duplicate'/, '要能跟"发出去了"区分开');
  const host = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');
  assert.match(host, /dupSimilarityOf: \(\) => Number\(cfg\.chat\?\.dupSimilarity\) \|\| 0/, '配置要热读');
  const cfg = readFileSync(new URL('../src/config.js', import.meta.url), 'utf8');
  assert.match(cfg, /dupSimilarity: 0/, '默认必须是关');
});

test('面板开关：注册成 select 三档，默认「关」，值走 chat.dupSimilarity', () => {
  const feat = readFileSync(new URL('../src/features.js', import.meta.url), 'utf8')
  const i = feat.indexOf("id: 'chatDupSimilarity'")
  assert.ok(i > 0, '要在功能注册表里，否则面板看不到')
  const block = feat.slice(i, i + 900)
  assert.match(block, /path: \['chat', 'dupSimilarity'\]/, '写的必须是去重那个配置')
  assert.match(block, /kind: 'select'/, '三档用 select，不让人手填 0~1 的小数')
  assert.match(block, /default: 0,/, '默认关（数字，和 DEFAULTS 同型）')
  assert.match(block, /value: 0\.95/, '至少要有严格档')
  /** 字符串值也要能被宿主读成数字（select 写的是 '0.95'） */
  assert.equal(Number('0.95') || 0, 0.95);
  assert.equal(Number('0') || 0, 0, 'select 回写字符串时也要读成 0');
})
