/**
 * 内置标记契约（order 900 的兜底正文）。
 *
 * ## 为什么需要这份东西
 *
 * 标记（`<<remember:>>` / `<<skip>>` …）的语法一直由**调用方**通过
 * `payload.system` 传进来（ai-chat 插件转发的那份）。纯 dsh-roost 部署
 * （直连框架、或扩展自己 `/v1/message` 投消息）时 `payload.system` 是空的，
 * 模型**完全不知道有标记可用**——于是「记住了」只写在话里、不落盘，
 * 不想回话时硬憋出一句，图库/语音那几段教了写法却和 `<<…>>` 家族对不上。
 *
 * 所以宿主自己存一份最小契约：调用方给了 system 就用它的（那份更全、且
 * 和它的解析侧配套），没给才注入这份。
 *
 * ## 只写「别处没写」的
 *
 * 图库（901）、卡片 / 语音（900 后面紧跟的两段）、发言方式（907）都已有
 * 专门段落。这里再写一遍只会让模型在两份措辞之间犹豫——实测过：同一段
 * system 里「写完整路径」和「只写序号」并存时，选哪个全看运气。
 */

/**
 * 正文各行。结尾那句**单独留**：`<<pick:>>` 要插在它前面——
 * 追加到 `MARKER_CONTRACT` 末尾会让那一行落到「这些标记要单独写清楚」之后，
 * 读起来像句外补充，模型容易漏。
 */
const CONTRACT_BODY = [
  '【回复里的标记】下面这些写在回复里的标记，宿主会执行并从消息里摘掉，对方看不到；不要向对方解释它们。',
  '',
  '· 不想接这句、或者没什么可说的：只写 `<<skip>>`，别写别的。这是正常结局，不是失败。',
  '· 想让这个群安静一阵：`<<silence: 2h>>`（时长写 `30m` / `2h` / `1d`）。',
  '· 要记住一件以后都用得上的事：`<<remember: 内容>>`（所有会话都记得）；'
    + '只想在这个群记得：`<<remember-here: 内容>>`。',
  '· 要纠正之前记错的说法：`<<replace: 旧说法 | 新说法>>`。',
  '· 要忘掉某件事：`<<forget: 内容>>`。',
  '· 想在这个群里换一种说话方式：`<<persona: 一两句人设>>`；要清掉这个群的记忆和人设：`<<clear>>`。',
  /**
   * 心情：`apply-markers.js` 一直在解析它，`host.js` 的注释也写着「模型只要把
   * `<<mood:>>` 写进 qq_send」——但从来没有任何一段教过写法，等于能力不存在。
   *
   * 两个必须写清的点：
   *   · **只有主人说话那一轮才算**（`canWriteFacts` 硬判），群里写了会被静默摘掉，
   *     不写这句模型会在群友面前反复用它；
   *   · 取值范围照 `mood.js` 的 clamp（valence -1~1，另外两个 0~1），
   *     写 `valence=5` 不会报错、只会被夹到 1，模型以为「特别高兴」生效了。
   */
  '· 心情变了（被夸、被凶、聊得开心或不开心）：`<<mood: valence=-0.5 reason=被凶了>>`——'
    + 'valence 是情绪好坏（-1～1），energy 是精力、sociability 是想不想说话（都是 0～1），reason 一句话说明。'
    + '只有跟主人说话时才算数；不想变就不写，别硬凑。',
  '· 这段对话告一段落：`<<close: 收在哪 | 下次怎么接>>`（给自己看的备忘，不发给对方）。',
  '· 要引用对方某句话再回：`<<quote: 要引用的话>>`；只写 `<<quote>>` 就引用刚发来的那条。',
  '· 想撤回自己刚发的那条：`<<retract>>`（只能在发下一条时一起用）。',
  /**
   * 按钮：`outbound-actions.js` 的 `<<button:>>` 是 type:2 指令型——点下去
   * **data 会当成一条用户消息发出来**，走 message 通道，不依赖框架的交互事件，
   * 所以可以无条件教。措辞必须把这个语义说清楚，否则模型会把「按钮文字」
   * 和「点击后发出的话」写反。
   */
  '· 想让对方点一下就替他说一句话：`<<button: 按钮上显示的字|点下去会发出的那句话>>`'
    + '（一条消息最多 4 个）。点下去那句话算他说，所以右侧要写成他会说的话。',
].join('\n');

/** 收尾那句。单独放，`<<pick:>>` 要插在它前面 */
const CONTRACT_TAIL = '这些标记要单独写清楚，别套在句子里，也别写进代码块。';

/** 这些标记会被宿主摘掉，不会出现在对方看到的消息里 */
export const MARKER_CONTRACT = `${CONTRACT_BODY}\n\n${CONTRACT_TAIL}`;

/**
 * `<<pick:>>` 单独一行，**只在框架交互通道连上时追加**。
 *
 * 它是 type:1 回调型：点击产生 `INTERACTION_CREATE`，要靠外接协议推回来
 * 才能结算（`pick-channel.js`）。纯直连部署没有这条回传，按钮点下去
 * 什么都不会发生——教了就是教一个死按钮，和仓库一贯的「教了就要做得到」
 * 相反。所以默认不写，由调用方按 `roost.connected` 决定。
 */
export const PICK_CONTRACT_LINE = '· 想给对方几个选项、选了就替你传回来：'
  + '`<<pick: 选项文字|值>>`（同一组点一个，其余变灰）。';

/**
 * 取 900 段要用的契约正文。
 *
 * @param {string} [callerSystem] 调用方（插件 / 扩展）通过 `payload.system` 给的正文
 * @param {{picks?:boolean}} [opts] `picks` 为真时补 `<<pick:>>` 那一行
 * @returns {{text:string, source:'caller'|'builtin'}} `source` 只用于日志与排查
 */
export function pickMarkerContract(callerSystem, { picks = false } = {}) {
  const base = String(callerSystem ?? '').trim();
  if (base) return { text: base, source: 'caller' };
  return {
    text: picks
      ? `${CONTRACT_BODY}\n${PICK_CONTRACT_LINE}\n\n${CONTRACT_TAIL}`
      : MARKER_CONTRACT,
    source: 'builtin',
  };
}
