/**
 * 聊天内宿主命令（DSH 侧）
 * ========================
 *
 * 框架 1.2.0 起，外接客户端能在 roost 侧**注册聊天命令**（`ext.register` 的
 * `host.commands`）：群里发 `/model` 时框架不再当成聊天投进来，而是推一条
 * `ext.command.request`，宿主执行完用 `ext.command.reply` 回执，带 `reply`
 * 就由框架代发（带引用、受限频与被动窗口管）。
 *
 * 这一层只做**命令本身**：解析、参数、文案、以及「改哪个配置」。所有会写盘
 * 或碰运行态的动作都从 `api` 注入——`host.js` 里那些闭包（`cfg` / `sessions` /
 * `modelApplied` / `memory` / `journal`）不搬出来，免得两边各有一份状态。
 * 好处是这文件能拿假 api 单测，不用起整个 DSH。
 *
 * 几条设计约束：
 *
 *   · **只认 `msg.command` 与 `msg.args`**，不重新解析正文。框架已经按
 *     `commandPrefix` 切好了，宿主再切一遍会在中文别名和空格上分叉。
 *   · **不注册 `/help`**：框架内核已经有一个，扩展命令会自动进那个菜单。
 *   · **`/persona` 不在这里**：聊天内切人格走的是「提示词软切换」（见
 *     `docs/聊天内切人格指令.md`），一旦注册成真命令，框架会在入站就拦掉，
 *     那条软路径直接失效。
 *   · 权限由**框架**按群里角色判（`admin` / `ownerOnly`），这里只声明。
 *     宿主不重判——两侧各判一次只会出现「框架放行、宿主拒绝」的鬼故事。
 */

/** 单条命令的回复正文上限：QQ 一条放不下更多，截断比报错友好 */
const MAX_REPLY = 1200;

/**
 * 命令清单。字段与框架 `ext.register` 的 `host.commands` 对齐：
 * `admin` / `ownerOnly` 由框架判，`hidden` 只是不进菜单。
 *
 * 注意 `usage` 里的前缀写 `/`，真正下发时由 `specs()` 换成当前前缀。
 */
export const HOST_COMMANDS = Object.freeze([
  {
    name: 'model',
    aliases: ['模型', '换模型'],
    desc: '查看或切换这个会话用的模型',
    usage: '/model [list|序号|provider/model|off]',
    admin: true,
  },
  {
    name: 'effort',
    aliases: ['思考'],
    desc: '查看或设置思考强度',
    usage: '/effort [档位|默认]',
    admin: true,
  },
  { name: 'silent', aliases: ['闭嘴'], desc: '这个会话先不接话（直到 /active）', usage: '/silent', admin: true },
  { name: 'active', aliases: ['说话'], desc: '恢复这个会话接话', usage: '/active', admin: true },
  { name: 'quiet', aliases: ['少说'], desc: '这个会话只旁听，被叫到才回', usage: '/quiet', admin: true },
  { name: 'normal', aliases: ['正常'], desc: '这个会话恢复正常接话', usage: '/normal', admin: true },
  {
    name: 'remember',
    aliases: ['记住', '记一下'],
    desc: '让 ta 记住一条事实',
    usage: '/remember <内容>',
    admin: true,
  },
  { name: 'reset', aliases: ['重开'], desc: '重置这个会话的上下文（记忆不动）', usage: '/reset', ownerOnly: true },
  { name: 'on', aliases: ['开机'], desc: '打开机器人总开关', usage: '/on', ownerOnly: true },
  { name: 'off', aliases: ['关机'], desc: '关闭机器人总开关', usage: '/off', ownerOnly: true },
  { name: 'dstatus', aliases: ['状态'], desc: '看看 DSH 这边的状态', usage: '/dstatus' },
  { name: 'mood', aliases: ['心情'], desc: '看看 ta 现在的心情', usage: '/mood' },
  { name: 'diary', aliases: ['日记'], desc: '往这个会话的日记里记一条', usage: '/diary <内容>', ownerOnly: true },
  {
    name: 'speak',
    aliases: ['搭话'],
    desc: '主动搭话的朋友白名单',
    usage: '/speak [add|del <openid>]',
    ownerOnly: true,
  },
]);

