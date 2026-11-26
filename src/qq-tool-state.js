/**
 * QQ 动作工具的挂载状态、逐轮收走清单，以及 907 段「发言方式」提示词。
 *
 * 从 `host.js` 的 `apply()` 闭包里抽出来，是为了能单测：2026-11-10 那次
 * 私聊 `unknown tool` 的三处成因（注册竞态、全局状态串味、提示词与调用期
 * 掩码不同步）都出在这段逻辑里，埋在闭包内只能靠重启后碰运气验证。
 *
 * 这里只管状态与文本，不碰配置、不碰 QQ 通道、不注册工具。
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUTPUT_TOOLS, shouldHideOutputPrompt, toolWasDenied } from './permissions.js';

/** 落盘最多保留多少个会话的挂载结果，避免长期运行无限增长 */
const MAX_SESSIONS = 50;
const WAIT_TIMEOUT = Symbol('qq-tool-wait-timeout');

/**
 * 读 `tools.schemas()` 报的工具名。
 *
 * 注意它报的是**注册清单**，读不到 `restrict({deny})` 的调用期掩码——
 * 所以只能当跨版本兜底，判「本轮能不能用」必须另看逐轮 deny 清单。
 * 老版本没有 schemas / 调用抛错时返回 null，调用方按旧行为处理。
 *
 * @param {object} agent
 * @returns {Set<string>|null}
 */
export function registeredToolNames(agent) {
  let list = null;
  try {
    list = agent?.ctx?.tools?.schemas?.();
  } catch {}
  if (!Array.isArray(list)) return null;
  /** 各版本形状不一：对象、{tool:{name}}、以及直接给字符串 */
  const names = list
    .map((s) => (typeof s === 'string' ? s : String(s?.name ?? s?.tool?.name ?? '')))
    .filter(Boolean);
  return new Set(names);
}

/**
 * 生成 907 段「发言方式」提示词；返回空串表示这一轮整块不注入。
 *
 * 纯函数：所有输入显式传入，不读配置、不碰 agent 状态，方便单测。
 * 「整块闭嘴」的条件：
 *   · 这个 agent 的工具没挂上；
 *   · 本轮 deny 命中任一输出通道（`qq_send` / `qq_close`）；
 *   · 拿到了注册清单却缺任一输出通道（跨版本兜底）。
 *
 * 只收走 `qq_send_file` 时不闭嘴，但把提到文件工具的两处字句摘掉——
 * 「发文件」是独立开关，关掉它不该连分段发言一起关掉。
 *
 * @param {object} [opts]
 * @param {{ok:boolean}} [opts.mounted] 这个 agent 的挂载结果
 * @param {Set<string>|string[]|null} [opts.denied] 本轮实际被收走的工具名
 * @param {Set<string>|null} [opts.registeredNames] schemas() 报的注册清单
 * @param {boolean} [opts.ttsEnabled] 语音是否开启
 * @param {boolean} [opts.longThinkHint] 是否注入「想久了先用 qq_send 说一句」
 * @returns {string}
 */
