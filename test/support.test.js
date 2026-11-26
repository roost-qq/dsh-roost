// 问题反馈（2026-11-27）：纯逻辑单测 + 接线纪律。
//
// 为什么这些要单测：失败点全在边界上——FAQ 章节改名、README 的 `<details>`
// 写法变了、框架没装、DSH 从没崩过（日志目录是空的）。这些都不会抛异常，
// 只会让弹窗里显示一句错的话，而用户正是「出问题的时候」才打开它。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GROUP_ID, LINKS, PANEL_LOG_MAX, FAQ_HEADING,
  faqSlice, dshLogDirs, dshLogInfo, listLogFiles, frameworkLogInfo,
  readTail, openCmd, sizeText, diagnosticsText,
  pickRecent, formatEntry, bundleName, bundleText, frameworkWebUrl,
} from '../src/support.js';
import { SELF_REPO, GITEE_SELF_REPO, FW_REPO, GITEE_FW_REPO } from '../src/repo.js';

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

/* ---------------- 常见问题 ---------------- */

test('FAQ：从真 README 切出 8 条，首条是「装好了不回」', () => {
  const r = faqSlice(README);
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 8, `实际 ${r.items.length} 条——README 增删条目时同步改这条`);
  assert.match(r.items[0].q, /不回|401/);
  assert.ok(r.items.every((x) => x.q && x.a), '每条都要有问题和答案');
  /** 切片里不该留着 `<details>` 标签：前端按 items 渲染，正文再带标签就重复了 */
  assert.ok(!r.items[0].a.includes('<summary>'));
});

test('FAQ：没有该章节时返回 ok:false，不抛', () => {
  const r = faqSlice('# 别的文档\n\n## 安装\n\n内容');
  assert.equal(r.ok, false);
  assert.deepEqual(r.items, []);
  assert.equal(r.text, '');
});

test('FAQ：到下一个二级标题为止，不吃掉后面的内容', () => {
  const md = `${FAQ_HEADING}\n\n<details>\n<summary>问一</summary>\n答一\n</details>\n\n## 下一节\n\n不该出现`;
  const r = faqSlice(md);
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 1);
  assert.ok(!r.text.includes('不该出现'), '切片越界会把后面的章节也吞进来');
});

test('FAQ：README 里必须真有这个标题（两个站的锚点都靠它）', () => {
  assert.ok(README.includes(`\n${FAQ_HEADING}\n`), 'README 的「## 常见问题」是 GitHub/Gitee 锚点的来源，别改名');
});

