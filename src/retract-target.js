/**
 * `qq_retract` 的两块纯逻辑：**挑哪条**、**失败怎么说**。
 *
 * 从 `host.js` 的 `retractOf` 里抽出来，理由和 `quote-auto.js` 一样——这两块
 * 都是「错了不会报错、只会看起来怪」的地方：挑错就是撤了不该撤的消息，
 * 失败说错就是模型原地重试、白烧一轮。埋在闭包里只能真机试。
 */

/**
 * 官机撤回时限：**发送超过 2 分钟不可撤回**（官方错误码 `40064004`）。
 *
 * 出处：`bot/docs/官方接口限制.md`「撤回的硬约束」、`bot/src/api.js:1289`。
 * 群聊单聊都成立——`bot/src/endpoints.js` 只在群那一行标了「2 分钟内」，
 * 容易让人以为单聊没限制，实际是同一套服务端判定。
 */
export const RETRACT_LIMIT_MS = 120_000;

/** 一次最多往回翻几条。`lastSent` 环形留 8 条，这里 5 条够用且不至于乱撤 */
export const RETRACT_MAX_INDEX = 5;

/**
 * 从「最近发过的消息」里挑第 `index` 条，并做本地时限预检。
 *
 * @param {Array<{id:string, kind:string, at:number}>} list **最新在前**
 * @param {number|string} [index] 1 = 刚发的；越界夹到 1..5
 * @param {number} [now] 注入时钟，测试用
 * @returns {{ok:true, n:number, rec:object, age:number}
 *          |{ok:false, n:number, message:string}}
 */
export function pickRetractTarget(list, index, now = Date.now()) {
  /**
   * 夹而不是报错：模型给 `0` / `-1` / `2.7` 都是「大概想撤最近那条」，
   * 为这个拒绝它一次等于白烧一轮。夹住之后撤的仍是它自己发的消息，
   * 不存在撤到别人头上。
   */
  const n = Math.min(RETRACT_MAX_INDEX, Math.max(1, Math.trunc(Number(index) || 1)));
  const rec = (Array.isArray(list) ? list : [])[n - 1];
  if (!rec?.id) {
    return {
      ok: false,
      n,
      message: n === 1
        ? '最近那条没拿到消息号（可能是主动消息或试运行），撤不了。'
        : `倒数第 ${n} 条没拿到消息号，撤不了。`,
    };
  }
  const age = now - (Number(rec.at) || 0);
  /**
   * 只拦**明显**超时的。临界区（比如 118 秒）交给服务端判更准——我们记的
   * `at` 是发送**返回**的时刻，比服务端收到的时刻晚一点点，本地多拦一秒
   * 就可能误伤一条本来能撤的。
   */
  if (age > RETRACT_LIMIT_MS) {
    return {
      ok: false,
      n,
      message: `那条已经发出 ${Math.round(age / 1000)} 秒，官方只允许 2 分钟内撤回，撤不回来了。`
        + '要纠正就直接补一句，别重试。',
    };
  }
  return { ok: true, n, rec, age };
}

/**
 * 把官方错误翻译成模型能用的话。
 *
 * 只说「失败了」它会在原地重试——而这两个码都是**重试也没用**的：
 * 超时不会因为再试一次变短，权限不会因为再试一次变够。所以每条都带
 * 「别重试 / 换个办法」，这是这段话存在的全部意义。
 *
 * @param {{qqCode?:number, code?:string, message?:string}} [r] 通道返回的失败结果
 * @returns {string}
 */
export function explainRetractFailure(r = {}) {
  const qq = Number(r?.qqCode) || 0;
  /** 超时：官方 `40064004` */
  if (qq === 40064004) {
    return '超过 2 分钟了，官方不让撤。要纠正就补一句，别重试。';
  }
  /** 没权限：官方 `40062003`（不是自己发的 / 不是群管理员） */
  if (qq === 40062003) {
    return '没有权限撤这条（官方只允许撤自己发的；撤别人的要先设成群管理员）。别重试。';
  }
  return `没撤成：${r?.message || '官方拒绝了'}。别反复重试。`;
}
