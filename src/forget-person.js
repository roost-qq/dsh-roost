/**
 * 按人遗忘的编排：把「不再记住这个人」落成一次**跨模块的原子动作**。
 *
 * ## 三档，语义不同，别混
 *
 * | 档 | 做什么 | 可逆 | 用在哪 |
 * |---|---|---|---|
 * | `unlink`（默认） | 只断链：档案/事实/关系**一个字都不删**，各处读路径看不见；日记打 `forget:<id>` 失效标记 | 一键恢复，全部回来 | 「别再提他」 |
 * | `archive` | 断链 + 把该人数据整份快照到 `forget-archive.json` | 可从归档还原 | 「想清爽又怕反悔」 |
 * | `hard` | 物理清：日记正文抹成占位符、事实删除、图谱实体删掉 | **不可逆** | 隐私/被遗忘权兜底 |
 *
 * ## 为什么默认 unlink 而不是删
 *
 * 人脑里「想不起一个人」通常是**检索路径断了**，不是那段经历被擦掉——
 * 同一件事还能被别的线索唤起。`unlink` 正是这个语义：不注入、不参与召回，
 * 但数据还在，撤回就回来。真删只留给用户明确要求的场景（`hard`）。
 *
 * ## 失败不写半截
 *
 * 每一步都包在自己的 try 里、返回结构化结果；某一步失败**不回滚已成功的步骤**，
 * 而是如实回报 `steps`。因为这些都是「幂等的删除类操作」：重跑一次无害，
 * 半路回滚反而可能把刚删的又装回去。
 */
import { readFileSync } from 'node:fs';

import { writeJsonAtomic } from './atomic.js';

export const FORGET_MODES = Object.freeze(['unlink', 'archive', 'hard']);
export const FORGET_ARCHIVE_MAX = 50;

function norm(x) {
  return String(x ?? '').trim().toLowerCase().replace(/^@+/, '');
}

/** 「关于这个人」的判定与遗忘闸门同一口径：about 命中，或正文出现完整名字 */
function matcherOf(id, names) {
  const a = norm(id);
  const ns = (names || []).map((n) => String(n || '').trim()).filter((n) => n.length >= 2);
  return (text, about) => {
    if (a && norm(about) === a) return true;
    const t = String(text || '');
    return ns.some((n) => t.includes(n));
  };
}