test('FAQ：答案里的链接必须已经是绝对地址（相对链接在面板里点开是 404）', () => {
  /**
   * README 里写的是 `[手册 · 表情包](docs/USER-MANUAL.md#表情包)`。
   * 原样交给前端，`<a href="docs/USER-MANUAL.md">` 在 webview 里会解析成
   * `http://127.0.0.1:<端口>/docs/USER-MANUAL.md` —— 宿主不 serve 那个路径。
   * 指着「看文档」却把人送到死链，比不给链接更糟。
   */
  const r = faqSlice(README);
  const links = [...r.text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
  assert.ok(links.length > 0, 'README 的 FAQ 里本来就有链接，一个都没切出来说明解析坏了');
  for (const h of links) {
    assert.match(h, /^https?:/i, `FAQ 里残留非绝对链接：${h}（面板里点开必然 404）`);
  }
  /** 相对路径要拼到主仓的 blob 地址上，而不是随便哪个域名 */
  assert.ok(links.some((h) => h.includes('docs/USER-MANUAL.md')),
    '「详见手册」那几条应该在（它们是最容易坏的一类）');
});

test('FAQ：纯锚点指向 README 自己，不能变成面板首页', () => {
  const md = `${FAQ_HEADING}\n\n<details>\n<summary>问</summary>\n见 [安全](#安全与隐私)\n</details>`;
  const r = faqSlice(md);
  assert.ok(r.items[0].a.includes('/blob/main/README.md#安全与隐私'), r.items[0].a);
});

/* ---------------- DSH 本体日志 ---------------- */

test('DSH 日志候选：三个平台都给出符合 Electron logs 约定的路径', () => {
  const win = dshLogDirs({ platform: 'win32', env: { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, home: 'C:\\Users\\a' });
  assert.ok(win[0].endsWith(join('@deepseek-ai', 'dsh-desktop', 'logs')), win[0]);

  const mac = dshLogDirs({ platform: 'darwin', env: {}, home: '/Users/a' });
  assert.ok(mac.some((p) => p.includes(join('Library', 'Logs'))), mac.join(' | '));

  const linux = dshLogDirs({ platform: 'linux', env: {}, home: '/home/a' });
  assert.ok(linux.some((p) => p.includes(join('.config', '@deepseek-ai', 'dsh-desktop', 'logs'))), linux.join(' | '));
});

test('DSH 日志候选：DSH_LOG_DIR 优先，且结果去重', () => {
  const dirs = dshLogDirs({
    platform: 'win32', home: 'C:\\Users\\a',
    env: { DSH_LOG_DIR: 'D:\\custom-logs', APPDATA: 'C:\\Users\\a\\AppData\\Roaming' },
  });
  assert.equal(dirs[0], 'D:\\custom-logs');
  assert.equal(new Set(dirs).size, dirs.length);
});

test('DSH 日志：目录空 = 没崩过，latest 为 null 但 exists 为 true', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-logs-'));
  const r = dshLogInfo({ platform: 'win32', home: dir, env: { DSH_LOG_DIR: dir } });
  assert.equal(r.exists, true);
  assert.equal(r.dir, dir);
  assert.equal(r.latest, null);
  assert.deepEqual(r.files, []);
});

test('DSH 日志：取最近修改的那条，非 .log 不算', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-logs-'));
  writeFileSync(join(dir, 'crash-old.log'), 'old');
  writeFileSync(join(dir, 'crash-new.log'), 'new');
  writeFileSync(join(dir, 'notes.txt'), '不是日志');
  const t = new Date('2026-01-01T00:00:00Z');
  utimesSync(join(dir, 'crash-old.log'), t, t);
  utimesSync(join(dir, 'crash-new.log'), new Date('2026-06-01T00:00:00Z'), new Date('2026-06-01T00:00:00Z'));

  const r = dshLogInfo({ platform: 'win32', home: dir, env: { DSH_LOG_DIR: dir } });
  assert.equal(r.latest.name, 'crash-new.log');
  assert.deepEqual(r.files.map((f) => f.name).sort(), ['crash-new.log', 'crash-old.log']);
  assert.equal(listLogFiles(dir, { limit: 1 }).length, 1);
});

test('DSH 日志：目录不存在时 exists:false 且仍给出候选路径（UI 要说去哪儿找）', () => {
  const ghost = join(tmpdir(), 'dsh-logs-not-here-' + process.pid);
  const r = dshLogInfo({ platform: 'win32', home: ghost, env: { DSH_LOG_DIR: ghost } });
  assert.equal(r.exists, false);
  assert.equal(r.latest, null);
  assert.ok(r.dir, '没有目录时也要回一个候选，前端用它解释「去哪找」');
});

/* ---------------- 框架日志 ---------------- */

test('框架日志：没装框架 = installed:false，不是错误', () => {
  const r = frameworkLogInfo('');
  assert.deepEqual(r, { installed: false, dir: '', path: '', logsDir: '', exists: false });
});

test('框架日志：路径由安装目录拼，未生成时 exists:false', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-'));

  /** 只有目录、没有 src/main.js：`setup` 里这算「配错了路径」，不能报成已装 */
  assert.equal(frameworkLogInfo(dir).installed, false);

  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'main.js'), '');
  const r = frameworkLogInfo(dir);
  assert.equal(r.installed, true);
  assert.equal(r.path, join(dir, 'logs', 'bot.log'));
  assert.equal(r.exists, false, '框架没启动过就没有日志文件');

  mkdirSync(join(dir, 'logs'));
  writeFileSync(join(dir, 'logs', 'bot.log'), 'hello');
  assert.equal(frameworkLogInfo(dir).exists, true);
});

