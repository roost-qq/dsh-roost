/**
 * 按会话存「本轮场景快照」。
 * ========================
 *
 * 为什么需要这个模块
 * ------------------
 * 场景、facts、「刚才说到」这三段注入以前都读一个全局变量 `lastScene`：
 * 「最后一个说话的会话」。而 `handleTurn` 是 async 的，`recallFor` 会把一轮
 * 挂起几十毫秒；两个会话同时有消息时，B 进来就把 `lastScene` 覆盖成 B，
 * A 恢复后拼出来的注入段里是 **B** 的内容——A 群冒出 B 群的聊天原文。
 *
 * 修法不是加锁（会让一个群等另一个群的模型调用），而是**按会话各存一份**：
 * 注入侧永远只读自己那个 chatId 的快照。同一个会话的轮次本来就有 busy 锁
 * 串行，所以每个键只需要留最近一轮。
 *
 * 为什么单独成文件
 * ----------------
 * 「A 的写入不会影响 A 读到的内容」这条不变量必须能被单测锁住。
 * 放在 host.js 的闭包里就测不到，改回单变量也不会有人发现
 * （见 `test/turn-scene.test.js`）。
 */

/**
 * @param {number} max 最多保留几个会话；面板只用来显示「最近一轮」，丢老的没影响
 */
export function createTurnScenes(max = 64) {
  const map = new Map();
  const limit = Math.max(1, Number(max) || 64);

  return {
    /**
     * 记一轮。**先删后插**是为了让 Map 的插入顺序当 LRU 用：
     * 一个长期活跃的群每轮都往回挪，被淘汰的总是真正最久没说话的。
     */
    set(chatId, scene) {
      const key = String(chatId || '');
      if (!key || !scene) return;
      map.delete(key);
      map.set(key, scene);
      while (map.size > limit) map.delete(map.keys().next().value);
    },

    /** 拿某个会话最近一轮的快照；没有就 null（调用方要能区分「没说过话」） */
    get(chatId) {
      const key = String(chatId || '');
      return key ? map.get(key) || null : null;
    },

    /**
     * 最近写入的那一条。**只给面板兜底**（面板刚打开、还没有选中会话时）。
     * 注入链路不许用它——用了就退回「最后一个说话的会话」那个老毛病。
     */
    latest() {
      if (!map.size) return null;
      return map.get([...map.keys()][map.size - 1]) || null;
    },

    /** 面板列出「有哪些会话留下过快照」，按最久没说话的排前面 */
    chatIds() {
      return [...map.keys()];
    },

    get size() {
      return map.size;
    },

    clear() {
      map.clear();
    },
  };
}

/**
 * 场景块里的「现在是什么时候」。
 *
 * 为什么模型需要它：人格里写着「深夜别追问」「工作日白天她可能在上班」这类
 * 设定，模型却不知道当前是几点——只能从聊天内容里猜，猜错时表现得像不认识字。
 *
 * 为什么**只给时段、不给分钟**：这段挂在 `systemPrompt.context`（order 902），
 * 每个请求都要重发。带分钟的话每分钟换一次文本，system 前缀缓存每分钟失效一次，
 * 后面 903–910 全段跟着重算。只给「11月26日 周四 下午」——日期一天一变、
 * 时段三小时一变，缓存基本稳得住，而模型真正用得上的是「深夜/上午」这种粗粒度。
 *
 * @param {number} [now] 取当前时间的毫秒数（测试可注入）
 * @returns {string} 例如 `现在是 11月26日 周四 下午。`
 */
export function sceneClock(now = Date.now()) {
  const d = new Date(Number(now) || Date.now());
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  const h = d.getHours();
  const part = h < 5 ? '凌晨'
    : h < 8 ? '早上'
      : h < 11 ? '上午'
        : h < 13 ? '中午'
          : h < 17 ? '下午'
            : h < 19 ? '傍晚'
              : h < 23 ? '晚上' : '深夜';
  return `现在是 ${d.getMonth() + 1}月${d.getDate()}日 周${week} ${part}。`;
}
