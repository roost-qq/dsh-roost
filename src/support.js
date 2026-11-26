/**
 * 问题反馈：常见问题切片、日志路径、诊断信息
 * ============================================
 *
 * 为什么单独一个文件：这些都是**纯字符串 / 纯路径**操作，失败点全在边界上
 * （FAQ 章节不存在、某一级标题改了、框架没装、DSH 从没崩过）。放在 host 里
 * 只能靠起真宿主才测得到，而它们恰恰最该单测。
 *
 * 三条设计约束：
 *   1. **不猜路径**：框架日志来自 `setup.detect()` 的 `dir`；DSH 本体日志按
 *      平台各给几个候选、以磁盘上真实存在的那个为准，返回候选清单供 UI 说明。
 *   2. **不读大文件**：框架日志是另一个进程的大文件，面板硬读会卡住 UI；
 *      这里只给路径 + 打开目录（见 `tailFile` 只用于小体积的尾部）。
 *   3. **脱敏在调用方**：`readTail` 原样返回文本，host 出路前统一过 `redactText`。
 *      本模块不 import redact，避免测试为了一个正则去拖整条依赖链。
 */
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { SELF_REPO, GITEE_SELF_REPO, FW_REPO, GITEE_FW_REPO } from './repo.js';

/** 交流反馈群。前端「更新」页与「关于」页也读这一份，别再各写一个字符串 */
export const GROUP_ID = '1130901545';

/**
 * 文档站点根。README 里的相对链接（`docs/USER-MANUAL.md`）要拼到这里，
 * 否则在面板里点开就是 `http://127.0.0.1:<端口>/docs/...` —— 404。
 * 指向 GitHub 而不是 Gitee：GitHub 是主仓，两边文档内容一样，
 * 打不开时 §01 底部另给了 Gitee 入口。
 */
const DOC_ROOT = `https://github.com/${SELF_REPO}`;

/**
 * 仓库地址。
 *
 * **issue 只收 GitHub**：Gitee 是 pull 镜像，维护者只在 GitHub 看 issue。
 * 在镜像上给一个「去这里提」的入口，等于把反馈扔进没人看的桶里，用户还以为
 * 提过了。FAQ 仍然两站都给——国内直连 GitHub 常常失败，至少要能看文档。
 */
export const LINKS = {
  github: {
    repo: `https://github.com/${SELF_REPO}`,
    issues: `https://github.com/${SELF_REPO}/issues/new`,
    faq: `https://github.com/${SELF_REPO}/blob/main/README.md#%E5%B8%B8%E8%A7%81%E9%97%AE%E9%A2%98`,
    framework: `https://github.com/${FW_REPO}`,
  },
  gitee: {
    repo: `https://gitee.com/${GITEE_SELF_REPO}`,
    faq: `https://gitee.com/${GITEE_SELF_REPO}/blob/main/README.md#%E5%B8%B8%E8%A7%81%E9%97%AE%E9%A2%98`,
    framework: `https://gitee.com/${GITEE_FW_REPO}`,
  },
};

/** 面板日志只存在内存里（环形 400 条），文案和 `src/host.js` 的上限必须一致 */
export const PANEL_LOG_MAX = 400;

/** FAQ 章节标题。README 改名时锚点会静默失效，测试里钉住这一行存在 */
export const FAQ_HEADING = '## 常见问题';

/**
 * 从 README 里切出「常见问题」章节，并顺手拆成问答条目。
 *
 * 为什么拆：README 用的是 `<details><summary>`，直接塞进 `<pre>` 会把标签
 * 原样显示出来，用户读到的是 `<details>` 而不是问题。
 *
 * @returns {{ ok: boolean, text: string, items: Array<{q: string, a: string}> }}
 */
/**
 * 把 README 里的相对链接改成绝对地址。
 *
 * 面板是 webview，FAQ 里那句「详见 [手册 · 表情包](docs/USER-MANUAL.md#表情包)」
 * 直接给会变成 `http://127.0.0.1:<端口>/docs/USER-MANUAL.md` —— 宿主不 serve
 * 那个路径，用户点开是 404。指着「看文档」却把人送到死链，比不给链接更糟。
 *
 * 只动 `](…)` 形式的行内链接；`http(s)` 与 `mailto` 原样。
 */