/* ---------------- 读尾部 ---------------- */

test('读尾部：超过行数只留最后几行，并标记 truncated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tail-'));
  const file = join(dir, 'a.log');
  writeFileSync(file, Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'));

  const r = readTail(file, { maxBytes: 64 * 1024, maxLines: 10 });
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true);
  const lines = r.text.split('\n');
  assert.equal(lines.length, 10);
  assert.equal(lines.at(-1), 'line 99');
});

test('读尾部：按字节截断时丢掉开头那半行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tail-'));
  const file = join(dir, 'a.log');
  writeFileSync(file, 'AAAA\nBBBB\nCCCC\nDDDD');

  const r = readTail(file, { maxBytes: 10, maxLines: 100 });
  assert.equal(r.ok, true);
  assert.ok(!r.text.startsWith('AAA'), `开头不该是半行：${r.text}`);
  assert.ok(r.text.endsWith('DDDD'));
});

test('读尾部：文件不存在返回 ok:false，不抛', () => {
  const r = readTail(join(tmpdir(), 'nope-' + process.pid + '.log'));
  assert.equal(r.ok, false);
  assert.equal(r.text, '');
});

/* ---------------- 链接 / 文案 ---------------- */

test('链接：issue 只收 GitHub，FAQ 两站都给，且指向本仓而不是框架仓', () => {
  /**
   * issue 只在 GitHub：Gitee 是 pull 镜像，维护者不去那边看。
   * 镜像上给个「去这里提」，用户以为提过了，实际没人看——比不给还糟。
   */
  assert.ok(/issues\/new$/.test(LINKS.github.issues), `GitHub 缺「新建 issue」：${LINKS.github.issues}`);
  assert.equal(LINKS.gitee.issues, undefined, 'Gitee 不该有 issue 入口');
  for (const site of ['github', 'gitee']) {
    const l = LINKS[site];
    assert.ok(l.faq.includes('README.md'), `${site} 的 FAQ 应指向 README`);
    assert.ok(!/\/qq-bot-roost\//.test(l.faq), `${site} 的 FAQ 指向了框架仓`);
  }
  assert.ok(LINKS.github.repo.endsWith('/roost-qq/dsh-roost'));
  assert.ok(LINKS.gitee.repo.endsWith('/tdcq9594/dsh-roost'), 'Gitee 在个人号下，不能照抄 GitHub 组织名');
});

test('诊断信息：版本 / 平台 / 两条日志路径 / 群号都在一段里', () => {
  const text = diagnosticsText({
    version: '1.0.37', frameworkVersion: '1.0.12', frameworkRunning: true,
    platform: 'win32', arch: 'x64', node: '22.14.0',
    dataDir: 'C:\\Users\\me\\.dsh\\dsh-roost',
    activate: { exists: false, size: 0, path: 'C:\\Users\\me\\.dsh\\dsh-roost\\activate-error.log' },
    dsh: { dir: 'C:\\Users\\me\\AppData\\Roaming\\@deepseek-ai\\dsh-desktop\\logs', latest: null },
    framework: { path: 'D:\\roost\\logs\\bot.log', exists: true },
    panelCount: 3,
  });
  assert.match(text, /dsh-roost 1\.0\.37/);
  assert.match(text, /框架 1\.0\.12（运行中）/);
  assert.match(text, /win32 x64 · node 22\.14\.0/);
  assert.match(text, /不落盘/);
  assert.match(text, /没有崩溃记录/);
  assert.match(text, new RegExp(GROUP_ID));
  assert.ok(!text.includes('undefined'), '缺字段不能把 undefined 贴进群里');
});

test('大小文案与打开命令', () => {
  assert.equal(sizeText(0), '0 B');
  assert.equal(sizeText(2048), '2.0 KB');
  assert.equal(sizeText(3 * 1024 * 1024), '3.0 MB');
  assert.equal(openCmd('win32'), 'explorer');
  assert.equal(openCmd('darwin'), 'open');
  assert.equal(openCmd('linux'), 'xdg-open');
});

/* ---------------- 接线纪律 ---------------- */

const HOST = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');
const CLIENT = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');

test('五条路由必须经 regSupport 注册，并收进 supportOffs 注销', () => {
  for (const p of ['/support/info', '/support/faq', '/support/log-tail', '/support/open', '/support/bundle']) {
    assert.ok(HOST.includes(`regSupport('${p}'`), `${p} 没用 regSupport 注册——漏注销会让重载时重复注册，DSH 拒绝激活`);
  }
  /** 包装函数本身要把 off 推进数组，并且数组要真的交给宿主 */
  assert.match(HOST, /const supportOffs = \[\]/);
  assert.match(HOST, /const regSupport = \(path, handler\) => \{[\s\S]{0,200}supportOffs\.push\(off\)/);
  assert.match(HOST, /\.\.\.supportOffs/);
});

test('日志尾部只认 activate / dsh，框架日志不读全文', () => {
  const seg = HOST.slice(HOST.indexOf("regSupport('/support/log-tail'"), HOST.indexOf("regSupport('/support/open'"));
  assert.ok(seg.includes("which === 'activate'"));
  assert.ok(seg.includes("which === 'dsh'"));
  assert.ok(!seg.includes('frameworkLogInfo'), '框架日志是另一个进程的大文件，只给路径 + 打开');
  assert.ok(seg.includes('redactText'), '日志尾部要贴到群里，出路前必须脱敏');
});

test('打开：只认四个枚举，不接受前端传路径或网址', () => {
  const from = HOST.indexOf("regSupport('/support/open'");
  const seg = HOST.slice(from, HOST.indexOf('const offs = [', from));
  for (const w of ['data', 'framework-logs', 'framework-web', 'dsh-logs']) {
    assert.ok(seg.includes(`'${w}'`), `少了枚举 ${w}`);
  }
  assert.ok(!/body\?\.(path|dir|url)\b/.test(seg), '不能接受前端传路径或网址：这是按钮，不是文件浏览器');
  /**
   * 框架网页地址里带着访问密钥：回给前端就等于把密钥复制进 DOM。
   * 前端只需要知道成不成（`message`）。
   */
  assert.ok(seg.includes('...(isUrl ? {} : { target })'),
    '框架网页的地址不该回传给前端——里面有访问密钥');
});

test('群号只有一份：后端 GROUP_ID 与前端 FEEDBACK_GROUP 一致，且不再散落硬编码', () => {
  assert.ok(CLIENT.includes(`const FEEDBACK_GROUP = '${GROUP_ID}'`), '前端常量与后端不一致');
  const hits = CLIENT.split(`'${GROUP_ID}'`).length - 1;
  assert.equal(hits, 1, `client.js 里群号硬编码了 ${hits} 处，只该有常量那一处`);
  /** 旧文案「QQ 群 1130901545」必须改成读常量 */
  assert.ok(!CLIENT.includes(`QQ 群 ${GROUP_ID}`));
});

test('面板日志上限：文案里的数字与后端一致', () => {
  assert.equal(PANEL_LOG_MAX, 400);
  assert.ok(CLIENT.includes('logs.panel?.max ?? 400') || CLIENT.includes('PANEL_LOG_MAX'),
    '前端写死了 400 却没引用常量，后端改上限时会不同步');
});

test('前端的外链兜底与后端 LINKS 逐字一致', () => {
  /**
   * `SUPPORT_LINKS` 是为了「`/support/info` 挂了也要能给 issue 链接」而复制的一份。
   * 复制就会漂移：改仓库地址时只改后端，前端会一直指旧仓，而且看不出来。
   */
  for (const key of ['issues', 'faq']) {
    assert.ok(CLIENT.includes(LINKS.github[key]),
      `前端缺 github.${key}（${LINKS.github[key]}），与后端漂移了`);
  }
  assert.ok(CLIENT.includes(LINKS.gitee.faq), `前端缺 gitee.faq，与后端漂移了`);
  /** 后端已经没有 Gitee issue，前端也不能偷偷留一份（用户点了会去一个没人看的地方） */
  assert.ok(!CLIENT.includes('gitee.com/tdcq9594/dsh-roost/issues'),
    '前端还留着 Gitee issue 链接');
});

test('页头：问题反馈按钮在标题行内、总开关之前，且不依赖 featOn', () => {
  const head = CLIENT.slice(CLIENT.indexOf("className: 'roost-head-row'"), CLIENT.indexOf("className: 'roost-nav'"));
  const iBtn = head.indexOf("className: 'roost-head-help'");
  const iQuick = head.indexOf("className: 'roost-head-quick'");
  assert.ok(iBtn > 0, '页头没有反馈按钮');
  assert.ok(iBtn < iQuick, '按钮应在总开关之前（方案 A：竖线左侧）');
  assert.ok(head.includes('setSupportOpen(true)'));
  /** 按钮在 `featOn ? ...` 之外：读不到开关状态时也要能求助 */
  assert.ok(head.indexOf('setSupportOpen(true)') < head.indexOf('featOn ?'), '按钮被包进了 featOn 分支');
});

test('弹窗：四段齐全，跳到排障页前先关弹窗', () => {
  const seg = CLIENT.slice(CLIENT.indexOf('function SupportModal'), CLIENT.indexOf('function FeedbackCard'));
  for (const n of ["'01'", "'02'", "'03'", "'04'"]) assert.ok(seg.includes(n), `少了第 ${n} 段`);
  for (const p of ['/support/info', '/support/faq', '/support/log-tail', '/support/open', '/support/bundle']) {
    assert.ok(seg.includes(p), `弹窗没接 ${p}`);
  }
  assert.ok(seg.includes('onGo') && seg.includes("onGo('logs')"), '面板日志要能跳排障页');
  /** 弹窗放不下二维码，但只给群号又进不去群：必须给一条去「关于」页的路 */
  assert.ok(seg.includes("onGo('about')"), '反馈群要给去「关于」页扫二维码的入口');
  /** 挂载处：先关再跳，否则遮罩盖住新页面 */
  const mount = CLIENT.slice(CLIENT.indexOf('supportOpen\n          ? h(SupportModal'));
  assert.match(mount.slice(0, 400), /setSupportOpen\(false\);\s*goTab\(id\)/);
});

/* ---------------- 第二批：诊断包 / issue 模板（2026-11-27） ---------------- */

test('pickRecent：只要该级别、最新在前、上限生效', () => {
  const es = [
    { time: '01', level: 'info', text: 'a' },
    { time: '02', level: 'error', text: 'e1' },
    { time: '03', level: 'warn', text: 'w' },
    { time: '04', level: 'error', text: 'e2' },
    { time: '05', level: 'error', text: 'e3' },
  ];
  assert.deepEqual(pickRecent(es, 'error', 2).map((x) => x.text), ['e3', 'e2'], '最新的在前');
  assert.deepEqual(pickRecent(es, 'error').map((x) => x.text), ['e3', 'e2', 'e1'], '默认 3 条');
  assert.deepEqual(pickRecent([], 'error'), []);
  assert.deepEqual(pickRecent(null, 'error'), [], '日志还没初始化时不能炸');
  assert.equal(pickRecent([{ level: 'error', text: 'x' }, null], 'error').length, 1, '空条目要跳过');
});

test('formatEntry：一行一条，多行正文缩进对齐', () => {
  assert.equal(
    formatEntry({ time: '03:00:28', level: 'error', area: 'inbound', text: 'onInbound is not defined' }),
    '[03:00:28] ERROR inbound：onInbound is not defined',
  );
  /** stack 是多行的：续行要缩进到正文起始位置，否则挤成一坨看不出哪行是新的 */
  const lines = formatEntry({ time: '1', level: 'error', text: 'a\nb' }).split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[1], ' '.repeat(lines[0].length - 1) + 'b');
});

test('bundleName：本地时间、全数字——冒号在 Windows 文件名里非法', () => {
  assert.equal(bundleName(new Date(2026, 10, 27, 3, 4, 5)), 'support-20261127-030405.txt');
  assert.ok(!bundleName().includes(':'), '带冒号的文件名在 Windows 上存不下去');
  assert.ok(!/\//.test(bundleName()), '不能带路径分隔符');
  assert.match(bundleName(new Date('nope')), /^support-\d{8}-\d{6}\.txt$/, '非法日期要兜底成现在，不能抛');
});

test('bundleText：环境在最上、最近 error 在日志前、结尾提醒路径泄露', () => {
  const entries = [
    { time: '03:00:01', level: 'info', area: 'boot', text: '已启动' },
    { time: '03:00:02', level: 'error', area: 'inbound', text: 'onInbound is not defined' },
  ];
  const t = bundleText({
    diagnostics: 'dsh-roost 0.0.42 · 框架 未装', entries,
    now: new Date(2026, 10, 27, 3, 0, 28),
  });
  assert.ok(t.startsWith('dsh-roost 诊断包'));
  assert.ok(t.includes('dsh-roost 0.0.42 · 框架 未装'));
  assert.ok(t.includes('2026'));
  const iEnv = t.indexOf('[环境]');
  const iErr = t.indexOf('[最近 error]');
  const iAll = t.indexOf('[面板日志]');
  assert.ok(iEnv > 0 && iErr > iEnv && iAll > iErr,
    '顺序必须是 环境 → 最近 error → 全量日志：群里点开文件先看结论');
  assert.ok(t.includes('onInbound is not defined'), '日志正文要在文件里');
  assert.ok(t.includes('含本机路径'), '要提醒用户里面有自己的用户名');
});

test('bundleText：空数据也给结论，不留白让人以为文件坏了', () => {
  const t = bundleText({ diagnostics: 'x', entries: [] });
  assert.ok(t.includes('共 0 条'));
  assert.match(t, /没有 error/);
  const blank = bundleText({});
  assert.ok(blank.includes('（环境信息没读到）'), '环境没读到时也要写明，不能留一段空白');
  assert.ok(blank.includes('（空：插件刚启动，或日志被清过）'));
});

test('诊断包复用 buildSupportInfo：文件里的环境和弹窗里必须逐字一致', () => {
  assert.match(HOST, /const buildSupportInfo = async \(\) => \{/);
  const a = HOST.indexOf("regSupport('/support/info'");
  const b = HOST.indexOf("regSupport('/support/bundle'");
  const c = HOST.indexOf("regSupport('/support/faq'");
  assert.ok(a > 0 && b > a && c > b, '三条路由的顺序变了，下面的切片要跟着改');
  const infoSeg = HOST.slice(a, b);
  const bundleSeg = HOST.slice(b, c);
  assert.ok(infoSeg.includes('buildSupportInfo()'), '/support/info 没复用 buildSupportInfo');
  assert.ok(bundleSeg.includes('buildSupportInfo()'),
    '导出包没复用 buildSupportInfo——两处各拼一套，迟早一个说装了一个说没装，还一起贴进群里');
  assert.ok(bundleSeg.includes('redactText'), '整个文件出去前要过一遍脱敏：这份是要发出去的');
  assert.ok(bundleSeg.includes('dataDir()'), '写死别的目录在 macOS/Linux 上会失败');
  assert.ok(!/body\?\.(path|dir|name)/.test(bundleSeg), '不能接受前端传路径：这是导出，不是文件写入 API');
  /** 弹窗里那三条 error 也是同一份数据带出去的（在 buildSupportInfo 里，不在路由体里） */
  const buildSeg = HOST.slice(HOST.indexOf('const buildSupportInfo'), a);
  assert.ok(buildSeg.includes("pickRecent(logs, 'error', 3)"), 'buildSupportInfo 要带最近 3 条 error');
});

const ISSUE_DIR = new URL('../.github/ISSUE_TEMPLATE/', import.meta.url);
const BUG_YML = readFileSync(new URL('bug.yml', ISSUE_DIR), 'utf8');
const CFG_YML = readFileSync(new URL('config.yml', ISSUE_DIR), 'utf8');

test('issue 模板：四个必填 + 一个可选，正好是最常追问的那几样', () => {
  const blocks = BUG_YML.split(/\n  - type: /).slice(1);
  const got = {};
  for (const part of blocks) {
    const type = part.slice(0, part.indexOf('\n')).trim();
    const id = (part.match(/^    id: ([a-z0-9-]+)/m) || [])[1];
    if (!id) continue;
    if (type === 'checkboxes') { got[id] = 'checks'; continue; }
    got[id] = /validations:\s*\n\s+required: true/.test(part);
  }
  assert.deepEqual(got, {
    version: true, platform: true, what: true, diagnostics: true, logs: false, checks: 'checks',
  }, '必填项少一个模板就白做了：版本 / 平台 / 日志正是最常要再问一轮的三样');
  assert.match(BUG_YML, /options:[\s\S]{0,80}Windows[\s\S]{0,40}macOS[\s\S]{0,40}Linux/);
  assert.match(BUG_YML, /labels: \["bug"\]/, '不打标签，新 issue 会掉进未分类');
});

test('issue 模板：链接只指本仓 GitHub，不放 Gitee 的 issue 入口', () => {
  for (const [name, txt] of [['bug.yml', BUG_YML], ['config.yml', CFG_YML]]) {
    assert.ok(!txt.includes(FW_REPO), `${name} 混进了框架仓 ${FW_REPO}——点过去是另一个项目`);
    assert.ok(!txt.includes(GITEE_FW_REPO), `${name} 混进了框架仓的 Gitee 地址`);
    for (const m of txt.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)/g)) {
      assert.equal(m[1], SELF_REPO, `${name} 里的 GitHub 地址指向 ${m[1]}，应为 ${SELF_REPO}`);
    }
  }
  /**
   * Gitee 是 pull 镜像：维护者只在 GitHub 看 issue。
   * 在镜像上给入口，反馈会沉在那儿没人看，用户还以为提过了。
   */
  assert.ok(!/gitee\.com/i.test(CFG_YML), 'config.yml 不该再出现 Gitee');
  assert.ok(!/gitee\.com/i.test(BUG_YML), 'bug.yml 不该再出现 Gitee');
});

test('issue 模板教用户点的按钮，面板里真有', () => {
  for (const label of ['问题反馈', '复制诊断信息', '导出诊断包']) {
    assert.ok(BUG_YML.includes(label), `模板没提「${label}」——用户按图索骥会找不到`);
    assert.ok(CLIENT.includes(`'${label}'`), `模板让用户点「${label}」，但面板里没这个按钮`);
  }
});

/* ---------------- 框架网页日志（2026-11-27） ---------------- */

test('frameworkWebUrl：日志页 hash 拼在最后，密钥原样不动', () => {
  assert.equal(frameworkWebUrl('http://127.0.0.1:15207/?key=abc'),
    'http://127.0.0.1:15207/?key=abc#logs');
  /** 没设访问密钥时是裸地址，也要能用 */
  assert.equal(frameworkWebUrl('http://127.0.0.1:15207/'), 'http://127.0.0.1:15207/#logs');
  /** 已带 hash 的要替换掉：`#config#logs` 会停在配置页，点日志点不动 */
  assert.equal(frameworkWebUrl('http://127.0.0.1:15207/?key=a#config'),
    'http://127.0.0.1:15207/?key=a#logs');
  for (const v of ['', null, undefined, '   ']) {
    assert.equal(frameworkWebUrl(v), '', `${String(v)} 该返回空串，让调用方决定说什么`);
  }
});

test('弹窗：框架日志行给两个入口（网页版 + 文件夹）', () => {
  const seg = CLIENT.slice(CLIENT.indexOf('function SupportModal'), CLIENT.indexOf('function FeedbackCard'));
  assert.ok(seg.includes("openDir('framework-web')"), '缺「看网页日志」按钮');
  assert.ok(seg.includes("openDir('framework-logs')"), '「打开文件夹」不能被顶掉——框架没启动时只剩它');
  /** 网页版排在前面：能筛能搜，是主路径 */
  assert.ok(seg.indexOf("openDir('framework-web')") < seg.indexOf("openDir('framework-logs')"));
});

test('样式：roost-btn-primary 必须有对应规则', () => {
  /**
   * 这个类在面板里用了十几处（「复制诊断信息」就是一例），但 CSS 里从来没有它——
   * 于是所有「主要操作」都跟次要按钮长得一样，谁也没发现。
   * 没有样式不会报错，只会让设计意图静默失效，只能靠这条钉住。
   */
  assert.ok(CLIENT.includes('.roost-btn.roost-btn-primary{'),
    'CSS 里缺 roost-btn-primary 规则：主要操作会退化成普通按钮');
});

test('导出诊断包不依赖 /support/info —— 接口挂了正是最需要它的时候', () => {
  /**
   * 曾经写成 `busy: !info || bundleBusy`：`/support/info` 一失败，这个按钮
   * 永久变灰，用户连试都试不了。而那时候恰恰是最想导一份诊断包去求助的时刻。
   * `/support/bundle` 自己会重新聚合，没理由等 `info`。
   */
  const seg = CLIENT.slice(CLIENT.indexOf('function SupportModal'), CLIENT.indexOf('function FeedbackCard'));
  const at = seg.indexOf("btn('export-bundle'");
  assert.ok(at > 0, '弹窗里没有导出按钮');
  const line = seg.slice(at, seg.indexOf('),', at));
  assert.ok(!line.includes('!info'), '导出按钮又被 !info 拦住了：接口一挂就永久灰');
  assert.ok(line.includes('bundleBusy'), '至少要在导出过程中置灰，防止连点写出两个文件');
});

test('看网页日志：框架没在跑时必须拒绝并指路，不能给出一个打不开的地址', () => {
  const from = HOST.indexOf("regSupport('/support/open'");
  const seg = HOST.slice(from, HOST.indexOf('const offs = [', from));
  const web = seg.slice(seg.indexOf("which === 'framework-web'"), seg.indexOf("which === 'dsh-logs'"));
  assert.ok(web, 'framework-web 分支不见了');
  assert.ok(/if \(!fw\.installed\)/.test(web), '没装框架时先拒，别去拼地址');
  assert.ok(/if \(!fw\.running\)/.test(web),
    '框架没在跑时必须拒：打开是一片「无法访问」，用户会以为插件坏了');
  assert.ok(web.includes('首次接入'), '拒绝时要指到能解决它的那一页');
  assert.ok(web.includes('frameworkWebUrl(fw.webui)'), '地址要由 webui 拼，不能自己写死端口');
});

test('诊断包文件名只取一次 —— 取两次跨秒时撞名判断会失效', () => {
  /**
   * 原来先 `join(dir, bundleName())`，撞名时又 `bundleName()` 一次。
   * 跨秒的话第二次取到的 base 与已有 file 无关，`existsSync` 检查的是一个
   * 不存在的名字，于是后面的 `-2` 序号根本不会加上去。
   */
  const from = HOST.indexOf("regSupport('/support/bundle'");
  const seg = HOST.slice(from, HOST.indexOf("regSupport('/support/faq'", from));
  assert.equal((seg.match(/bundleName\(\)/g) || []).length, 1,
    'bundleName() 只能调一次，结果存进 base 复用');
  assert.ok(seg.includes('const base = bundleName()'));
});
