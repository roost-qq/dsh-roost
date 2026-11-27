/**
 * 人物身份基座：把「一个人」从**显示名**提升为**稳定 id**。
 *
 * ## 为什么必须独立成一层
 *
 * 按人遗忘的前提是「能确定这条数据属于谁」。我方现状是三层身份各说各话：
 *   - `profiles.key` 是 openid 优先、否则显示名（`canonicalKey`）；
 *   - `journal.sender` 历史存的是**显示名**（`journal-bridge.js`）；
 *   - `facts.meta.src.speaker` 也是显示名，且不是每条都有。
 *
 * 显示名会改名、会重名。拿显示名当删除条件 = 删错人。所以这里建一份
 * **权威身份表**，其余各层只做「打标引用」：
 *   - `id`：稳定键（QQ 号优先，其次 openid，最后才退回显示名）；
 *   - `names`：见过的显示名（只用于展示与老数据归属，**不当身份键**）；
 *   - `aliases`：主人确认过的别名（`pending-aliases` 确认后才进这里）；
 *   - `noMemory` / `noMemoryAt`：不再记住的权威标记（profiles 里的同名标记
 *     降级为镜像，仅用于老面板回显）；
 *   - `forgetVersion`：每次遗忘操作 +1，用来挡住**在途写入把旧记忆写回**。
 *
 * ## 默认行为零变化
 *
 * 本模块是纯旁挂：没人调它就一个字都不写。`remembers()` 在没有记录、没有
 * 标记时一律返回 `true`——老库、新库、空库行为完全一致。
 *
 * ## 重启/换号
 *
 * openid 每个 AppID 一套，换机器人全变。所以 `qq` 一旦写进来就永远是首选 id：
 * 同一 qq 的新 openid 会作为 `aliases` 挂到同一条记录上，不会裂成两个人。
 */
import { readFileSync } from 'node:fs';

import { writeJsonAtomic } from './atomic.js';

export const PERSONS_SCHEMA_VERSION = 1;
/** 一人最多记多少个历史显示名（够覆盖改名 + 换号；再多就是噪声） */
export const NAMES_MAX = 8;
export const ALIASES_MAX = 12;

function norm(x) {
  return String(x ?? '').trim().toLowerCase().replace(/^@+/, '');
}

function uniqPush(arr, val, max) {
  const v = String(val ?? '').trim();
  if (!v) return arr;
  const list = Array.isArray(arr) ? arr : [];
  const i = list.findIndex((x) => norm(x) === norm(v));
  if (i >= 0) {
    /** 已存在：保留原大小写，但挪到末尾表示「最近还在用」 */
    list.splice(i, 1);
  }
  list.push(v);
  while (list.length > max) list.shift();
  return list;
}

