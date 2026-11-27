/**
 * 反馈弹窗的「恢复默认 / 清除数据」：纯计划函数
 * =============================================
 *
 * 危险操作的规则都在这里，不散落在路由里：
 *   - 恢复默认：按 DEFAULTS 重建，只把「恢复完不能当场失联」的字段搬回来；
 *   - 清除数据：**不删除**，把白名单里的条目 rename 到 backups/ 下；
 *   - 路径护栏：数据目录被人改成 `/`、`~`、盘符根时一律拒绝。
 *
 * 为什么清数据用「挪走」而不是 `rmSync`：
 *   DSH 还活着，journal.sqlite 正被占用，Windows 上直接删会删一半留一半。
 *   rename 是整目录/整文件的原子动作；挪不动就报哪几个没挪成，用户退出 DSH
 *   再点一次即可，绝不出现「一半数据没了」。
 */

import { basename, join, parse, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

/** 恢复 dsh-roost 设置时要保住的字段：连接引导 + 凭证 */
export const RESET_KEEP_PATHS = [
  ['setup', 'roostDir'],
  ['setup', 'wizardVersion'],
  ['setup', 'wizardSkippedVersion'],
  ['server', 'port'],
  ['server', 'token'],
  ['roostHost', 'enabled'],
  ['roostHost', 'url'],
  ['roostHost', 'token'],
];

function getAt(root, path) {
  return path.reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), root);
}
function setAt(root, path, value) {
  let node = root;
  for (const k of path.slice(0, -1)) {
    if (!node[k] || typeof node[k] !== 'object' || Array.isArray(node[k])) node[k] = {};
    node = node[k];
  }
  node[path.at(-1)] = value;
}

/**
 * 重建 dsh-roost 配置。DEFAULTS 里大量嵌套对象是共享引用，必须深拷贝。
 * @param {object} current 当前配置原文
 * @param {object} defaults config.js 的 DEFAULTS（注入，便于单测）
 */
export function resetDshSettings(current = {}, defaults = {}, keep = RESET_KEEP_PATHS) {
  const next = structuredClone(defaults);
  for (const p of keep) {
    const v = getAt(current, p);
    /** 空串 / undefined 不搬：留空就是让向导重新带她走一遍 */
    /** `******` 是面板掩码，不是凭证；搬回去会被 saveConfig 当成「请沿用旧值」 */
    if (v === undefined || v === null || v === '' || v === '******') continue;
    /** 端口 0 / 越界值是坏配置，恢复默认时不该把它原样搬回去 */
    if (p.at(-1) === 'port' && (!Number.isInteger(v) || v < 1 || v > 65535)) continue;
    setAt(next, p, structuredClone(v));
  }
  return next;
}

/** 数据目录白名单：这些是「她记住的东西」，删了就是失忆 */
export const DSH_CLEAR_NAMES = Object.freeze([
  'memory.json', 'memory.json.prev', 'journal.sqlite', 'journal.sqlite-wal', 'journal.sqlite-shm',
  'graph.sqlite', 'graph.sqlite-wal', 'graph.sqlite-shm', 'audit.log', 'audit.log.prev',
  'sessions.json', 'agent-sessions.json', 'purpose-state.json', 'purpose-state.json.prev',
  'self.json', 'profile-history.json', 'mood.json', 'mood-history.json', 'awake.json',
  'gap-mark.json', 'recall-log.json', 'channel-posts.json', 'closing.json', 'nudge.json',
  'speakup.json', 'mind-model.json', 'ext-proactive.json', 'ext-rejections.jsonl',
  'feedback.json', 'feedback-events.jsonl', 'autotelic-skills', 'consolidate-progress.json',
  'avatars', 'gallery', 'images', 'stickers', 'ext-memory',
]);

/** 这些**绝不能**挪走：config=设置、secrets/凭证、personas/extensions=装的东西、onnx=运行依赖 */
export const DSH_KEEP_NAMES = Object.freeze([
  'config.json', 'secrets', 'personas', 'extensions', 'deps', 'onnx-models', 'onnx-runtime',
  'backups', '_backup', 'config', 'plugins', 'logs',
]);

