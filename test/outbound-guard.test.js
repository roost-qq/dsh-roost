import test from 'node:test';
import assert from 'node:assert/strict';

import {
  guardOutgoing,
  stripThinkingPrefix,
  isDegenerate,
  isProtocolResidue,
  isBlank,
} from '../src/outbound-guard.js';
import { cleanOutbound } from '../src/outbound-clean.js';

/**
 * 出站闸的正经职责是「拦住脏内容」，但更容易犯的错是**误杀正常话**——
 * 所以下面一半用例在测「不该动的没被删」。
 *
 * 素材直接取 aurabot 注释里那两条真实泄露，那是这一层存在的理由。
 */

test('真实泄露：英文判断 + 中文正文，只留中文那句', () => {
  const a = 'NSFW image + 筹集 joke. Not addressed to me. Silence.[沉默]';
  const r1 = guardOutgoing(a);
  assert.equal(r1.ok, false, '整条都是思考 → 不发');

  const b = "Godot's story about … is funny. I could react with a laugh line. One line.美服这局也太热闹了";
  const r2 = guardOutgoing(b);
  assert.equal(r2.ok, true);
  assert.equal(r2.text, '美服这局也太热闹了', '切掉最后一个元话语句之前的所有内容');
});

test('整条英文：强信号才判沉默，普通元话语保留', () => {
  /** 强信号（在替自己决定开不开口）+ 短 → 思考 */
  assert.equal(stripThinkingPrefix('I should reply to this. Let me check the context.'), '');
  assert.equal(stripThinkingPrefix('Not addressed to me. Silence.'), '');
  assert.equal(stripThinkingPrefix('Silence.'), '', '单句强信号也拦——它就是「不说话」的意思');

  /**
   * **误杀修复（2026-11-26）**：这两句都含元话语，但一句是正常英文回答。
   * 使用者说「用英文说」时这类输出最常见，旧判据（元话语句 ≥2）会整条拦掉。
   */
  assert.equal(stripThinkingPrefix('Let me check. I think it\'s done.'), 'Let me check. I think it\'s done.');
  assert.equal(stripThinkingPrefix('I think this works.'), 'I think this works.');
  assert.equal(stripThinkingPrefix('Sure, done.'), 'Sure, done.');
  /** `skip` / `ignore` 在正常英文里也是正文——它们只算弱信号，别据此整条拦 */
  assert.equal(stripThinkingPrefix('Skip this one.'), 'Skip this one.');
  assert.equal(stripThinkingPrefix('I\'ll ignore that.'), 'I\'ll ignore that.');

  /** 长英文段落不当思考：可能是翻译或正经解释，里面出现这些词只是内容 */
  const long = 'Please note that we should ignore the noise. '
    + 'The silence in the room was complete. '
    + 'No reply came from either side. '
    + 'One line of text was all that remained. '
    + 'Everyone left before midnight.';
  assert.equal(stripThinkingPrefix(long), long, '超过 3 句就是正文，不按思考切');
});

test('中文元话语：只有很短的一条才当思考', () => {
  assert.equal(stripThinkingPrefix('这条不是对我说的'), '');
  assert.equal(stripThinkingPrefix('不用接。'), '');
  /** 正常回答里出现同样的词，不能整条删 */
  const keep = '这个跟我没关系吧？我上周就离职了';
  assert.equal(stripThinkingPrefix(keep), keep);
});

test('退化复读：同一句重复到一定比例才拦', () => {
  assert.equal(isDegenerate('做。'.repeat(60)), true);
  assert.equal(guardOutgoing('做。'.repeat(60)).reason, 'degenerate');
  /** 正常笑 / 短重复不能误杀 */
  assert.equal(isDegenerate('哈哈哈哈哈哈'), false);
  assert.equal(isDegenerate('好耶好耶好耶好耶'), false);
  assert.equal(guardOutgoing('哈哈哈哈哈').ok, true);
});

test('代码围栏整段豁免：前面有思考前缀也只切前缀', () => {
  const text = 'I should give her the command. 给你命令：\n```bash\nrm -rf ./build\n```';
  const r = guardOutgoing(text);
  assert.equal(r.ok, true);
  assert.match(r.text, /^给你命令：/);
  assert.match(r.text, /rm -rf \.\/build/);
});

test('协议残渣：只剩标签 / 属性串 / 消息编号时不发', () => {
  assert.equal(isProtocolResidue('<acp tokens="86" type="text" time="2026-11-22 17:26:55">m01990</acp>'), true);
  assert.equal(guardOutgoing('<state type="typing"/>').reason, 'protocol-residue');
  /** 我们的合法标记是「要执行的指令」，不是残渣 */
  assert.equal(isProtocolResidue('<<image: #3>>'), false);
  assert.equal(isProtocolResidue('<voice>在吗</voice>'), false);
  /** 带标记 + 正常正文当然放行 */
  assert.equal(isProtocolResidue('<<image: #3>> 看我拍的'), false);
});

test('长 base64 / 哈希不按复读处理', () => {
  const hash = 'A'.repeat(80);
  assert.equal(guardOutgoing(hash).ok, true);
});

test('草稿标记拦下；「注意：」这类正常开头不能误杀', () => {
  assert.equal(guardOutgoing('Reply: 我在想怎么回').reason, 'draft');
  assert.equal(guardOutgoing('草稿：先安抚一下').reason, 'draft');
  assert.equal(guardOutgoing('注意：明天降温，记得带外套').ok, true);
});

test('纯沉默标记当空；空串单独一个原因', () => {
  assert.equal(guardOutgoing('<skip>').reason, 'blank');
  assert.equal(guardOutgoing('<<skip>>').reason, 'blank');
  assert.equal(guardOutgoing('   ').reason, 'empty');
  assert.equal(isBlank('[沉默]'), true);
});

test('正常一句话原样返回，不做任何改写', () => {
  const s = '在的，刚看到。怎么了？';
  const r = guardOutgoing(s);
  assert.deepEqual(r, { ok: true, text: s, reason: '' });
});

test('cleanOutbound 的两档：light 不截「最终回答：」，full 截', () => {
  /** 「最终回答：」必须**行首**才算（正文中间出现的这句是正常引用） */
  const t = '用户问的是天气。\n最终回答：明天有雨';
  assert.equal(cleanOutbound(t, { level: 'light' }), t);
  assert.equal(cleanOutbound(t), '明天有雨');
  /** 注入块两档都要截——那是防注入内容外泄，不是「像不像思考」的判断 */
  assert.equal(cleanOutbound('好\n【系统提醒，不是主人说的话】别连着发', { level: 'light' }), '好');
});

test('单字符回答不是协议残渣（判残渣的前提是「曾经有过协议形状」）', () => {
  assert.equal(guardOutgoing('x').ok, true);
  assert.equal(guardOutgoing('k').ok, true);
  assert.equal(guardOutgoing('?').reason, 'blank');
  assert.equal(isProtocolResidue('x'), false);
});