function absolutizeLinks(md, base = `${DOC_ROOT}/blob/main`) {
  return String(md ?? '').replace(/\]\(([^)\s]+)\)/g, (whole, href) => {
    if (/^(https?:|mailto:)/i.test(href)) return whole;
    /** 纯锚点指的是 README 自己那一节 */
    if (href.startsWith('#')) return `](${DOC_ROOT}/blob/main/README.md${href})`;
    return `](${base}/${href.replace(/^\.?\//, '')})`;
  });
}

export function faqSlice(markdown) {
  const md = String(markdown ?? '');
  const start = md.indexOf(FAQ_HEADING);
  if (start < 0) return { ok: false, text: '', items: [] };

  const from = start + FAQ_HEADING.length;
  /** 到下一个二级标题为止；没有下一个就到文件尾 */
  const rest = md.slice(from);
  const next = rest.search(/^## /m);
  const text = absolutizeLinks((next < 0 ? rest : rest.slice(0, next)).trim());

  const items = [];
  const re = /<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi;
  let m;
  while ((m = re.exec(text))) {
    const q = m[1].replace(/\s+/g, ' ').trim();
    const a = m[2].replace(/^\s+|\s+$/g, '');
    if (q) items.push({ q, a });
  }
  return { ok: true, text, items };
}

/**
 * DSH 本体日志目录候选（按可靠性排序）。
 *
 * DSH 桌面端是 Electron：`app.getPath('logs')` 在 Windows 是
 * `%APPDATA%\<appName>\logs`，macOS 是 `~/Library/Logs\<appName>`，
 * Linux 是 `~/.config\<appName>\logs`；appName 带 scope，所以是
 * `@deepseek-ai/dsh-desktop` 两层目录（本机实测 Windows 成立）。
 *
 * 不同版本 / CLI 安装可能落在别处，所以给多个候选，再由 `dshLogInfo`
 * 挑磁盘上真实存在的那个——猜错时 UI 至少能说「没找到，去这里找」。
 */
export function dshLogDirs({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  const out = [];
  if (env.DSH_LOG_DIR) out.push(env.DSH_LOG_DIR);
  const app = ['@deepseek-ai', 'dsh-desktop'];
  if (platform === 'win32') {
    if (env.APPDATA) out.push(join(env.APPDATA, ...app, 'logs'));
    if (env.LOCALAPPDATA) out.push(join(env.LOCALAPPDATA, ...app, 'logs'));
    /* CLI / 老版本兜底 */
    out.push(join(home, '.dsh', 'logs'));
  } else if (platform === 'darwin') {
    out.push(join(home, 'Library', 'Logs', ...app));
    out.push(join(home, 'Library', 'Logs', 'dsh-desktop'));
    out.push(join(home, 'Library', 'Application Support', ...app, 'logs'));
  } else {
    const cfg = env.XDG_CONFIG_HOME || join(home, '.config');
    out.push(join(cfg, ...app, 'logs'));
    out.push(join(home, '.config', 'dsh-desktop', 'logs'));
    out.push(join(home, '.dsh', 'logs'));
  }
  /** 去重但保序：候选顺序就是「先试哪个」 */
  return [...new Set(out.filter(Boolean))];
}

/** 目录里最近的几个 `.log` 文件（DSH 只在崩溃时写，所以常常是空目录） */
export function listLogFiles(dir, { limit = 5 } = {}) {
  if (!dir) return [];
  try {
    if (!statSync(dir).isDirectory()) return [];
    const files = [];
    for (const name of readdirSync(dir)) {
      if (!/\.log$/i.test(name)) continue;
      try {
        const s = statSync(join(dir, name));
        if (!s.isFile()) continue;
        files.push({ name, size: s.size, mtime: s.mtimeMs });
      } catch { /* 读完就删了：跳过 */ }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    return files.slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * DSH 本体日志：找到**真实存在**的目录，给出最近文件。
 *
 * `exists` 指目录存在；`latest` 指最近一条记录（崩溃日志）。
 * 从没崩过 = 目录空 = `latest: null`，这是正常状态，UI 不该报红。
 */
export function dshLogInfo(opts = {}) {
  const candidates = dshLogDirs(opts);
  let fallback = null;
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    const files = listLogFiles(dir);
    if (files.length) return { dir, exists: true, files, latest: files[0], candidates };
    if (!fallback) fallback = { dir, exists: true, files: [], latest: null, candidates };
  }
  return fallback || { dir: candidates[0] || '', exists: false, files: [], latest: null, candidates };
}

/**
 * 框架日志路径。
 *
 * `installed` 不只看「有没有配目录」：`setup` 在路径配错时也会回一个非空
 * `dir`（「配置的路径不是一份 Roost」），那时不该告诉用户「已装、去看日志」。
 * 判据与 `setup.js` 的 `looksLikeRoost` 一致：有 `src/main.js` 才算。
 */
export function frameworkLogInfo(fwDir) {
  const dir = String(fwDir || '');
  const installed = Boolean(dir) && existsSync(join(dir, 'src', 'main.js'));
  if (!installed) {
    return { installed: false, dir, path: '', logsDir: '', exists: false };
  }
  const logsDir = join(dir, 'logs');
  const path = join(logsDir, 'bot.log');
  return { installed: true, dir, path, logsDir, exists: existsSync(path) };
}

/**
 * 读文件尾部。
 *
 * 只按字节读末尾一段，不 `readFileSync` 整个文件：`bot.log` 可能有几十 MB，
 * 面板点一下「看看日志」不该把整个进程卡住。
 *
 * @returns {{ ok: boolean, text: string, truncated: boolean, size: number }}
 */
export function readTail(file, { maxBytes = 32 * 1024, maxLines = 120 } = {}) {
  try {
    const st = statSync(file);
    if (!st.isFile()) return { ok: false, text: '', truncated: false, size: 0 };
    const len = Math.min(st.size, maxBytes);
    const start = st.size - len;
    const buf = Buffer.alloc(len);
    const fd = openSync(file, 'r');
    try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
    let text = buf.toString('utf8');
    /** 从文件中间开始时，第一行多半是半截——丢掉，免得看起来像乱码 */
    if (start > 0) {
      const nl = text.indexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1);
    }
    let lines = text.split(/\r?\n/);
    const truncated = start > 0 || lines.length > maxLines;
    if (lines.length > maxLines) lines = lines.slice(-maxLines);
    return { ok: true, text: lines.join('\n').trim(), truncated, size: st.size };
  } catch {
    return { ok: false, text: '', truncated: false, size: 0 };
  }
}

/** 各平台「在文件管理器里打开目录」的命令 */
export function openCmd(platform = process.platform) {
  if (platform === 'win32') return 'explorer';
  if (platform === 'darwin') return 'open';
  return 'xdg-open';
}

/** 体积给人看 */
export function sizeText(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 面板环形日志里最近的几条 error，**时间倒序**（最新在最前）。
 *
 * 弹窗只放 3 条：用户要的是「刚才到底报了什么」，不是翻阅历史。
 * 全量在 `/logs` 页和导出的诊断包里都有。
 */
export function pickRecent(entries, level, limit = 3) {
  const list = Array.isArray(entries) ? entries : [];
  const hit = list.filter((e) => e && e.level === level);
  return hit.slice(-limit).reverse();
}

/** 日志一行的样子：`[03:00:28] error inbound：xxx`，多行正文缩进续行 */
export function formatEntry(e) {
  const time = String(e?.time || '--:--:--');
  const level = String(e?.level || 'info').toUpperCase();
  const area = String(e?.area || '');
  const text = String(e?.text ?? '').replace(/\r/g, '');
  const head = `[${time}] ${level}${area ? ' ' + area : ''}：`;
  return head + text.replace(/\n/g, '\n' + ' '.repeat(head.length));
}

/**
 * 诊断包文件名。
 *
 * **用本地时间、全数字**：`toISOString()` 是 UTC（中国用户看到早上 8 点会以为
 * 文件是错的），而 `:` 在 Windows 文件名里非法，直接写 ISO 会出现一个存不下去
 * 的文件名。所以自己拼成 `support-20261127-030028.txt`。
 */
export function bundleName(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `support-${stamp}.txt`;
}

/**
 * 诊断包正文：环境 + 最近 error + 全量面板日志。
 *
 * 为什么还要「导出一个文件」而不是只复制文本：群里一次最长只能贴几百字，
 * 而排查「不回消息」往往要看几十行上下文。文件可以直接拖进群。
 *
 * 顺序是刻意的——**最要紧的在最上面**：群友点开文件先看到版本和最近 error，
 * 不用滚到几千行日志里找。
 */
export function bundleText({ diagnostics = '', entries = [], now = new Date(), note = '' } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const errs = pickRecent(list, 'error', 5);
  const warnCount = list.filter((e) => e && e.level === 'warn').length;
  const errCount = list.filter((e) => e && e.level === 'error').length;
  const line = '─'.repeat(56);
  const time = now instanceof Date && !Number.isNaN(now.getTime())
    ? now.toLocaleString('zh-CN', { hour12: false })
    : '';

  const out = [
    'dsh-roost 诊断包',
    `生成时间：${time}`,
    '',
    line,
    '[环境]',
    diagnostics.trim() || '（环境信息没读到）',
    /** 只说分布：条数下面是「共 N 条」，环境段里也已经有「内存里 N/400」 */
    `日志统计：error ${errCount} / warn ${warnCount}`,
    '',
    line,
    errs.length ? `[最近 error]（最多 5 条，最新在前）` : '[最近 error]',
    errs.length ? errs.map(formatEntry).join('\n') : '没有 error —— 这说明不是面板自己报的错，多半在框架侧。',
    '',
    line,
    `[面板日志] 共 ${list.length} 条，时间正序`,
    list.length ? list.map(formatEntry).join('\n') : '（空：插件刚启动，或日志被清过）',
    '',
    line,
    '这份文件可以直接拖进反馈群或贴在 issue 里。',
    '注意：其中含本机路径（可能有用户名），发出去前看一眼。',
  ];
  if (note) out.push(note);
  return out.join('\n') + '\n';
}

/**
 * 框架网页面板的「日志」页地址。
 *
 * 面板是 SPA，路由全在 hash 上（`location.hash.slice(1)` → `activateTab`，
 * 日志页是 `#tab-logs`），所以 `#logs` 必须拼在**最末尾**——拼到 `?key=` 前面
 * 会变成 query 值的一部分，点开是首页而不是日志。
 *
 * `webui` 由 `setup.detect()` 给（已带 `?key=`，没有密钥时就是裸地址）。
 * 空值 = 没装或没读到配置，返回空串让调用方决定怎么说。
 */
export function frameworkWebUrl(webui) {
  const s = String(webui || '').trim();
  if (!s) return '';
  /** 先去掉可能已有的 hash，避免拼出 `#x#logs` */
  return `${s.replace(/#.*$/, '')}#logs`;
}

/**
 * 给群里贴的一段话。
 *
 * 群里最常见的一轮往返就是「你什么版本 / 哪个系统 / 日志在哪」，一次说完。
 * **含本机路径（有用户名）**，UI 上必须提示「发出去前看一眼」——不自动打码：
 * 打掉用户名后开发者反而判断不了路径问题（空格、中文目录、盘符）。
 */
export function diagnosticsText(info = {}) {
  const {
    version = '', frameworkVersion = '', frameworkRunning = false,
    platform = '', arch = '', node = '', dataDir = '',
    activate = {}, dsh = {}, framework = {}, panelCount = 0,
  } = info;
  const yes = (b) => (b ? '有' : '无');
  const rows = [
    `dsh-roost ${version || '?'} · 框架 ${frameworkVersion || '未装'}${frameworkRunning ? '（运行中）' : ''}`,
    `${platform || '?'} ${arch || ''} · node ${node || '?'}`,
    `数据目录：${dataDir || '?'}`,
    `面板日志：内存里 ${panelCount}/${PANEL_LOG_MAX} 条（不落盘）`,
    `dsh-roost 出错记录：${yes(activate.exists)}${activate.exists ? `（${sizeText(activate.size)}）` : ''}${activate.path ? ` ${activate.path}` : ''}`,
    `DSH 本体日志：${dsh.dir || '未找到'}${dsh.latest ? `（最近 ${dsh.latest.name}）` : '（没有崩溃记录）'}`,
    `框架日志：${framework.path || '未装框架'}${framework.exists ? '（存在）' : ''}`,
    `反馈群：${GROUP_ID}`,
  ];
  return rows.join('\n');
}
