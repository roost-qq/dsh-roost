/**
 * 会话被 DSH 归档（blocked）之后的上下文恢复：源码级接线测试。
 *
 * 为什么源码级：这段逻辑在 `handleTurn` 的 catch 里，真触发要走完整的
 * DSH 会话事件流（turn/end 报 requires_action），测试环境里搭不起真 agent。
 * 项目里已有同款做法（compact.test.js 的「开场重建必须过 compactCfgOf」）。
 *
 * 钉住四件事，缺一件归档后的新会话就会「接不上」：
 *   1. 解绑 sessionId —— 已有行为，别在改动里丢掉；
 *   2. 用 `rebuildOpening` 重建开场、交给 `pendingOpening` —— 不是另起一套规则；
 *   3. `rounds.delete` —— 让下一条算会话边界，自述/承诺才注入；
 *   4. 话术中性 —— blocked 不等于归档，说死「被归档了」会误导。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const host = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');

/** 从 `if (e?.kind === 'blocked')` 起截到这段 catch 结束，只在这段里断言 */
function blockedBranch() {
  const at = host.indexOf("if (e?.kind === 'blocked') {");
  assert.ok(at > 0, '没找到 blocked 分支，变量名/写法可能改了');
  /** `if (e?.kind === 'busy')` 是这段 catch 的下一个明确分支 */
  const end = host.indexOf("if (e?.kind === 'busy')", at + 1);
  assert.ok(end > at, '没找到 busy 分支，catch 结构变了');
  return host.slice(at, end);
}

test('归档恢复：blocked 分支解绑 + 重建开场 + 清 rounds 都在', () => {
  const b = blockedBranch();
  assert.match(b, /sessions\.set\(chat\.sessionKey,\s*''/, '解绑 sessionId 不能丢');
  assert.match(b, /rebuildOpening\(chat\.chatId\)/, '开场必须走同一个重建器，规则与压缩一致');
  assert.match(b, /pendingOpening\.set\(chat\.chatId/, '开场要交给 pendingOpening，下一条才会拼');
  assert.match(b, /rounds\.delete\(chat\.chatId\)/, '不清 rounds 的话自述不注入');
});

test('归档恢复：重建失败被吞掉，不能炸掉解绑路径', () => {
  const b = blockedBranch();
  assert.match(b, /try\s*\{[\s\S]*?rebuildOpening[\s\S]*?\}\s*catch/, '重建要包 try/catch');
});

test('归档恢复：blocked 话术中性，不说死「被归档了」', () => {
  assert.match(host, /我换个地方接着聊/, '中性话术要在');
  assert.ok(!host.includes('再说一遍就行'), '旧话术必须去掉（blocked 不一定是归档）');
});
