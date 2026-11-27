/**
 * 待确认别名队列：模型「猜」出来的身份对应，**先排队、主人确认后才写权威**。
 *
 * ## 为什么不能直接写
 *
 * 老数据里没有 `about`，只有显示名（`facts.meta.src.speaker` 与历史
 * `journal.sender`）。要按人清理，就得把「显示名 X」归到「QQ Y」上。但显示名
 * 会重名、会改名——直接猜着归户，等于**删错人**，比不删更糟。
 *
 * 所以分两步：模型/启发式只负责「提议」，进这张表；主人确认后才写进
 * `persons.aliases`，之后老数据迁移只认已确认的别名（宁漏不误）。
 *
 * ## 与结构化人设的关系
 *
 * 只做**身份别名**，不碰人设 schema。结构化人设的 `name` 只做展示，永不
 * 反过来当身份键——身份权威永远在 `persons[qq]`。
 */
import { readFileSync } from 'node:fs';

import { writeJsonAtomic } from './atomic.js';

export const PENDING_ALIAS_MAX = 200;
/** 同一条提议攒到几次才值得推给主人看（一次可能是模型幻觉） */
export const PENDING_ALIAS_MIN_HITS = 1;

function norm(x) {
  return String(x ?? '').trim().toLowerCase().replace(/^@+/, '');
}

export function createPendingAliases({
  file,
  max = PENDING_ALIAS_MAX,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  let rows = null;

  function load() {
    if (rows) return rows;
    let list = [];
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      list = Array.isArray(raw) ? raw : (Array.isArray(raw?.items) ? raw.items : []);
    } catch {
      list = [];
    }
    rows = list
      .filter((r) => r && norm(r.alias) && norm(r.person))
      .map((r) => ({
        alias: String(r.alias).trim(),
        person: String(r.person).trim(),
        hits: Number(r.hits) || 1,
        src: String(r.src || 'auto'),
        firstAt: Number(r.firstAt) || Number(r.at) || 0,
        lastAt: Number(r.lastAt) || Number(r.at) || 0,
      }));
    return rows;
  }

  function save() {
    try {
      const all = load().slice(-max);
      rows = all;
      writeJsonAtomic(file, { items: all }, { indent: 0 });
    } catch (e) {
      log(`写待确认别名失败（不影响聊天）：${e.message}`);
    }
  }

  function find(alias) {
    const a = norm(alias);
    return load().find((r) => norm(r.alias) === a && !r.done) || null;
  }

  return {
    /**
     * 记一次提议。同一个别名指向同一个人的多次提议只累加 hits；
     * 指向**不同**人则各记一条（冲突留给主人裁决，不自动挑一个）。
     */
    see({ alias = '', person = '', src = 'auto' } = {}) {
      const a = String(alias ?? '').trim();
      const p = String(person ?? '').trim();
      if (!a || !p) return null;
      if (norm(a) === norm(p)) return null;
      const all = load();
      const cur = all.find((r) => norm(r.alias) === norm(a) && norm(r.person) === norm(p));
      if (cur) {
        cur.hits += 1;
        cur.lastAt = now();
        save();
        return { ...cur };
      }
      const row = { alias: a, person: p, hits: 1, src: String(src || 'auto'), firstAt: now(), lastAt: now() };
      all.push(row);
      save();
      return { ...row };
    },

    /** 待确认清单：先按 hits 降序（多次提到更可信），再看最近 */
    list({ minHits = PENDING_ALIAS_MIN_HITS, limit = 0 } = {}) {
      const all = load().filter((r) => !r.done && r.hits >= minHits);
      all.sort((a, b) => (b.hits - a.hits) || (b.lastAt - a.lastAt));
      return (limit > 0 ? all.slice(0, limit) : all).map((r) => ({ ...r }));
    },

    /** 确认一条：**出队并返回**，由调用方写 `persons.addAlias`（本模块不越权） */
    confirm(alias, person = '') {
      const row = person
        ? load().find((r) => norm(r.alias) === norm(alias) && norm(r.person) === norm(person))
        : find(alias);
      if (!row) return null;
      rows = load().filter((r) => r !== row);
      save();
      return { ...row };
    },

    /** 忽略一条：删掉，且记住「别再提」——同名同人的再次提议不再入队 */
    ignore(alias, person = '') {
      const row = person
        ? load().find((r) => norm(r.alias) === norm(alias) && norm(r.person) === norm(person))
        : find(alias);
      if (!row) return false;
      rows = load().filter((r) => r !== row);
      save();
      return true;
    },

    get(alias) {
      const row = find(alias);
      return row ? { ...row } : null;
    },

    clear() {
      rows = [];
      save();
    },

    get size() {
      return load().filter((r) => !r.done).length;
    },
  };
}