/** 名字 → 规范名。别名和主名都能查到，查不到就是 null */
const BY_NAME = (() => {
  const m = new Map();
  for (const c of HOST_COMMANDS) {
    m.set(c.name, c.name);
    for (const a of c.aliases ?? []) m.set(a, c.name);
  }
  return m;
})();

export function canonicalCommand(name) {
  return BY_NAME.get(String(name ?? '').trim().toLowerCase()) || null;
}

/**
 * 下发给框架的清单。`enabled` 关 / 单条被禁时由调用方过滤，这里不做。
 *
 * @param {object} [opt]
 * @param {string} [opt.prefix='/']  当前命令前缀
 * @param {(name:string)=>boolean} [opt.allow]  单条开关（`commands.disabled`）
 */
export function hostCommandSpecs({ prefix = '/', allow = () => true } = {}) {
  return HOST_COMMANDS.filter((c) => allow(c.name)).map((c) => ({
    name: c.name,
    aliases: [...(c.aliases ?? [])],
    desc: c.desc,
    usage: String(c.usage ?? '').replace(/^\//, prefix),
    admin: c.admin === true,
    ownerOnly: c.ownerOnly === true,
  }));
}

/** 一律按「人话」截断：宁可少一句，也不要让框架因为超长把整条回执丢掉 */
function clip(s) {
  const t = String(s ?? '').trim();
  return t.length > MAX_REPLY ? `${t.slice(0, MAX_REPLY - 1)}…` : t;
}

function modelLabel(sel) {
  if (!sel) return '';
  const p = String(sel.provider ?? '').trim();
  const m = String(sel.model ?? '').trim();
  if (!p && !m) return '';
  return `${p}/${m}`;
}

const MODE_TEXT = {
  chat: '正常接话',
  observe: '只旁听（被叫到才回）',
  off: '不接话',
};

/**
 * 宿主命令执行器。
 *
 * @param {object} opt
 * @param {() => string} [opt.prefix]  现读前缀（配置能改，不能烤进来）
 * @param {object} opt.api             见文件头：所有落盘/运行态动作从这里进
 * @param {(m:string)=>void} [opt.log]
 */
export function createChatCommands({ prefix = () => '/', api, log = () => {} } = {}) {
  const P = () => String(prefix() ?? '/') || '/';

  /** 当前会话 id：群是 groupId，私聊是 openid；框架已经保证非空 */
  const chatOf = (msg) => String(msg?.chat?.chatId ?? msg?.chat?.groupId ?? '');
  /** c2c / group —— 模型要按它查 byKind，缺了会显示成「跟随全局」但实际不是 */
  const kindOf = (msg) => String(msg?.chat?.kind ?? '');

  async function cmdModel(msg, args) {
    const chatId = chatOf(msg);
    const arg = String(args?.[0] ?? '').trim();
    const st = await api.modelState(chatId, kindOf(msg));
    const eff = modelLabel(st?.effective);

    if (!arg) {
      const own = modelLabel(st?.override);
      return clip(
        [
          `本会话模型：${eff || '跟随全局默认'}`,
          own ? `（单独设过：${own}）` : '（没单独设过）',
          `想到别的：${P()}model list 看清单，${P()}model off 恢复默认`,
        ].join('\n'),
      );
    }

    if (arg.toLowerCase() === 'list') {
      const list = await api.modelList();
      if (!list?.length) return '这会儿列不出模型清单（DSH 那边可能没有可用模型）。';
      const lines = list.slice(0, 20).map((it, i) => `${i + 1}. ${modelLabel(it) || it?.id || '?'}`);
      return clip(
        [`可用模型：`, ...lines, `发 ${P()}model <序号> 或 ${P()}model provider/model 切换`].join('\n'),
      );
    }

    if (arg.toLowerCase() === 'off') {
      if (!modelLabel(st?.override)) return '本来就没单独设过，已经是跟随默认了。';
      await api.setModel({ chatId, off: true });
      return '好了，这个会话恢复用默认模型，下一句生效。';
    }

    /** 纯数字 = 上一条 `list` 里的序号（缓存 10 分钟，够用） */
    if (/^\d{1,3}$/.test(arg)) {
      const picked = await api.pickModel(Number(arg));
      if (!picked) return `没有第 ${arg} 个，先发 ${P()}model list 看看清单。`;
      await api.setModel({ chatId, kind: kindOf(msg), provider: picked.provider, model: picked.model });
      return `好，这个会话改用 ${modelLabel(picked)}，下一句生效。`;
    }

    const slash = arg.indexOf('/');
    if (slash <= 0 || slash === arg.length - 1) {
      return `要写成 provider/model，比如 ${P()}model anthropic/claude-sonnet-4；发 ${P()}model list 看有哪些。`;
    }
    const provider = arg.slice(0, slash).trim();
    const model = arg.slice(slash + 1).trim();
    await api.setModel({ chatId, kind: kindOf(msg), provider, model });
    return `好，这个会话改用 ${provider}/${model}，下一句生效。`;
  }

  async function cmdEffort(msg, args) {
    const chatId = chatOf(msg);
    const arg = String(args?.[0] ?? '').trim();
    const st = await api.modelState(chatId, kindOf(msg));
    const cur = String(st?.effort ?? '').trim();
    if (!arg) return `现在思考强度：${cur || '跟随模型默认'}。改：${P()}effort 低|中|高，或 ${P()}effort 默认。`;
    if (arg === '默认' || arg.toLowerCase() === 'default') {
      await api.setEffort(chatId, '');
      return '好了，思考强度跟随模型默认了。';
    }
    if (arg.length > 32) return '这个档位名太长了。';
    await api.setEffort(chatId, arg);
    return `好了，思考强度改成「${arg}」，下一句生效。`;
  }

  async function setMode(msg, mode, label) {
    /**
     * 只对**群**生效：这张表是 `group.responseModes`，私聊/频道根本没人读它。
     * 不拦的话，在私聊里发 /silent 会回一句「好」，但其实什么都没关——
     * 假装成功比报错更难查。
     */
    if (kindOf(msg) !== 'group') {
      return '这个命令只在群里有用：私聊直接不找我说话就行；频道请在面板里改。';
    }
    await api.setResponseMode(chatOf(msg), mode);
    return label;
  }

  async function cmdRemember(msg, args, raw) {
    const text = String(raw ?? args?.join(' ') ?? '').trim();
    if (!text) return `要记什么？发 ${P()}remember 后面跟一句话。`;
    const ok = await api.remember(chatOf(msg), text);
    return ok ? '记下了。' : '这条没写进去（可能和已有的重复，或记忆库这会儿写不了）。';
  }

  async function cmdDiary(msg, args, raw) {
    const text = String(raw ?? args?.join(' ') ?? '').trim();
    if (!text) return `要往日记里记什么？`;
    const ok = await api.diary(chatOf(msg), text);
    return ok ? '记到日记里了。' : '日记没写进去，稍后再试。';
  }

  async function cmdReset(msg) {
    const r = await api.resetSession(chatOf(msg));
    return r?.had ? '这个会话的上下文清空了，下一条开新会话（记忆和配置都没动）。' : '这个会话本来就没有上下文，不用重置。';
  }

  async function cmdEnabled(on) {
    const cur = await api.setEnabled(on);
    return cur ? '开机了。' : `关机了，之后的消息都不回。发 ${P()}on 才能再开。`;
  }

  async function cmdStatus(msg) {
    const st = await api.status(chatOf(msg), kindOf(msg));
    const eff = modelLabel(st?.model?.effective);
    const lines = [
      `模型：${eff || '跟随全局默认'}`,
      `思考强度：${String(st?.model?.effort ?? '').trim() || '跟随模型默认'}`,
      `这个会话：${MODE_TEXT[st?.responseMode] || st?.responseMode || '正常接话'}`,
      `上下文：${st?.sessionId ? '在' : '没有（下一条会开新的）'}｜已聊 ${Number(st?.rounds) || 0} 轮`,
      `记忆：${Number(st?.facts) || 0} 条事实 / ${Number(st?.journal) || 0} 条日记`,
      `总开关：${st?.enabled === false ? '关' : '开'}`,
    ];
    return clip(lines.join('\n'));
  }

  async function cmdMood() {
    const m = await api.mood();
    if (!m) return '这会儿读不到心情。';
    const pct = (v) => `${Math.round((Number(v) || 0) * 100)}%`;
    const lines = [
      `心情：${Number(m.valence) >= 0 ? '偏正面' : '偏低落'}（${Number(m.valence).toFixed(2)}）`,
      `精力 ${pct(m.energy)}｜想聊天 ${pct(m.sociability)}`,
    ];
    if (m.reason) lines.push(`原因：${String(m.reason).slice(0, 60)}`);
    return clip(lines.join('\n'));
  }

  async function cmdSpeak(_msg, args) {
    const sub = String(args?.[0] ?? '').trim().toLowerCase();
    const who = String(args?.[1] ?? '').trim();
    const list = await api.speakList();
    if (!sub) {
      return clip(
        list.length
          ? [`能主动搭话的朋友（${list.length}）：`, ...list.map((x, i) => `${i + 1}. ${x}`)].join('\n')
          : `现在只对主人主动搭话。加人：${P()}speak add <openid>`,
      );
    }
    if (sub === 'add') {
      if (!who) return '要加谁？给一个 openid（不是 QQ 号）。';
      const r = await api.speakAdd(who);
      return r.ok ? `加上了，现在能主动搭话的有 ${r.count} 人。` : r.message || '没加上。';
    }
    if (sub === 'del' || sub === 'remove') {
      if (!who) return '要删谁？给一个 openid。';
      const r = await api.speakDel(who);
      return r.ok ? `删掉了，还剩 ${r.count} 人。` : r.message || '名单里没有这个 openid。';
    }
    return `用法：${P()}speak（看名单）｜${P()}speak add <openid>｜${P()}speak del <openid>`;
  }

  const RUNNERS = {
    model: cmdModel,
    effort: cmdEffort,
    silent: (msg) => setMode(msg, 'off', '好，这个会话我先不接话了。发 /active 叫我。'),
    active: (msg) => setMode(msg, null, '好，恢复正常了。'),
    quiet: (msg) => setMode(msg, 'observe', '好，这个会话我少说话，被叫到才回。'),
    normal: (msg) => setMode(msg, null, '好，这个会话恢复正常接话。'),
    remember: cmdRemember,
    diary: cmdDiary,
    reset: cmdReset,
    on: () => cmdEnabled(true),
    off: () => cmdEnabled(false),
    dstatus: cmdStatus,
    mood: cmdMood,
    speak: cmdSpeak,
  };

  /**
   * 执行一条命令。
   *
   * @param {object} p
   * @param {string} p.name        框架给的规范名或别名
   * @param {object} p.msg         序列化后的消息（`chat` / `sender` / `args` / `content`）
   * @returns {Promise<string|null>} 回执正文；null = 宿主自己发过了
   */
  async function run({ name, msg } = {}) {
    const canon = canonicalCommand(name);
    if (!canon) return `没有这个命令：/${String(name ?? '')}`;
    const fn = RUNNERS[canon];
    if (!fn) return `/${canon} 还没接上实现。`;
    const args = Array.isArray(msg?.args) ? msg.args.map((x) => String(x)) : [];
    /**
     * `raw` 是这条命令**后面的原文**：`msg.args` 已经被框架按空格切过，
     * 「记住 我今天买了辆车」这种带空格的内容拼回去会多一个空格，但至少不丢字。
     * 真正的原文在 `content` 里，做法是**剥掉开头「前缀+命令名」那一个 token**。
     *
     * 不能拿 `args[0]` 去 `lastIndexOf` 回切：`/remember a banana` 里第一个
     * 参数是 `a`，最后一个 `a` 落在 `banana` 中间，切出来是 `ana`——英文内容
     * 会静默丢字，比多一个空格严重得多。
     */
    const content = String(msg?.content ?? '');
    const rest = content.replace(/^\s*\S+[^\S\r\n]*/, '').trim();
    const raw = rest || args.join(' ');
    try {
      return await fn(msg, args, raw);
    } catch (e) {
      log(`命令 /${canon} 执行失败：${e?.message ?? e}`);
      return `/${canon} 没跑成：${String(e?.message ?? e).slice(0, 120)}`;
    }
  }

  return { run, specs: (opt = {}) => hostCommandSpecs({ prefix: P(), ...opt }) };
}