export function buildOutputPrompt({
  mounted,
  denied,
  registeredNames = null,
  ttsEnabled = false,
  longThinkHint = false,
} = {}) {
  if (!mounted?.ok) return '';
  /** 报「挂上了」却没挂 qq_send 时也不能注入，否则又是教模型调不存在的工具 */
  if (Array.isArray(mounted.names) && mounted.names.length && !mounted.names.includes('qq_send')) return '';
  if (shouldHideOutputPrompt(denied)) return '';
  if (registeredNames && OUTPUT_TOOLS.some((n) => !registeredNames.has(n))) return '';

  const fileDenied = toolWasDenied(denied, 'qq_send_file');
  const fileRegistered = !registeredNames || registeredNames.has('qq_send_file');
  /**
   * `qq_who` 是**可选**的只读工具，所以不进 `OUTPUT_TOOLS`（那个是「缺一个就
   * 整段不注入」的硬清单）。没挂上就少教一句，不影响发言规则。
   */
  const whoDenied = toolWasDenied(denied, 'qq_who');
  const whoRegistered = !registeredNames || registeredNames.has('qq_who');

  const lines = [
    '【发言方式】',
    '你手上有这几个工具：`qq_send`（发一段话）、`qq_close`（给这段对话收尾）'
      + (!fileDenied && fileRegistered
        ? '，以及（装了的话）`qq_send_file`（发一个文件）。'
        : '。'),
    '· 想说话就调 `qq_send`，一次发一段，按需要可以分多次。**别把要发的话写进正文**。',
    '· 调过 `qq_send` 之后，你回复的正文**不会**再发出去——正文只当思考用。',
    ...(longThinkHint
      ? [
          /**
           * 2026-11-26 主人要的「思考久就用 qq_send 中间回话」引导。
           *
           * 措辞要点（按提示词专项验证的四问）：
           *   · 用「如果 / 可以」不命令——不能压正常短回复，简单问题还是一句答完；
           *   · 明确「这是同一轮」，不要写成「等下一条消息」，免得模型以为要等用户；
           *   · 放在 910 安全段之前、907 工具段内，指代「上面」不会圈进权限规则；
           *   · **绝不能出现「正文」二字**：同段 :91 已写「调过 qq_send 正文不会发出去」，
           *     说「把正文说出来」会诱导模型把答案写进正文 → 用户只收到空话。
           *   · **不说「我想想哈」之类的拖延话术**（2026-11-26 主人二次定稿）：
           *     先发的必须是**已经想到的内容**，不是「我在想」这种空话。
           *     空话既占一次被动回话额度，又让人觉得机器人只会敷衍。
           *   · 不写「轮次中间收到新消息就应一句」：高频群这是常态，会逼出刷屏；
           *     只说「确实要回应时」并且仍然走 qq_send 分段，交给模型判断。
           *   · 只是软引导：真边界是 qq_send 的权限与轮次护栏，不靠这段话兜底。
           */
          '· 如果这件事要想比较久（比如要翻记忆、查资料、算东西），可以先把已经想到的部分调一次 `qq_send` 发出去，再接着想——这还是同一轮，不用等对方回话。想好了再调一次 `qq_send` 把剩下的说出来。',
          '· 轮次中间确实收到需要回应的新消息时，也可以先用 `qq_send` 把能答的部分先答了，再接着想完——仍然是同一轮。',
        ]
      : []),
    '· 聊到自然结束、对方要走的时候，用 `qq_close` 记一句「收在哪 / 下次怎么接」，然后可以不说话。',
    '· 一个工具都不调时，正文会照常发出去（旧方式）。**不要又调工具又写正文**——那样只发工具那条，正文会被丢掉。',
    /**
     * 语音写法已经由 900 段（roostVoiceHintText）每轮教会模型，这里只讲工具模式下
     * 「写进 qq_send 的 text」这一个差异，不重复整套标记说明——重复两遍会让模型
     * 犹豫哪份才算数。
     *
     * 旧的 `<<say:>>` 在工具模式下两头都走不通：qq_send 拦 say，正文又不会被发。
     * `<voice>` 成对标签不在 SEND_BLOCKED、stripUnknown 也放过，写进 qq_send
     * 的 text 就能随工具一起进出站层被 TTS 合成。
     */
    ...(ttsEnabled
      ? ['· 想发**语音条**时，按前面语音说明的 `<voice>…</voice>` 写法，'
        + '把要念的话写进 `qq_send` 的 text 里（和要说的话同一段也行）；'
        + '语音就是这段文字本身，别在正文里再重复一遍。']
      : []),
  ];

  if (!fileDenied && fileRegistered) {
    lines.push(
      '· 要发文件（文档、表格、压缩包、图片都算）就调 `qq_send_file`，参数是**绝对路径**，一轮最多一个。'
      + '路径要来自你确实看到过的文件，别凭印象拼；它发不出去会直接告诉你。',
    );
  }

  /**
   * 认人：昵称会重名、也能随便改，身份以 QQ 号 / openid 为准。
   * 头像给的是**本地路径**——模型拿 URL 既读不了也发不出去。
   */
  if (!whoDenied && whoRegistered) {
    lines.push(
      '· 拿不准「这个 openid 是谁」、或者想用某个人的头像，调 `qq_who`（只读）：'
      + '给 openid 查那个人，不给就查当前说话的人。'
      + '返回昵称、群昵称、QQ 号、openid 和**头像的本地文件路径**'
      + '（可以直接 `<<image: 路径>>` 发出去）。',
    );
  }
  /**
   * 搜历史：只在工具真的挂上时教。
   *
   * 描述里必须把**权限差异**说清楚：普通群成员调用时只能搜自己、且只在当前
   * 会话里。不写这句，模型会在群里承诺「我翻翻你们以前的聊天」，然后被工具
   * 的收窄打了个空，看起来像失忆。
   */
  const searchDenied = toolWasDenied(denied, 'qq_search');
  const searchRegistered = !registeredNames || registeredNames.has('qq_search');
  if (!searchDenied && searchRegistered) {
    lines.push(
      '· 想不起来「以前说过什么」时，调 `qq_search`（只读）搜账本：'
      + '关键词空格分隔、多个词要同时命中（没有结果会自动放宽成任一）。'
      + '返回按时间倒序，带会话名、发言人、时间、正文。'
      + '**普通成员只能搜到自己的消息、且只在当前会话范围内**；'
      + '主人和管理员才能跨会话、按别人查。别承诺你权限外的检索。',
    );
  }
  /**
   * 撤回：只在工具真挂上时教，且**只教撤自己的**。
   *
   * 措辞上的三条硬约束：
   *   · 不写「可以撤别人的」——官机只有群管理员能撤普通成员，而模型没有
   *     稳定的成员消息号来源，教了也做不到，只会让它答应做不到的事；
   *   · 必须写「2 分钟」——这是官方硬限（`40064004`）。不写的话，模型会
   *     在十分钟后还想撤，然后拿到一次失败、再试、再失败；
   *   · 必须写「撤了不代表没说过」——不然它会把撤回当成「可以随便说」的
   *     许可，而群里的人其实已经看见了。
   */
  const retractDenied = toolWasDenied(denied, 'qq_retract');
  const retractRegistered = !registeredNames || registeredNames.has('qq_retract');
  if (!retractDenied && retractRegistered) {
    lines.push(
      '· 说错了、发重了、或者那句话不该留在这儿，可以调 `qq_retract` 撤回**你自己刚发的**那条'
      + '（默认最近一条，也能撤倒数第 2～5 条）。撤不了别人的；'
      + '官方只给 2 分钟，超时就撤不回来——那就别再试，直接补一句更正。'
      + '撤回只是让消息消失，看过的人已经看过了，别把它当成「没说过」。',
    );
  }
  return lines.join('\n');
}

