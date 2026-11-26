/**
 * 正文污染闸：话真正发出去之前的最后一道检查。
 *
 * 为什么需要它：模型有时会把「思考」直接写进正文块（而不是 reasoning 块）——
 * 典型样子是「英文判断 + 中文正文」混在一起，例如群里那两条真实泄露：
 *   `NSFW image + 筹集 joke. Not addressed to me. Silence.[沉默]`
 *   `Godot's story about … is funny. I could react with a laugh line. One line.美服这局也太热闹了…`
 * 还有思考塌缩：同一句「做。」连着重复上百次。
 *
 * 这一层**不猜模型在想什么**，只做四件事：
 *   1. 把「思考前缀」切掉，留下后面真正要说的话（切完没话就沉默）；
 *   2. 拦住明显退化的复读；
 *   3. 拦住「整条只剩协议残渣」（模型把 `<acp …>` / 属性串 / 消息编号抄进正文）；
 *   4. 拦住草稿/自检标记（`Reply:` / `草稿：` 出现在正文里就不是给人看的话）。
 *
 * 全部是纯函数，不发请求、不读写文件，方便单测。
 *
 * ## 来源与删改（别照着 aurabot 原样抄回去）
 *
 * 移植自 aurabot beta `src/chat/guard.js`（MIT），但它那边的三条判据直接搬
 * 到我们这里会出两种错，所以**有意偏离**：
 *   · 它把 >2000 字整条拒发。我们的通道层已经有 `clampOutbound`（1500 字截断），
 *     再拒一次会把「主人要一段长文」变成静默丢消息。这里**不做长度判定**。
 *   · 它整条无中文时一律按思考处理。我们可能被要求「翻成英文」，一句
 *     `I think this works.` 会被误杀。这里改成「两句以上元话语」或带沉默标记才判思考。
 *
 * 另外 `LEGIT_MARKUP` 放行的是**我们自己的**标记（`<<image:>>` / `<voice>` …）：
 * 协议残渣判定发生在通道层，那时动作层已经摘过一遍，但扩展 `/v1/send` 不经过
 * 动作层，可能带着原样标记进来——那些是要执行的指令，不是脏内容。
 */

/** 这轮不说话的各种写法（动作层理论上已摘掉，这里兜底）。 */
const SILENCE_MARK = /\[\s*(?:沉默|silence)\s*\]|<<\s*skip\s*>>|<skip>/gi;

const CJK = /[\u4e00-\u9fff]/;

/**
 * 思考/草稿里的高频英文元话语。只认整句（以 `. ! ?` 结尾），避免正文里
 * 偶尔出现的英文词被误判。
 *
 * 这是**弱信号**：`let me` / `i think` / `i'll` 正常英文对话也在用，只能用来
 * 定位「思考的前缀在哪结束」，不能单独当「这是思考」的证据（见 `STRONG_META`）。
 */
const META_WORDS = /(?:not addressed|silence|i could|i should|i need|i think|i'll|i will|let me|reply|draft|final|one line|\d+ lines?|no reply|skip|ignore)/i;

/**
 * 强信号：**在替自己决定「这轮要不要开口」**，正常英文对话几乎不出现。
 *
 * 为什么要把两档分开：整条没有中文时，旧判据是「元话语句 ≥2 就当思考」，
 * 于是 `Let me check. I think it's done.`（一句正常回答）会被整条拦掉——
 * 使用者让「用英文说」的时候，这类句子是最常见的输出。
 *
 * 真正的思考泄露长这样：`Not addressed to me. Silence.` —— 同样两句，
 * 但每句都在替自己下判断。差别不在「元话语几句」，而在**是不是在决定开不开口**。
 *
 * `skip` / `ignore` 故意**不**在强信号里：英文正文里「Skip this one.」
 * 「I'll ignore that.」都是正常话；模型真想跳过会写 `<<skip>>`（动作层已摘，
 * 走不到这里）。宁可漏一条英文脏话，也不吞一条正常英文。
 */
const STRONG_META = /(?:not addressed|silence|no reply|don'?t reply|i should(?:n'?t)? (?:reply|respond|say)|should i (?:reply|respond|say)|i could (?:react|reply|say)|do i need to (?:reply|respond)|one line|\d+ lines?)/i;

/**
 * 中文元话语：只认句首或标点后，且要求整条很短（≤40 字），避免误伤
 * 「这个跟我没关系吧」这种正常回答。
 *
 * 比 aurabot 多两条（`不该接` / `不用回`）：我们的 PERSONA_BASE 教的正是
 * 「可以不接」，模型写思考时最容易用的就是这两个词。
 */
const META_ZH = /(?:^|[。！？；，\s])(?:这条不是对我说的|不用接|不想接|不该接|不用回|保持沉默|先不接|跟我没关系)/;