/**
 * 框架 data/ 下的保留项。
 *
 * 不能按「data/ 下全清」实现：有的框架目录里 data/ 也放程序资源 / 备份 /
 * 凭证，清掉等于把「清数据」变成「卸掉半套程序」。与 DSH 侧同口径：
 * 只有「她记住的东西」才清，其余原样留。
 */
export const FW_BACKUP_DIR = '_backup';
export const FW_KEEP_NAMES = Object.freeze([
  FW_BACKUP_DIR, 'backups', 'config', 'config.json', 'secrets',
  'onnx-models', 'onnx-runtime', 'deps', 'plugins', 'logs',
]);

/** 目录护栏：root / home / 当前盘根一律不许当清理根 */
export function safeRoot(dir) {
  const raw = String(dir || '').trim();
  if (!raw) return false;
  let abs;
  try { abs = resolve(raw); } catch { return false; }
  const parsed = parse(abs);
  if (abs === parsed.root || abs === homedir()) return false;
  if (!basename(abs) || abs.endsWith(sep)) return false;
  /** Windows 盘符根 `C:\` 上面已经拦了；这里再挡住 `C:\Users` 这种公共父目录 */
  if (abs === resolve(homedir(), '..')) return false;
  return true;
}

/**
 * 生成清理计划。不碰文件系统，只算「从哪挪到哪」。
 *
 * @param {object} o
 * @param {'dsh'|'framework'|'both'} o.side
 * @param {string} o.dshDir  dsh-roost 数据目录
 * @param {string} o.fwDir   框架安装目录
 * @param {string[]} [o.fwDataNames] 框架 data/ 下实际存在的条目名
 * @param {string} [o.stamp] 备份子目录名（两边共用同一个时间戳）
 * @returns {{ok:boolean, reason?:string, stamp:string, jobs:Array<{from:string,to:string,side:string}>, kept:string[]}}
 */
export function clearDataPlan({ side = '', dshDir = '', fwDir = '', fwDataNames = [], stamp = '' } = {}) {
  if (!['dsh', 'framework', 'both'].includes(side)) {
    return { ok: false, reason: 'side', stamp: '', jobs: [], kept: [] };
  }
  const s = String(stamp || '').trim() || 'manual';
  const jobs = [];
  const kept = [];

  if (side === 'dsh' || side === 'both') {
    if (!safeRoot(dshDir)) return { ok: false, reason: 'dsh-dir', stamp: s, jobs: [], kept: [] };
    const root = resolve(dshDir);
    const backup = join(root, 'backups', s);
    for (const name of DSH_CLEAR_NAMES) {
      jobs.push({ from: join(root, name), to: join(backup, name), side: 'dsh' });
    }
    kept.push(...DSH_KEEP_NAMES);
  }

  if (side === 'framework' || side === 'both') {
    if (!safeRoot(fwDir)) return { ok: false, reason: 'framework-dir', stamp: s, jobs: [], kept: [] };
    const root = resolve(fwDir);
    const dataRoot = join(root, 'data');
    const backup = join(dataRoot, FW_BACKUP_DIR, s);
    const names = Array.isArray(fwDataNames) ? fwDataNames : [];
    for (const name of names) {
      /** 隐藏文件 / 目录穿越形状的条目一律不碰 */
      if (!name || name === '.' || name === '..' || name.startsWith('.') || /[\\/]/.test(name)) continue;
      if (FW_KEEP_NAMES.includes(name)) continue;
      jobs.push({ from: join(dataRoot, name), to: join(backup, name), side: 'framework' });
    }
    kept.push(...FW_KEEP_NAMES);
  }

  return { ok: true, stamp: s, jobs, kept };
}

/** 备份目录名：全数字时间戳，Windows 文件名安全；同秒重复点加序号由调用方处理 */
export function backupStamp(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const d = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  return `clear-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
