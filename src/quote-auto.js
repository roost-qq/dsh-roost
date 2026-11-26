/**
 * 自动引用回复：这一轮要不要挂「回复某某」的引用块。
 *
 * 从 `host.js` 的 `deliverBatch` 闭包里抽出来，只为能单测：概率这种东西
 * 埋在闭包里只能靠真机掷几百次去猜，而它的失败方式（该挂的不挂、不该挂的
 * 每句都挂）肉眼几乎看不出来。
 *
 * 只管「要不要、引用谁」，不碰发送——挂到哪个字段是 `outbound-actions.js`
 * 的事，取哪个索引是调用方的事。
 */

import { isOff } from './features.js';

/** 概率缺省值。改这里要同步 `config.js` 的 `qqTools.quote.percent` */
export const DEFAULT_QUOTE_PERCENT = 40;

/**
 * 引用索引（`REFIDX_…`）的最大长度。**别改回 128。**
 *
 * 官方的 `msg_idx` 是 **135 个字符**（`REFIDX_` + 128 位 base64）。2026-11-26
 * 之前这里按 128 截断，正好砍掉最后 7 位：报文照样发得出去，QQ 静默忽略这个
 * 非法的 `message_reference`，表现就是「概率设 100% 也不引用」——**不报错、
 * 不写日志、投递记录还显示 sent**。主人连问三次才查出来。
 *
 * 512 只是防模型往 `<<quote:>>` 里灌超长串，远大于真实值；真按「看起来像
 * 128 位」去卡，就会把合法索引切坏。
 */
export const MAX_REF_IDX = 512;

/**
 * @param {object} o
 * @param {boolean|string} [o.enabled] 开关；`false` / `"false"` 都算关
 * @param {number|string} [o.percent] 0–100，越界自动夹住
 * @param {string} [o.refIdx] 本条消息的引用索引（`REFIDX_xxx`）
 * @param {() => number} [o.rand] 注入随机源，测试用
 * @returns {string} 要挂的 `REFIDX`；空串 = 这一轮不引用
 */
export function pickQuoteRef({ enabled, percent, refIdx, rand = Math.random } = {}) {
  /**
   * 判据走 `isOff` 而不是 `!== false`：手改 `config.json` 写成字符串
   * `"false"` 也要能关掉（同 `host.js` 的 `masterOff` 那条口径）。
   */
  if (isOff(enabled)) return '';
  /**
   * 非数字（手改 `config.json` 写成 `"abc"`）退回缺省值，而不是「静默关掉」。
   * 静默关掉的表现是「明明开着却从不引用」，比一个明显不对的值更难查。
   */
  const raw = Number(percent ?? DEFAULT_QUOTE_PERCENT);
  const pct = Math.min(100, Math.max(0, Number.isFinite(raw) ? raw : DEFAULT_QUOTE_PERCENT));
  /** `0` = 永不引用 */
  if (!pct) return '';
  const ref = String(refIdx ?? '').trim().slice(0, MAX_REF_IDX);
  /**
   * 没有索引就不挂。频道消息、主动搭话轮、以及部分事件都没有 `msgIdx`——
   * 这时候**不猜、不拿别的 id 凑**：引用错了比不引用糟得多。
   */
  if (!ref) return '';
  return rand() * 100 < pct ? ref : '';
}