/**
 * 草稿标记：出现在正文里就不是给人看的话。
 *
 * **故意比 aurabot 少两个词**（`注意` / `内心`）：中文里「注意：明天降温」
 * 是一句完全正常的提醒，照抄那份清单会把整条消息按草稿丢掉——比漏发一条
 * 脏内容更糟。留下的都是不会出现在正常对话开头的词。
 */
const DRAFT_MARK = /(?:^|\n)[ \t]*(?:Reply|Careful|Draft|Final|Plan|自检|定稿|草稿|思考过程)[ \t]*[:：]/i;

/** 英文句子：以字母开头、不含中文、以 `. ! ?` 结尾；长度限一下，避免贪婪跨越正文。 */
const EN_SENTENCE = /[A-Za-z][^\u4e00-\u9fff\n]{0,200}?[.!?]/g;

/** base64 / 哈希 / 长 ID：连续 40 个以上字母数字，不按「复读」判断。 */
const LONG_TOKEN = /[A-Za-z0-9+/=_-]{40,}/;

/**
 * 我们自己的合法出站标记：`<<image: #3>>` / `<voice>…</voice>` 这类。
 * 有它们在场时直接按「有人话」放行——那是要执行的指令，不是残渣。
 */
const LEGIT_MARKUP = /<<[a-z][a-z-]{0,20}(?:[:：][^<>]{0,2000})?>>|<voice>[\s\S]*?<\/voice>/i;

/**
 * 已知协议标签：acp / state / 工具调用系列（模型从上下文里顺手抄下来的帧）。
 */
const PROTO_TAG_ALL = /<\s*\/?\s*(?:acp|state|x?invoke|x?parameter|x?function_calls?|x?tool_calls?|x?tool_use|antml:[a-z_]+)(?=[\s/>])[^<>]*>/gi;

/** 任意标签（含开/闭/自闭合、带或不带属性） */
const ANY_TAG = /<\s*\/?\s*[A-Za-z][\w:-]*(?:\s[^<>]*)?>/g;

/** 属性串形状：`tokens="86" type="text" time="…"`（可能带前导 `=`）。 */
const PROTO_ATTR_RUN = /(?:=\s*)?"[^"]*"\s*(?:(?:[a-z][\w:-]*)\s*=\s*"[^"]*"\s*)+>>?/gi;

/** 消息编号：`m01990`。 */
const PROTO_MSG_ID = /\bm\d{4,8}\b/g;

/**
 * 属性尾巴里的日期时间残片（实况 `6-11-22 17:26:55">`：`2026-…` 被截掉了头）。
 * 只有「时间 + 收尾引号尖括号」这种**残片形状**才挖掉。
 */
const PROTO_TIME_TAIL = /(?:\d{1,4}-)?\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s*">/g;

/**
 * 切掉思考前缀，只留后面真正要说的话。
 *
 * 找「最后一个元话语英文句子」的结尾，把它和前面的全部切掉；
 * 剩余部分不含中文（或只剩沉默标记/空白）时返回空字符串——意思是这轮不该说话。
 * 没找到任何元话语时原样返回，不主动改动正常内容。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripThinkingPrefix(text) {
  const s = String(text ?? '');
  if (!s.trim()) return '';

  let last = null;
  /** 英文句数 / 其中带强信号的句数（见 `STRONG_META` 的注释） */
  let sentences = 0;
  let strong = 0;
  for (const m of s.matchAll(EN_SENTENCE)) {
    sentences++;
    if (STRONG_META.test(m[0])) strong++;
    if (META_WORDS.test(m[0])) last = m;
  }

  // 中文元话语：整条都是判断时直接当思考，不保留。
  if (!last) {
    const zh = META_ZH.exec(s);
    if (zh && zh.index <= 24 && s.length <= 40) return '';
    return s;
  }

  const rest = s.slice(last.index + last[0].length).trim();
  const hasCJK = CJK.test(s);

  /**
   * 整条没有中文：**别一律当思考**。
   *
   * 我们的使用者可能直接说「翻成英文」「what's your name」，模型整条用英文回
   * 是正常回答——`Let me check. I think it's done.` 两句都是元话语，但它就是
   * 一句人话。旧判据「元话语句 ≥2 就拦」在这种场景下必然误杀。
   *
   * 所以改看**强信号**（`STRONG_META`：在替自己决定开不开口），再加一条长度
   * 限制——英文段落超过 3 句就不当思考：那可能是翻译、是长篇解释，里面出现
   * `silence` / `ignore` 只是内容本身。
   */
  if (!hasCJK) {
    if (strong >= 1 && sentences <= 3) return '';
    if (/\[\s*(?:沉默|silence)\s*\]/i.test(s)) return '';
    return s;
  }

  if (!CJK.test(rest)) return '';
  if (isBlank(rest)) return '';
  return rest;
}

