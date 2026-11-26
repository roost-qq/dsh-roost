/**
 * 内置标记契约（900 段的兜底正文）。
 *
 * 这份东西是「纯直连部署 / 扩展投递」时模型**唯一**能看到的能力说明，
 * 少一条就等于那个标记不存在。所以按「解析侧真支持什么」逐条钉：
 * 每条断言都对应 `apply-markers.js` / `outbound-actions.js` 里的一个真实现。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MARKER_CONTRACT, PICK_CONTRACT_LINE, pickMarkerContract,
} from '../src/marker-contract.js';

test('契约覆盖解析侧真支持的标记（少一条就是能力不存在）', () => {
  for (const m of [
    '<<skip>>', '<<silence:', '<<remember:', '<<remember-here:', '<<replace:',
    '<<forget:', '<<persona:', '<<clear>>', '<<close:', '<<quote:', '<<retract>>',
    '<<mood:', '<<button:',
  ]) {
    assert.ok(MARKER_CONTRACT.includes(m), `契约缺 ${m}`);
  }
});

test('契约不教已经被停用的写法', () => {
  assert.doesNotMatch(MARKER_CONTRACT, /<<say/, '旧 say 走不通，教了只会两头落空');
  assert.doesNotMatch(MARKER_CONTRACT, /<<file:/, 'file 只摘不执行，发文件必须走 qq_send_file');
});

test('心情：必须说清取值范围和「只有主人说话那轮才算」', () => {
  assert.match(MARKER_CONTRACT, /valence/, '不写键名模型不知道怎么拼');
  assert.match(MARKER_CONTRACT, /-1～1/, '取值范围和 mood.js 的 clamp 一致');
  assert.match(MARKER_CONTRACT, /只有跟主人说话时/, '群里写会被 canWriteFacts 静默摘掉');
});

test('按钮：说清「点下去那句话算对方说的」', () => {
  assert.match(MARKER_CONTRACT, /算他说/, 'type:2 的 data 会当用户消息发出，写反就变成自问自答');
  assert.match(MARKER_CONTRACT, /最多 4 个/, '键盘上限');
});

test('pick：默认不教（没有交互回传就是死按钮），连上框架才追加', () => {
  assert.doesNotMatch(MARKER_CONTRACT, /<<pick/);
  const off = pickMarkerContract(null);
  assert.equal(off.source, 'builtin');
  assert.doesNotMatch(off.text, /<<pick/);

  const on = pickMarkerContract(null, { picks: true });
  assert.match(on.text, /<<pick/);
  /** 插在收尾句**之前**：追加到末尾会落到「这些标记…」后面，读起来像句外补充 */
  assert.ok(on.text.indexOf('<<pick') < on.text.indexOf('这些标记要单独写清楚'));
});

test('调用方给了 system 就用它的，不被内置契约覆盖', () => {
  const r = pickMarkerContract('调用方自己的契约', { picks: true });
  assert.equal(r.source, 'caller');
  assert.equal(r.text, '调用方自己的契约', 'picks 不该往调用方的文本里塞东西');
});

test('pick 行是独立常量，文案和 outbound-actions 的语义一致', () => {
  assert.match(PICK_CONTRACT_LINE, /<<pick:.*\|/);
  assert.match(PICK_CONTRACT_LINE, /点一个/, '同组互斥变灰是平台能力');
});
