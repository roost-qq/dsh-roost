/**
 * 出站近似去重：同一目标短时间内发两条几乎一样的话，只留第一条。
 *
 * 为什么需要：模型在长回合里经常先发一段「我先看看」，跑完再发一段几乎同样的
 * 「我看了下」。用户侧看到的是同一条消息连发两遍，像卡住了。
 *
 * 为什么放在通道层：主动消息、主回复、`qq_send`、扩展 `/v1/message` 四条出站路
 * **最后都掉进 channel 的 `send()`**——只改其中一条等于没改。
 *
 * ## 三条保守设计（宁可漏拦，不可误拦）
 *
 * 1. **默认关**（`chat.dupSimilarity = 0`）。行为开关默认必须是不改变现状，
 *    否则升级当天所有人的第二句短回复都可能被吞掉。
 * 2. **短文本不拦**：少于 `MIN_LEN` 字一律放行。「在的」「好」连发两次是正常的。
 * 3. **只跟"上一条"比，且有时间窗**：拦的是"同一条被发两遍"，不是"这句话说过"。
 *    十分钟前说过的事再提一次是对话，不是重复。
 *
 * 判据是 bigram Dice（和记忆那套 `similarityOf` 同源思路）：中文短句的
 * 字符二元组足够区分"改了个称呼"和"整句重发"，不需要分词。
 */

/** 短于这个字数一律不判重：应答类短句重复是自然的 */
export const DUP_MIN_LEN = 8;
/** 默认时间窗：只跟十分钟内的上一条比 */
export const DUP_WINDOW_MS = 10 * 60 * 1000;
/** 默认阈值（0 = 关）。0.9 相当严：几乎要一字不差才算重复 */
export const DUP_DEFAULT_SIMILARITY = 0.9;

function bigrams(s) {
  const t = String(s ?? '').replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
  if (!out.size && t) out.add(t);
  return out;
}

/** bigram Dice；和记忆侧 `similarityOf` 同口径，便于两边判据一致 */
export function diceOf(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit += 1;
  return hit / (A.size + B.size - hit);
}

/**
 * @param {object} o
 * @param {() => number} [o.similarityOf] 阈值（热读，0 = 关）
 * @param {number} [o.windowMs]
 * @param {() => number} [o.now]
 * @param {number} [o.minLen]
 */
export function createOutboundDedupe({
  similarityOf = () => 0,
  windowMs = DUP_WINDOW_MS,
  now = () => Date.now(),
  minLen = DUP_MIN_LEN,
} = {}) {
  /** target → { text, at }：只留每个目标的上一条，不做历史 */
  const last = new Map();

  /**
   * 判这一条要不要发。
   * 返回 `{ skip, score }`；不 skip 时**顺手把这条记成新的上一条**——
   * 调用方只调这一个方法，不用记得再 note 一次（少一个漏调的机会）。
   */
  function check(target, text, { hasCard = false } = {}) {
    const key = String(target || '');
    const t = String(text ?? '').trim();
    /** 卡片不参与：它自带标题/描述，正文常常是空的，判重没有意义 */
    if (!key || !t || hasCard) return { skip: false, score: 0 };

    const threshold = Number(similarityOf()) || 0;
    const prev = last.get(key);
    const at = now();
    /** 先记上一条（无论拦不拦），这样"连发三遍"能一直拦住第二、三条 */
    last.set(key, { text: t, at });

    if (threshold <= 0) return { skip: false, score: 0 };
    if (!prev || t.length < minLen || prev.text.length < minLen) return { skip: false, score: 0 };
    if (at - prev.at > windowMs) return { skip: false, score: 0 };
    const score = diceOf(prev.text, t);
    return { skip: score >= threshold, score };
  }

  /** 换目标/换账号后清账，避免旧目标的上一条误伤新目标 */
  function reset() {
    last.clear();
  }

  return { check, reset, _size: () => last.size };
}