/**
 * 判断是不是「同一句反复」的退化输出（做。做。做。…）。
 *
 * 阈值故意放得很松：至少重复 4 次、重复部分不少于 24 个字、且占全文一半以上。
 * 「好耶好耶好耶」「哈哈哈哈哈哈」这类正常重复过不了线，不会误杀。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isDegenerate(text) {
  const s = String(text ?? '').replace(/\s+/g, '');
  if (s.length < 24) return false;
  for (let len = 2; len <= 8; len++) {
    for (let i = 0; i + len * 4 <= s.length; i++) {
      const unit = s.slice(i, i + len);
      if (!unit.trim()) continue;
      let n = 1;
      while (i + (n + 1) * len <= s.length && s.slice(i + n * len, i + (n + 1) * len) === unit) n++;
      if (n >= 4 && n * len >= 24 && (n * len) / s.length > 0.5) return true;
    }
  }
  return false;
}

/**
 * 只有沉默标记 / 纯标点时算「没有内容」。
 * @param {string} text
 */
export function isBlank(text) {
  const t = String(text ?? '').replace(SILENCE_MARK, '');
  return t.replace(/[\s\p{P}\p{S}]/gu, '') === '';
}

/**
 * 整条是不是只剩协议残渣（`<acp tokens="86">m01990</acp>` / 属性串 / 消息编号）。
 *
 * 判据：把已知标签、任意标签、属性串、编号都挖空之后，若既没有中文、
 * 也没有成词的字母数字，就算残渣。刻意保守——正常句子（哪怕很短，
 * 如「在吗」「ok」）一定留得下成词的中文/字母，不会误判。
 *
 * @param {string} text
 * @returns {boolean} true = 没有真正要说的话，应当按沉默处理
 */
export function isProtocolResidue(text) {
  const t = String(text ?? '');
  if (!t.trim()) return true;
  if (LEGIT_MARKUP.test(t)) return false;

  /* 围栏里是正当内容，不参与判定 */
  let hollow = t.replace(/```[\s\S]*?```/g, '');
  const before = hollow.length;
  hollow = hollow
    .replace(PROTO_TAG_ALL, '')
    .replace(ANY_TAG, '')
    .replace(PROTO_ATTR_RUN, '')
    .replace(PROTO_TIME_TAIL, '')
    .replace(PROTO_MSG_ID, '');

  /**
   * **一个协议形状都没命中就不是残渣。**
   *
   * 少了这一条，单字符回答（`x` / `k` / `？`）会被判残渣——它确实「既没有
   * 中文、也没有 ≥2 个字母数字」，但它显然是人话。判残渣的前提是「曾经
   * 有过协议标记」，而不是「看起来不像句子」。
   */
  if (hollow.length === before) return false;

  if (/[\u4e00-\u9fff]/.test(hollow)) return false;
  return !/[A-Za-z0-9]{2,}/.test(hollow.replace(/[=<>/\\"'`\-_.:;,|]+/g, ' '));
}

/**
 * 出站文本的最后一道闸。
 *
 * @param {string} text 准备发出去的文字
 * @returns {{ok:boolean, text:string, reason:string}}
 *   `ok=false` 时调用方应当**不发这一条**（宁可沉默），并把 reason 记日志。
 */
export function guardOutgoing(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, text: '', reason: 'empty' };

  /**
   * 代码围栏整段豁免：她发给主人/群友的代码、命令行、日志不是「思考」。
   * 只对围栏外面的部分切思考前缀，围栏里一个字都不动。
   */
  const fenceAt = raw.indexOf('```');
  if (fenceAt >= 0) {
    const head = stripThinkingPrefix(raw.slice(0, fenceAt));
    const body = raw.slice(fenceAt);
    const merged = [head, body].filter(Boolean).join('\n').trim();
    if (isBlank(merged)) return { ok: false, text: '', reason: 'blank' };
    return { ok: true, text: merged, reason: '' };
  }

  const work = stripThinkingPrefix(raw);
  if (!work) return { ok: false, text: '', reason: 'thinking-only' };
  if (isBlank(work)) return { ok: false, text: '', reason: 'blank' };
  /**
   * 残渣判定放在退化检测**之前**：残渣常常带一长串属性，
   * `LONG_TOKEN` 会把它从退化检测里豁免掉。
   */
  if (isProtocolResidue(work)) return { ok: false, text: '', reason: 'protocol-residue' };
  /** 长串（base64 / 哈希 / 长 ID）不按复读处理，否则贴一串数据就被当成退化 */
  if (!LONG_TOKEN.test(work) && isDegenerate(work)) return { ok: false, text: '', reason: 'degenerate' };
  if (DRAFT_MARK.test(work)) return { ok: false, text: '', reason: 'draft' };

  return { ok: true, text: work, reason: '' };
}
