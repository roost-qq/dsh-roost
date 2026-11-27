/**
 * 把主人最近说的话增量写进 autotelic 观察层（每分钟一次）。
 *
 * 为什么要独立成模块：去重窗口必须盖住「两天窗口 × 群密度」。以前在 host.js 里
 * 每次同步都用 `autotelicObserve.list({ limit: 60 })` 重建 Set——窗口一旦超过
 * 60 条，先写进去的 key 被挤出去，下一轮就把整窗再写一遍（对方实测 4656 条
 * 的窗口三轮写了 13968 条）。这里改成进程内持久的滑动 seen 集合，上限默认
 * 6 万，超过才从队头淘汰。
 *
 * 不改消息主流程：只在自驱心跳里拉 journal，落盘由观察层自己的缓冲负责。
 */

/** 去重写 observe key：跟 append 的 ts / text 对齐（text 截前 40 字） */
function keyOf(row) {
  return `${Number(row?.ts) || 0}|${String(row?.text || '').slice(0, 40)}`;
}

/**
 * @param {object} o
 * @param {{listChat:(id:string, n:number)=>Array}} o.journal
 * @param {{list:(o:object)=>Array, append:(o:object)=>*, observeCorrection?:(s:string,o:object)=>*, flush?:()=>void}} o.observe
 * @param {()=>string} o.ownerId
 * @param {(s:string)=>void} [o.log]
 * @param {number} [o.limit]   seen 上限，默认 6 万
 * @param {number} [o.window]  每轮从 journal 拉多少条，默认 20
 */
export function createChatObserveSync({
  journal,
  observe,
  ownerId,
  log = () => {},
  limit = 60_000,
  window = 20,
} = {}) {
  const cap = Math.max(1, Number(limit) || 60_000);
  const seen = [];
  const seenSet = new Set();
  let primed = false;

  function markSeen(key) {
    if (seenSet.has(key)) return false;
    seenSet.add(key);
    seen.push(key);
    if (seen.length > cap) {
      for (const old of seen.splice(0, seen.length - cap)) seenSet.delete(old);
    }
    return true;
  }

  return {
    /**
     * 跑一轮同步。返回本轮新写的条数。
     * 第一次调用先把观察层已有的 key 全量纳入 seen——进程重启后不该把
     * 之前写过的聊天再写一遍（相当于把磁盘状态当去重基线）。
     */
    collect() {
      try {
        if (!primed) {
          primed = true;
          for (const row of observe.list({ limit: cap })) markSeen(keyOf(row));
        }
        const owner = String(ownerId?.() || '').trim();
        if (!owner) return 0;
        const rows = journal.listChat(owner, window) || [];
        let written = 0;
        for (const row of rows) {
          const role = String(row?.role || '');
          if (role !== 'user' && role !== 'member' && role !== 'bot') continue;
          const text = String(row?.text || row?.digest || '').replace(/\s+/g, ' ').trim();
          if (!text) continue;
          const at = Number(row?.at) || Date.now();
          const key = `${at}|${text.slice(0, 40)}`;
          if (!markSeen(key)) continue;
          /** 主人纠偏单独走 observeCorrection（最高显著度 + 回调），其余按普通观察 */
          if (role === 'user' && observe.observeCorrection?.(text, { tag: '牵挂' })) continue;
          observe.append({
            source: 'chat',
            tag: role === 'user' ? '牵挂' : role === 'bot' ? '余韵' : '好奇',
            text,
            ts: at,
          });
          written += 1;
        }
        return written;
      } catch (e) {
        log(`观察同步失败：${e?.message || e}`);
        return 0;
      }
    },

    /** 面板/诊断用：当前去重窗口大小 */
    get seenSize() {
      return seenSet.size;
    },
  };
}
