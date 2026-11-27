/**
 * 诊断包里的配置视图：功能摘要 + 逐字段脱敏的配置原文
 * ==================================================
 *
 * 为什么单独一个文件：这段文本是要**发到群里 / 贴到 issue** 的，泄密一次就
 * 够了。既有 `redact.js` 的 `redactText()` 是给日志用的文本正则，覆盖不到
 * JSON 里的 `webui.accessKey`（实测：`"accessKey": "..."` 不会被抹掉），
 * 所以这里按**字段名**逐层裁剪，而不是把整份 JSON 过一遍正则。
 *
 * 三条硬约束：
 *   1. 开关类（布尔 / 数值）原样保留——用户就是要把「开了什么」给支持者看。
 *   2. 凭证 / 个人标识（密钥、OpenID、主人名单）只留「有几个」。
 *   3. 已知密钥的真实值即使出现在无关字段（比如备注里）也要抹掉。
 *
 * 纯函数，不 import fs / redact，单测不需要拖整条宿主依赖链。
 */

/** 字段名命中就整段替换。小写比较，末尾匹配兼容 appSecret / accessKey / smtpPass 等 */
const MASK_KEY = /(?:secret|token|password|passwd|pwd|pass|cookie|authorization|credential|privatekey|apikey|accesskey|clientkey|skey|p_skey|pskey|pubkey|dsn|webhook|music_u)$/i;

/** 这些字段本身不是密钥，但里面是个人标识（QQ openid / 群号），只留条数 */
const COUNT_KEYS = new Set(['owners', 'whitelist', 'users', 'groups', 'members', 'admins']);

/** 密钥形状的裸字符串，哪怕挂在不起眼的键上也要抹 */
const SECRET_SHAPE = /^(?:sk-[A-Za-z0-9_.-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

/** 同一批形状，但允许出现在句子中间（备注里粘着密钥是最常见的泄露形态） */
const SECRET_INLINE = /(?:sk-[A-Za-z0-9_.-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)/g;

/** 默认掩码。用固定值，不要写成 `***(原长 N)`——长度本身就是信息 */
export const DEFAULT_MASK = '(已隐藏)';

function maskedArray(v) {
  if (!Array.isArray(v)) return v;
  return `[已隐藏 ${v.length} 项]`;
}

/**
 * 递归脱敏配置对象，返回新值，不改原对象。
 * @param {unknown} value
 * @param {{secrets?: string[], mask?: string, maxDepth?: number}} opts
 */
export function redactConfig(value, opts = {}) {
  const { secrets = [], mask = DEFAULT_MASK, maxDepth = 8 } = opts;
  const known = new Set((Array.isArray(secrets) ? secrets : []).filter((s) => typeof s === 'string' && s.length >= 4));

  const walk = (v, key, depth) => {
    if (depth > maxDepth) return '…';
    if (typeof v === 'string') {
      if (known.has(v)) return mask;
      if (SECRET_SHAPE.test(v.trim())) return mask;
      /** 备注 / 名字里可能粘着密钥原文：逐值替换，不止字段名命中的地方 */
      let out = v;
      for (const s of known) if (out.includes(s)) out = out.split(s).join(mask);
      out = out.replace(SECRET_INLINE, mask);
      return out;
    }
    if (Array.isArray(v)) {
      if (COUNT_KEYS.has(String(key || '').toLowerCase())) return maskedArray(v);
      return v.slice(0, 20).map((x) => walk(x, key, depth + 1));
    }
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const out = {};
      for (const [k, child] of Object.entries(v)) {
        const lk = String(k).toLowerCase();
        if (COUNT_KEYS.has(lk) && Array.isArray(child)) { out[k] = maskedArray(child); continue; }
        if (MASK_KEY.test(lk)) {
          /** 布尔 / 空值保留原状：比如 `webui.enabled: false` 里的 enabled 不该被抹 */
          out[k] = typeof child === 'boolean' || child === '' || child === null ? child : mask;
          continue;
        }
        out[k] = walk(child, k, depth + 1);
      }
      return out;
    }
    return v;
  };

  return walk(value, '', 0);
}

/** 安全取嵌套字段 */
function at(root, path) {
  return path.reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), root);
}

/**
 * 框架侧要在诊断包里说清的开关。只列这些：都是「排障时真会问」的，
 * 全量配置原文在后面那一段，这里不能又长又乱。
 */
const FW_SWITCHES = [
  ['日志级别', ['logLevel']],
  ['面板 enabled', ['webui', 'enabled']],
  ['面板端口', ['webui', 'port']],
  ['Webhook', ['webhook', 'enabled']],
  ['插件模式', ['plugins', 'mode']],
  ['自动装依赖', ['plugins', 'autoInstallDeps']],
  ['自更新', ['update', 'auto']],
];

/**
 * 生成「开了什么功能」的可读摘要。
 *
 * @param {object} o
 * @param {Array<{id:string,label:string,on:boolean}>} [o.dshFeatures] 由调用方用 features.js 算好
 * @param {object} [o.fwGlobal] 框架全局配置原文（未脱敏也行：这里只挑开关字段）
 * @param {Array<object>} [o.fwBots] 框架每只鸟配置
 * @returns {string}
 */
export function configFeatureSummary({ dshFeatures = [], fwGlobal = {}, fwBots = [] } = {}) {
  const lines = ['[功能开关 · dsh-roost]'];
  if (!dshFeatures.length) lines.push('  （没读到）');
  for (const f of dshFeatures) {
    lines.push(`  ${f.on ? '开' : '关'} ${f.label}（${f.id}）`);
  }

  lines.push('', `[功能开关 · 框架]  ${fwBots.length} 只鸟`);
  for (const [label, path] of FW_SWITCHES) {
    const v = at(fwGlobal, path);
    if (v !== undefined) lines.push(`  ${label}：${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  }
  for (const bot of fwBots) {
    const id = bot?.id || bot?.name || '?';
    const bits = [
      `enabled=${bot?.enabled !== false}`,
      `intents=${bot?.intents ?? '默认'}`,
      `plugins=${bot?.plugins?.mode || '默认'}`,
      `白名单=${bot?.whitelist?.enabled ? '开' : '关'}`,
      `主人=${Array.isArray(bot?.owners) ? bot.owners.length : 0}`,
    ];
    lines.push(`  ${id}：${bits.join(' / ')}`);
  }
  return lines.join('\n');
}

/**
 * 诊断包里「配置与功能」整段：先摘要，再两份脱敏原文。
 *
 * 为什么不只放摘要：排障经常要问「某个参数到底填成了什么」，摘要只有开关；
 * 为什么不只放原文：原文里 `enabled: false` 埋在几百行里，没人看得见。
 * 两样都给，且都过同一套脱敏。
 */
export function configBundleNote({ dshConfig = {}, fwGlobal = {}, fwBots = [], dshFeatures = [], secrets = [] } = {}) {
  return [
    configFeatureSummary({ dshFeatures, fwGlobal, fwBots }),
    '',
    '[dsh-roost 配置原文（已脱敏）]',
    JSON.stringify(redactConfig(dshConfig, { secrets }), null, 2),
    '',
    '[框架配置 · 全局（已脱敏）]',
    JSON.stringify(redactConfig(fwGlobal, { secrets }), null, 2),
    ...fwBots.map((b) => [
      '',
      `[框架配置 · ${b?.id || '?'}（已脱敏）]`,
      JSON.stringify(redactConfig(b, { secrets }), null, 2),
    ].join('\n')),
    '',
    '说明：密钥 / 主人 OpenID / 白名单只留条数；开关与数值原样保留。',
  ].join('\n');
}