/**
 * 按会话管理 QQ 工具状态。
 *
 * @param {object} opts
 * @param {() => string} opts.dirOf 数据目录（传函数，运行时现取）
 * @param {(msg:string) => void} [opts.log] 警告日志
 * @param {number} [opts.waitMs] 等挂载的超时毫秒数
 */
export function createQqToolState({ dirOf, log = () => {}, waitMs = 2000 } = {}) {
  /** agent -> 挂载结果；工具是按 agent 注册的，不能用全局单例 */
  const byAgent = new WeakMap();
  /** agent -> 挂载 Promise */
  const ready = new WeakMap();
  /** agent -> 本轮被收走的工具名 */
  const denied = new WeakMap();
  /** chatId -> 最近一次挂载结果 */
  const sessions = new Map();

  /**
   * 最新在前。Map 由 note() 按「最近使用」维护，直接倒序即可：
   * 同一毫秒写入的多个会话时间戳相同，靠时间戳排序会退化成插入顺序，
   * 限量时就会把刚写入的当前会话当成最旧的删掉。
   */
  function ordered() {
    return [...sessions.values()].reverse();
  }

  /**
   * 面板 /status 用的汇总。以前是「最后一次挂载」，多会话时会串味：
   * 一个会话挂成功就把全局置 ok，另一个失败也看不出来。
   */
  function summary() {
    const all = ordered();
    const failed = all.filter((s) => !s.ok);
    const last = all[0];
    return {
      /** 全部已记录会话都挂成功才算 ok；失败的另有明细 */
      ok: all.length > 0 && failed.length === 0,
      failedCount: failed.length,
      sessionCount: all.length,
      names: last?.names || [],
      reason: failed.map((s) => `${s.chatId}：${s.reason}`).join('；'),
      sessions: all,
    };
  }

  /** 落盘：顶层保留最后一次挂载（兼容既有排查脚本），另附全部会话明细 */
  function note(chat, r) {
    const entry = {
      at: Date.now(),
      chatId: String(chat?.chatId || ''),
      ok: !!r?.ok,
      names: Array.isArray(r?.names) ? r.names : [],
      mode: String(r?.mode || ''),
      reason: String(r?.reason || ''),
    };
    /** 先删再插：同一个会话重挂载也算「最近使用」，移到 Map 末尾 */
    sessions.delete(entry.chatId);
    sessions.set(entry.chatId, entry);
    /** 超限时删 Map 头部（最久未更新的），当前会话一定保留 */
    while (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
    try {
      writeFileSync(join(dirOf(), 'tool-state.json'), JSON.stringify({
        at: entry.at,
        chatId: entry.chatId,
        ok: entry.ok,
        names: entry.names,
        mode: entry.mode,
        reason: entry.reason,
        sessions: ordered(),
      }, null, 2));
    } catch (e) {
      /** 落盘只是可观测性；失败不影响主流程，但不能一声不吭 */
      log(`工具挂载状态写盘失败：${e?.message || e}`);
    }
    return entry;
  }

  function setMounted(agent, chat, r) {
    const state = {
      ok: !!r?.ok,
      names: Array.isArray(r?.names) ? r.names : [],
      reason: String(r?.reason || ''),
    };
    byAgent.set(agent, state);
    note(chat, r);
    return state;
  }

  function setReady(agent, promise) { ready.set(agent, promise); }
  function mountedOf(agent) { return byAgent.get(agent); }
  function setDenied(agent, names) { denied.set(agent, new Set(names)); }
  function deniedOf(agent) { return denied.get(agent); }

  /**
   * 包一层「轮末还原」：先撤销 `restrict` 掩码，成功后才清本轮状态。
   * 顺序反过来的话，`off()` 抛异常时状态已清、掩码还在，
   * 提示词会重新教模型去调一个仍不可用的工具。
   */
  function wrapRestore(agent, off) {
    return () => {
      try {
        off();
      } catch (e) {
        log(`还原工具权限失败：${e?.message || e}；本轮状态先留着`);
        throw e;
      }
      denied.delete(agent);
    };
  }

  /** 轮次开始前等挂载完成；超时不阻塞回话，但记一笔，别静默降级 */
  async function waitFor(agent) {
    const p = ready.get(agent);
    if (!p) return;
    let timer;
    try {
      const winner = await Promise.race([
        /** 挂载失败不该把整轮回话带崩；失败原因已由 setMounted 落盘 */
        Promise.resolve(p).catch(() => {}),
        new Promise((r) => { timer = setTimeout(() => r(WAIT_TIMEOUT), waitMs); }),
      ]);
      if (winner === WAIT_TIMEOUT) {
        log(`等 QQ 工具挂载超过 ${waitMs} 毫秒：这一轮先不注入发言方式，工具挂完后下一轮自动恢复`);
      }
    } finally {
      /** ready 先完成时把定时器收掉，别让每一轮都留一个挂起 */
      clearTimeout(timer);
    }
  }

  return {
    summary, setMounted, setReady, mountedOf,
    setDenied, deniedOf, wrapRestore, waitFor,
  };
}
