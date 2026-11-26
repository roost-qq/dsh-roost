/**
 * 扩展作者引导：文档投放、话术生成、复制一份来改
 * ================================================
 *
 * 为什么单独一个文件：这三件事都是**纯文件/字符串操作**，和 host 的路由编排
 * 无关。放在 host 里只能靠「起一个真宿主 + mock webServer」才测得到，而它们的
 * 失败点全在细节上（漏排除 node_modules、忘删 `.source.json`、文档路径拼错），
 * 恰恰是最该单测的部分。
 *
 * 对照 aurabot 的 modules 目录做了两处**不照搬**：
 *   1. 它把文档写进每个模块目录；我们有多个扩展共用一份文档，写进扩展根目录
 *      （`<dataDir>/extensions/API.md`）就够，升级时也不会各留一个旧版本；
 *   2. 它有「内置模块」可 fork；我们没有内置扩展，所以 fork 的用途是
 *      「在市场装的基础上改一份」——因此必须删 `.source.json`，否则新目录会被
 *      当成市场资产，更新时拒绝覆盖。
 */
import { basename, join } from 'node:path';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, readdirSync, statSync,
} from 'node:fs';

import { MANIFEST_FILE, SOURCE_FILE } from './ext-registry.js';
import { SELF_REPO, GITEE_SELF_REPO } from './repo.js';

/** 随包投放的接口文档。`API.md` 由 `scripts/build-ext-docs.mjs` 从源码生成。 */
export const AUTHOR_DOCS = ['API.md', 'extension.d.ts'];
export const AUTHOR_GUIDE = '写一个扩展.md';

/**
 * 教程在线地址。**本仓是 dsh-roost，不是框架 qq-bot-roost。**
 *
 * 这份文档只在 dsh-roost 的 `docs/` 下，指向框架仓会 404；而两个 slug 长得
 * 几乎一样（`roost-qq/qq-bot-roost` vs `roost-qq/dsh-roost`），URL 不点开
 * 根本看不出错。所以走 `SELF_REPO` 常量，别在这里拼 owner。
 *
 * 两个远端都放：国内直连 GitHub 常失败，Gitee 是原生 Pull 镜像，内容同步。
 */
const GUIDE_BRANCH = 'main';
const GUIDE_PATH = `docs/${encodeURIComponent(AUTHOR_GUIDE)}`;
export const GUIDE_URL = `https://github.com/${SELF_REPO}/blob/${GUIDE_BRANCH}/${GUIDE_PATH}`;
export const GUIDE_URL_GITEE = `https://gitee.com/${GITEE_SELF_REPO}/blob/${GUIDE_BRANCH}/${GUIDE_PATH}`;

/**
 * 复制目录时跳过的名字。
 *
 * - `node_modules`：动辄几百 MB，用户装过一次就有，复制过去纯浪费；
 * - `deps`：宿主级共享依赖，复制会让两个扩展各持一份、版本分叉；
 * - `.git`：用户可能在自己的仓库里开发，复制过去会变成嵌套仓库；
 * - `docs`：旧版本残留的文档，新目录由 `plantAuthorDocs` 重新放一份。
 */
export const FORK_SKIP = new Set(['node_modules', '.git', 'deps', 'docs']);

/**
 * 把接口文档放到扩展根目录。内容没变就不写（每次点按钮都动盘没有必要，
 * 也会把用户的文件时间戳刷成「刚改过」）。
 *
 * @returns {string[]} 实际写出（或已是最新）的文件名
 */
export function plantAuthorDocs({
  extRoot, docsSrc, files = AUTHOR_DOCS, log = () => {},
} = {}) {
  const done = [];
  if (!extRoot || !docsSrc) return done;
  try {
    mkdirSync(extRoot, { recursive: true });
    for (const name of files) {
      const from = join(docsSrc, name);
      if (!existsSync(from)) continue;
      const to = join(extRoot, name);
      const body = readFileSync(from, 'utf8');
      if (!existsSync(to) || readFileSync(to, 'utf8') !== body) writeFileSync(to, body, 'utf8');
      done.push(name);
    }
  } catch (e) {
    /** 投放失败不该挡「复制话术」：文档读不到，DSH 还能去仓库里找 */
    log.warn?.(`扩展文档投放失败：${e?.message ?? e}`);
  }
  return done;
}

/**
 * 给 DSH 的一段话。
 *
 * 边界必须由宿主写：用户自己说「别动别的文件」容易漏，而 DSH 拿到一句
 * 「改这个扩展」很可能顺手去改宿主代码——那是另一份仓库，改坏了升级时
 * 会被覆盖，用户也找不到原因。
 */
export function authorPrompt({ dir, doc } = {}) {
  return `帮我写 / 改一个 dsh-roost 扩展：${dir ?? ''}\n`
    + `先完整读一遍 ${doc ?? ''}（清单字段、scope、端点、错误码都在里面），再按我的要求改：\n`
    + '【这里写你想让它多会什么、改成什么样】\n'
    + '只改这个目录里的文件，不要动 dsh-roost 宿主的代码；'
    + '改完告诉我怎么让它生效（改代码要重启 DSH 或重连 MCP，改设置的保存后等宿主重连），'
    + '再告诉我怎么试。';
}

/**
 * 整目录复制成一个新 id。
 *
 * 调用方负责「源存在 / 目标不存在 / id 合法」的校验——这里只做复制本身，
 * 失败时**把半份目标清掉**再抛：留一个「有 plugin.json 没 server.mjs」的目录，
 * 会让 `list()` 把它当清单不合格的扩展挂到面板顶部报红。
 *
 * @returns {{ files: number, manifest: object }}
 */
export function forkExtension({ from, to, newId, name, skip = FORK_SKIP } = {}) {
  if (!from || !to) throw new Error('fork 需要源目录与目标目录');
  cpSync(from, to, {
    recursive: true,
    filter: (p) => !skip.has(basename(p)),
  });
  try {
    const mf = join(to, MANIFEST_FILE);
    const m = JSON.parse(readFileSync(mf, 'utf8'));
    m.id = newId;
    /** serverName 必须等于 id，否则 DSH 那边的工具前缀会对不上 */
    m.serverName = newId;
    if (name) m.name = String(name).trim().slice(0, 64) || newId;
    /** 校验和盖的是旧内容，复制后必然不对；不清掉会永远显示「校验和无效」 */
    delete m.sha256;
    delete m.locallyModified;
    delete m.modifiedAt;
    writeFileSync(mf, `${JSON.stringify(m, null, 2)}\n`, 'utf8');
    /** 市场来源标记必须删：留着新目录会被当成市场资产，更新时拒绝覆盖用户改动 */
    rmSync(join(to, SOURCE_FILE), { force: true });
    return { files: countFiles(to), manifest: m };
  } catch (e) {
    try {
      rmSync(to, { recursive: true, force: true });
    } catch { /* 清不掉就留着，错误信息里带路径 */ }
    throw e;
  }
}

/** 目录里有多少个文件（给面板显示「复制了几个文件」，不递归进 node_modules） */
export function countFiles(dir) {
  try {
    if (!statSync(dir).isDirectory()) return 0;
    let n = 0;
    for (const ent of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (ent.isFile()) n += 1;
    }
    return n;
  } catch {
    return 0;
  }
}