export function createForgetPerson({
  persons,
  forgetFilter = null,
  profiles = null,
  memory = null,
  journal = null,
  graph = null,
  file,
  now = () => Date.now(),
  log = () => {},
  audit = null,
} = {}) {
  let archive = null;

  function loadArchive() {
    if (archive) return archive;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      archive = { items: Array.isArray(raw?.items) ? raw.items : [] };
    } catch {
      archive = { items: [] };
    }
    return archive;
  }

  function saveArchive() {
    try {
      const all = loadArchive();
      all.items = all.items.slice(-FORGET_ARCHIVE_MAX);
      archive = all;
      writeJsonAtomic(file, all, { indent: 0 });
    } catch (e) {
      log(`写遗忘归档失败（主流程已生效）：${e.message}`);
    }
  }

  /**
   * 把用户/面板给的「某个人」解析成稳定 id。
   * 认 id / qq / 别名 / 显示名（`persons.find` 那套），解析不出来就
   * **不猜**——没有身份就没法精确清，只能让调用方先去确认别名。
   *
   * 补一步：`persons` 里没有记录时（第一次遗忘这个人），从 `profiles` 的
   * 那一行拿显示名。**只用面板上已经存在的名字**，不从对话里猜——
   * 少了这一步，按 openid 遗忘时 `names` 只有那串 id，日记与事实一条都命中不了
   * （看着成功，其实什么都没断）。
   */
  function resolve(query) {
    const q = String(query ?? '').trim();
    if (!q) return null;
    const row = persons?.get?.(q) || null;
    /** 面板上的显示名：不管 persons 有没有记录都读一次，用来补 names */
    let displayName = '';
    try {
      const hit = (profiles?.recent?.(0) || [])
        .find((r) => norm(r.key) === norm(q) || norm(r.name) === norm(q) || norm(r.key) === norm(row?.id));
      displayName = String(hit?.name || '').trim();
    } catch { displayName = ''; }

    if (!row) {
      const id = String(q).toLowerCase();
      const names = [...new Set([displayName, q].filter(Boolean))];
      return { id, row: null, names, known: false };
    }
    const names = persons.namesOf?.(row.id) || [];
    const merged = [...new Set([...names, displayName, row.id].filter(Boolean))];
    return { id: row.id, row, names: merged, known: true };
  }

  /** 私聊键：一个人可能有好几个 openid（换过机器人），每个都要清 */
  function chatKeysOf(info) {
    const keys = new Set();
    const id = String(info?.id || '');
    if (id) keys.add(`private:${id}`);
    for (const a of info?.row?.aliases || []) {
      const v = String(a || '').trim();
      if (v) keys.add(`private:${v}`);
    }
    return [...keys];
  }

  function countFacts(info) {
    if (!memory?.listFull) return 0;
    try {
      const hit = matcherOf(info.id, info.names);
      const g = memory.listFull('', []).global || [];
      return g.filter((r) => hit(r.text, r.about)).length;
    } catch {
      return 0;
    }
  }

  return {
    /**
     * 影响面预览（**不改任何数据**）。面板二次确认前先把这个给用户看：
     * 「会让他不再被想起：档案 1 条、事实 3 条、日记 12 条」。
     */
    plan(query) {
      const info = resolve(query);
      if (!info) return { ok: false, message: '缺人物' };
      const hasProfile = Boolean(profiles?.recent?.()?.some?.((r) => norm(r.key) === norm(info.id)));
      const facts = countFacts(info);
      let journalRows = 0;
      try {
        journalRows = Number(journal?.forgetPerson?.({ senders: info.names, chatIds: chatKeysOf(info), mode: 'count' })?.matched || 0);
      } catch { journalRows = 0; }
      return {
        ok: true,
        id: info.id,
        known: info.known,
        names: info.names,
        alreadyForgotten: persons?.remembers?.(info.id) === false,
        affects: { profile: hasProfile ? 1 : 0, facts, journal: journalRows },
        message: `档案 ${hasProfile ? 1 : 0} 条、事实 ${facts} 条、日记 ${journalRows} 条`,
      };
    },

    /**
     * 执行遗忘。
     * @param {string} query 人物（id / 名字 / qq）
     * @param {{mode?:'unlink'|'archive'|'hard', by?:string, peer?:object}} opts
     */
    run(query, { mode = 'unlink', by = 'owner', peer = null } = {}) {
      const m = FORGET_MODES.includes(mode) ? mode : 'unlink';
      const info = resolve(query);
      if (!info) return { ok: false, message: '缺人物' };
      const steps = {};
      const t = now();
      /**
       * 归档快照必须**在立标记之前**取：标记一生效，读路径就按闸门把
       * 这个人的事实全过滤掉了，快照会变成空数组（看着归档成功，其实什么都没存）。
       */
      let snapshot = null;
      if (m === 'archive') {
        try {
          snapshot = {
            profile: profiles?.recent?.()?.find?.((r) => norm(r.key) === norm(info.id)) || null,
            facts: (memory?.listFull?.('', [])?.global || [])
              .filter((r) => matcherOf(info.id, info.names)(r.text, r.about))
              .map((r) => ({ text: r.text, about: r.about, at: r.at })),
          };
        } catch (e) {
          snapshot = { profile: null, facts: [] };
          log(`归档快照失败：${e.message}`);
        }
      }

      /** ① 身份权威：先立标记，闸门一失效所有读路径立刻看不见 */
      try {
        const r = persons?.setNoMemory?.(info.id, true, { by });
        steps.mark = Boolean(r?.ok);
      } catch (e) {
        steps.mark = false;
        log(`标记失败：${e.message}`);
      }
      /**
       * 把面板上的显示名记进身份表。不记的话，下次闸门重建名单时只知道
       * 那串 openid，日记/事实里出现的「小明」就一条都命中不了。
       */
      try {
        const display = info.names.find((n) => norm(n) !== norm(info.id) && String(n).length >= 2);
        if (display) persons?.see?.(info.id, { name: display });
      } catch { /* 记不住名字不影响主流程 */ }
      try { forgetFilter?.invalidate?.(); } catch { /* 缓存失效失败不拦主流程 */ }

      /** ② 日记：unlink 打失效标记 / hard 抹正文，然后同样打标记 */
      try {
        const r = journal?.forgetPerson?.({
          senders: info.names,
          chatIds: chatKeysOf(info),
          mode: m === 'hard' ? 'hard' : 'unlink',
          at: t,
          tag: `forget:${info.id}`,
        });
        steps.journal = Number(r?.changed || 0);
      } catch (e) {
        steps.journal = 0;
        log(`日记处理失败：${e.message}`);
      }

      /** ③ hard 才动物理数据：事实 / 档案 / 图谱 */
      if (m === 'hard') {
        try {
          steps.facts = Number(memory?.removePerson?.({ about: info.id, names: info.names }) || 0);
        } catch (e) {
          steps.facts = 0;
          log(`删除事实失败：${e.message}`);
        }
        try {
          steps.profile = profiles?.forget?.(info.id) ? 1 : 0;
        } catch { steps.profile = 0; }
        try {
          let removed = 0;
          for (const n of info.names) {
            const r = graph?.removeEntity?.(n, { chatId: '', aliases: [] });
            if (r?.ok) removed += 1;
          }
          steps.graph = removed;
        } catch (e) {
          steps.graph = 0;
          log(`删除图谱实体失败：${e.message}`);
        }
      }

      /** ④ archive：断链之外再留一份整份快照，方便离线核对/还原 */
      if (m === 'archive') {
        try {
          loadArchive().items.push({
            id: info.id,
            at: t,
            mode: m,
            names: info.names,
            profile: snapshot?.profile || null,
            facts: snapshot?.facts || [],
          });
          saveArchive();
          steps.archive = 1;
        } catch (e) {
          steps.archive = 0;
          log(`归档失败：${e.message}`);
        }
      }

      /** ⑤ 审计：删除类操作必须留痕（hindsight 的硬规矩） */
      try {
        audit?.({
          op: `person.forget.${m}`,
          peer,
          peerId: info.id,
          note: `journal=${steps.journal || 0} facts=${steps.facts || 0} graph=${steps.graph || 0}`,
        });
      } catch { /* 审计失败不影响操作 */ }

      return {
        ok: true,
        id: info.id,
        mode: m,
        steps,
        message: m === 'hard'
          ? `已彻底遗忘：日记 ${steps.journal || 0} 条、事实 ${steps.facts || 0} 条`
          : m === 'archive'
            ? `已不再记住，并归档 ${steps.archive ? '一份' : '（失败）'}`
            : `已不再记住这个人（日记 ${steps.journal || 0} 条已断链，可恢复）`,
      };
    },

    /**
     * 撤回：恢复记住。
     *
     * 只放回**这个人的**那批标记（`forget:<id>`），不会把别人的遗忘一起
     * 撤销——`restore()` 无参是全库恢复，这里绝不能用它。
     */
    restore(query, { peer = null } = {}) {
      const info = resolve(query);
      if (!info) return { ok: false, message: '缺人物' };
      let back = 0;
      try {
        back = Number(journal?.restoreTag?.(`forget:${info.id}`) || 0);
      } catch (e) {
        log(`恢复日记失败：${e.message}`);
      }
      try {
        persons?.setNoMemory?.(info.id, false);
      } catch (e) {
        log(`撤销标记失败：${e.message}`);
      }
      try { forgetFilter?.invalidate?.(); } catch { /* 同上 */ }
      try {
        audit?.({ op: 'person.forget.restore', peer, peerId: info.id, note: `journal=${back}` });
      } catch { /* 审计失败不影响操作 */ }
      return { ok: true, id: info.id, journal: back, message: `已恢复记住（日记 ${back} 条回到注入）` };
    },

    /** 面板展示：最近归档过谁（只给摘要，不回正文） */
    archived({ limit = 20 } = {}) {
      const items = loadArchive().items;
      return items
        .slice(-Math.max(1, Number(limit) || 20))
        .reverse()
        .map((x) => ({
          id: x.id,
          at: x.at,
          mode: x.mode,
          names: Array.isArray(x.names) ? x.names.slice(0, 4) : [],
          facts: Array.isArray(x.facts) ? x.facts.length : 0,
          hasProfile: Boolean(x.profile),
        }));
    },
  };
}
