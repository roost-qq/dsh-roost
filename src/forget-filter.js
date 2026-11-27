/**
 * 遗忘闸门：把「这个人已经不再记住」翻译成**各处读路径都能用的一句话判断**。
 *
 * ## 为什么需要一层专门的过滤器
 *
 * 只在一个地方挡住等于没挡。实测审计里最容易漏的三处：
 *   - facts 浅注入（`listRanked`）挡住了，deep 派生块（`listFull`）还在；
 *   - 档案段挡住了，`memory` 里「小明爱打游戏」照样被搜出来；
 *   - 日记按人失效了，图谱 `A—朋友→小明` 还在 prompt 里。
 *
 * 所以判定收口在这里，memory / graph / journal / profiles 共用同一份名单。
 *
 * ## 两种命中条件（都要，缺一不可）
 *
 * 1. **`about` 命中**：新数据写入时就有归属，精确、零误伤。
 * 2. **名字命中**：老数据没有 `about`（迁移刻意不猜），只能按**确认过的名字**
 *    匹配文本。这是「事实上的断链」：不再把提到这个人的内容翻出来。
 *    为防误伤，单字名一律不参与（`MIN_NAME_LEN`），且只认这个人的
 *    `aliases`/`names`，不做模糊匹配。
 *
 * ## 缓存
 *
 * 名单来自 `persons`，而 persons 只在面板操作/遗忘时变。每次读盘太贵，
 * 所以进程内缓存一份，突变后调 `invalidate()`。版本号用「遗忘人数 + 每人
 * forgetVersion 之和」也够，但那要遍历；直接显式失效更简单、不会漏。
 */
const MIN_NAME_LEN = 2;
const MAX_NAMES = 400;

function norm(x) {
  return String(x ?? '').trim().toLowerCase().replace(/^@+/, '');
}

export function createForgetFilter({ persons, log = () => {} } = {}) {
  /** null = 还没算；`{ids:Set, names:[原始大小写]}` = 已算 */
  let cache = null;

  function build() {
    const ids = new Set();
    const names = [];
    try {
      for (const p of persons?.all?.() || []) {
        if (!p?.noMemory) continue;
        if (p.id) ids.add(norm(p.id));
        if (p.qq) ids.add(norm(p.qq));
        const list = persons?.namesOf?.(p.id) || [];
        for (const n of list) {
          const v = String(n || '').trim();
          /** 单字名（「明」）参与匹配会误伤一大片；宁漏不误 */
          if (v.length < MIN_NAME_LEN) continue;
          if (!names.some((x) => norm(x) === norm(v))) names.push(v);
          if (names.length >= MAX_NAMES) break;
        }
      }
    } catch (e) {
      log(`遗忘名单构建失败（这一轮不做过滤）：${e?.message || e}`);
      return { ids: new Set(), names: [] };
    }
    return { ids, names };
  }

  function state() {
    if (!cache) cache = build();
    return cache;
  }

  return {
    /** 面板操作后必须调，否则名单是旧的 */
    invalidate() {
      cache = null;
    },

    /** 这个人还记不记得（默认 true，与 persons 同语义） */
    remembers(id) {
      const q = norm(id);
      if (!q) return true;
      return !state().ids.has(q);
    },

    /**
     * 一条事实还要不要。
     * @param {{text?:string, about?:string}} row
     */
    keep(row) {
      const s = state();
      if (!s.ids.size && !s.names.length) return true;
      const about = norm(row?.about);
      if (about && s.ids.has(about)) return false;
      /** 老数据没有 about：按确认过的名字在正文里找（只认完整名字，不模糊） */
      if (s.names.length) {
        const text = String(row?.text ?? '');
        if (text && s.names.some((n) => text.includes(n))) return false;
      }
      return true;
    },

    /** 这段文本里有没有提到已遗忘的人（日记 / 图谱边 / 场景名段用） */
    mentions(text) {
      const s = state();
      if (!s.names.length) return false;
      const t = String(text ?? '');
      if (!t) return false;
      return s.names.some((n) => t.includes(n));
    },

    /** 实体名本身是不是已遗忘的人（图谱节点） */
    isEntity(name) {
      const q = norm(name);
      if (!q) return false;
      const s = state();
      if (s.ids.has(q)) return true;
      return s.names.some((n) => norm(n) === q);
    },

    /** 已遗忘者的名字列表（原始大小写；诊断与面板提示用） */
    names() {
      return state().names.slice();
    },

    /** 已遗忘的 id 列表（诊断用） */
    ids() {
      return [...state().ids];
    },

    get active() {
      const s = state();
      return s.ids.size > 0 || s.names.length > 0;
    },
  };
}