export function createPersons({
  file,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  let rows = null;

  function blank() {
    return { schemaVersion: PERSONS_SCHEMA_VERSION, persons: {} };
  }

  function load() {
    if (rows) return rows;
    let raw = null;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      raw = null;
    }
    const map = raw?.persons && typeof raw.persons === 'object' ? raw.persons : {};
    const out = {};
    for (const [k, v] of Object.entries(map)) {
      if (!v || typeof v !== 'object') continue;
      const id = norm(v.id || k);
      if (!id) continue;
      out[id] = {
        ...v,
        id,
        names: Array.isArray(v.names) ? v.names.filter(Boolean) : [],
        aliases: Array.isArray(v.aliases) ? v.aliases.filter(Boolean) : [],
        noMemory: Boolean(v.noMemory),
        forgetVersion: Number(v.forgetVersion) || 0,
      };
    }
    rows = out;
    return rows;
  }

  function save() {
    try {
      const data = load();
      const persons = {};
      for (const [k, v] of Object.entries(data)) {
        /** 空壳（既没名字也没别名、没标记）不落盘，别把 random id 攒成垃圾 */
        const husk = !v.names?.length && !v.aliases?.length && !v.noMemory && !v.qq;
        if (husk) continue;
        persons[k] = v;
      }
      writeJsonAtomic(file, { schemaVersion: PERSONS_SCHEMA_VERSION, persons }, { indent: 0 });
    } catch (e) {
      log(`写人物身份表失败（不影响聊天）：${e.message}`);
    }
  }

  /** 按 id / 别名 / 显示名找记录。找不到返回 null（**不自动建**，避免读操作写盘） */
  function find(x) {
    const q = norm(x);
    if (!q) return null;
    const all = load();
    if (all[q]) return all[q];
    for (const row of Object.values(all)) {
      if (row.qq && norm(row.qq) === q) return row;
      if (row.aliases.some((a) => norm(a) === q)) return row;
      if (row.names.some((n) => norm(n) === q)) return row;
    }
    return null;
  }

  /** 找或建：写入路径才用（`see` / `setNoMemory` / `bumpForgetVersion`） */
  function ensure(x, extra = {}) {
    const q = norm(x);
    if (!q) return null;
    const hit = find(q);
    if (hit) return hit;
    const row = {
      id: q,
      qq: String(extra.qq || '').trim(),
      names: [],
      aliases: [],
      noMemory: false,
      forgetVersion: 0,
      at: now(),
    };
    load()[q] = row;
    return row;
  }

  return {
    /** 只读查询（不写盘） */
    get(x) {
      const row = find(x);
      return row ? { ...row } : null;
    },

    all() {
      return Object.values(load()).map((r) => ({ ...r }));
    },

    /**
     * 这个人现在「还记不记得」。
     *
     * 默认 `true`：没有记录、没有标记、老库，全部照常记住——这是「默认行为
     * 零变化」的落点。只有显式 `noMemory` 才返回 `false`。
     *
     * 主人的豁免不在这里做：`isOwner` 是会话侧概念（`bucketOf`），放进来会让
     * 本模块依赖消息结构。调用方自己判，见 `host.js` 的 `remembersPerson()`。
     */
    remembers(x) {
      const row = find(x);
      return !row?.noMemory;
    },

    /** 登记「见过这个人」：写名字/QQ，不建 noMemory。返回记录快照 */
    see(x, { name = '', qq = '', alias = '' } = {}) {
      const q = norm(x);
      if (!q) return null;
      let row = find(q);
      /**
       * 同一个 QQ 换了 openid：不能再建一条，否则「按 qq 设的遗忘标记」只命中
       * 老记录，新 openid 照样记得——换机器人后遗忘失效。把新 openid 当成这条
       * 记录的别名挂上去（`find()` 会按别名命中）。
       */
      if (!row && qq) {
        row = Object.values(load()).find((r) => r.qq && norm(r.qq) === norm(qq)) || null;
        if (row) row.aliases = uniqPush(row.aliases, q, ALIASES_MAX);
      }
      if (!row) row = ensure(q, { qq });
      if (!row) return null;
      if (qq && !row.qq) row.qq = String(qq).trim();
      if (name) row.names = uniqPush(row.names, name, NAMES_MAX);
      if (alias) row.aliases = uniqPush(row.aliases, alias, ALIASES_MAX);
      row.at = now();
      save();
      return { ...row };
    },

    /**
     * 挂一个**已确认**的别名（`pending-aliases` 确认后调）。
     * 只写 aliases，不写 names——两者用途不同：names 是「见过这么叫」，
     * aliases 是「确认就是这个人」，老数据补 about 只认后者（宁漏不误）。
     */
    addAlias(x, alias) {
      const row = ensure(x);
      if (!row || !String(alias ?? '').trim()) return null;
      row.aliases = uniqPush(row.aliases, alias, ALIASES_MAX);
      row.at = now();
      save();
      return { ...row };
    },

    /**
     * 不再记住 / 恢复记住。返回 `{ ok, row }`。
     * 重复设同一个值不算失败（幂等），但不刷新 `noMemoryAt`。
     */
    setNoMemory(x, enabled = true, { by = 'owner' } = {}) {
      const row = ensure(x);
      if (!row) return { ok: false, row: null };
      const want = Boolean(enabled);
      if (row.noMemory !== want) {
        row.noMemory = want;
        if (want) {
          row.noMemoryAt = now();
          row.noMemoryBy = String(by || 'owner');
        } else {
          delete row.noMemoryAt;
          delete row.noMemoryBy;
        }
        row.at = now();
        save();
      }
      return { ok: true, row: { ...row } };
    },

    /**
     * 遗忘版本号：**在途写入的护栏**。
     *
     * 巩固/提炼是异步的：它开工时读到一批记忆，写完前用户可能已经点了遗忘。
     * 开工时记下 `forgetVersion`，落盘前再读一次，不一致就整批丢弃——否则
     * 「刚删干净，下一分钟又被旧结果写回来」。对齐 aurabot 的 `forgetVersion`。
     */
    forgetVersionOf(x) {
      return Number(find(x)?.forgetVersion) || 0;
    },

    bumpForgetVersion(x) {
      const row = ensure(x);
      if (!row) return 0;
      row.forgetVersion = (Number(row.forgetVersion) || 0) + 1;
      row.at = now();
      save();
      return row.forgetVersion;
    },

    /** 这个人所有「可能出现在文本里的名字」，注入侧过滤用（G4） */
    namesOf(x) {
      const row = find(x);
      if (!row) return [];
      const out = [];
      for (const n of [...(row.aliases || []), ...(row.names || [])]) {
        const v = String(n || '').trim();
        if (v && !out.some((o) => norm(o) === norm(v))) out.push(v);
      }
      return out;
    },

    get size() {
      return Object.keys(load()).length;
    },
  };
}
