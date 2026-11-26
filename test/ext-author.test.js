/**
 * 扩展作者引导（2026-11-27）。
 *
 * 对照 aurabot 的「模块」页补的引导层。这里锁的是**最容易静默坏掉**的几件：
 *   · fork 忘了排除 node_modules（复制几百 MB）、忘了删 `.source.json`
 *     （新副本被当成市场资产，以后更新拒绝覆盖）；
 *   · 话术里没有目录 / 没有「只改这个目录」的边界（DSH 会顺手改宿主代码）；
 *   · 教程文件不在包里（用户点开是空的）；
 *   · 前端把引导卡排在已装清单后面（等于没有）。
 *
 * 跑法：node --test test/ext-author.test.js
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  plantAuthorDocs, authorPrompt, forkExtension, countFiles, AUTHOR_GUIDE, GUIDE_URL,
} from '../src/ext-author.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOMES = [];
after(() => {
  for (const d of HOMES) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* 忽略 */ }
  }
});
function tmp() {
  const d = fs.mkdtempSync(join(os.tmpdir(), 'roost-ext-author-'));
  HOMES.push(d);
  return d;
}

test('教程文件随包存在，且写清了「清单 / 权限 / 生效方式 / 投稿」四件事', () => {
  const file = join(ROOT, 'docs', AUTHOR_GUIDE);
  assert.ok(fs.existsSync(file), `包里的 docs/${AUTHOR_GUIDE} 不能少，不然面板点开是空的`);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.length > 2000, '教程要有实质内容，不是一句「见 API.md」');
  for (const key of ['plugin.json', 'dsh-extension', 'serverName', 'scopes', '重启 DSH', 'index.json']) {
    assert.ok(text.includes(key), `教程里应提到 ${key}`);
  }
  assert.match(GUIDE_URL, /github\.com\/roost-qq\/qq-bot-roost/, 'GitHub 链接要指向本仓');
});

test('plantAuthorDocs：投放到扩展根目录，缺的文件跳过、内容没变不重写', () => {
  const base = tmp();
  const docsSrc = join(base, 'docs');
  fs.mkdirSync(docsSrc, { recursive: true });
  fs.writeFileSync(join(docsSrc, 'API.md'), '# API\n');
  fs.writeFileSync(join(docsSrc, 'extension.d.ts'), 'export {}\n');
  const extRoot = join(base, 'extensions');

  const first = plantAuthorDocs({ extRoot, docsSrc });
  assert.deepEqual(first.sort(), ['API.md', 'extension.d.ts']);
  assert.equal(fs.readFileSync(join(extRoot, 'API.md'), 'utf8'), '# API\n');

  /** 第二次：内容一样就不写 —— 用 mtime 判「有没有动过盘」 */
  const before = fs.statSync(join(extRoot, 'API.md')).mtimeMs;
  plantAuthorDocs({ extRoot, docsSrc });
  assert.equal(fs.statSync(join(extRoot, 'API.md')).mtimeMs, before, '内容没变不该重写');

  /** 源里少一份：只投放存在的，不抛错 */
  fs.rmSync(join(docsSrc, 'extension.d.ts'));
  const partial = plantAuthorDocs({ extRoot: join(base, 'extensions2'), docsSrc });
  assert.deepEqual(partial, ['API.md']);
});

test('plantAuthorDocs：目录不可写时只记日志，不把「复制话术」连带弄挂', () => {
  const base = tmp();
  const docsSrc = join(base, 'docs');
  fs.mkdirSync(docsSrc, { recursive: true });
  fs.writeFileSync(join(docsSrc, 'API.md'), '# API\n');
  /** 用一个文件冒充目录：mkdirSync 必然失败 */
  const bogus = join(base, 'not-a-dir');
  fs.writeFileSync(bogus, 'x');
  const warns = [];
  const got = plantAuthorDocs({ extRoot: bogus, docsSrc, log: { warn: (m) => warns.push(m) } });
  assert.deepEqual(got, []);
  assert.equal(warns.length, 1, '失败要留一条日志');
});

test('authorPrompt：带目录、带文档路径、带占位符和「只改这个目录」的边界', () => {
  const p = authorPrompt({ dir: '/data/extensions/weather', doc: '/data/extensions/API.md' });
  assert.ok(p.includes('/data/extensions/weather'), '要让 DSH 知道改哪个目录');
  assert.ok(p.includes('/data/extensions/API.md'), '要让 DSH 先读文档');
  assert.ok(p.includes('【'), '留了让用户填需求的占位');
  assert.ok(p.includes('只改这个目录里的文件'), '边界必须写死在话术里');
  assert.ok(p.includes('重启 DSH') || p.includes('重连 MCP'), '要讲清改完怎么生效');
});

test('forkExtension：整目录复制，清单改名、删校验和与来源标记，跳过 node_modules / deps', () => {
  const base = tmp();
  const from = join(base, 'src-ext');
  fs.mkdirSync(join(from, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(join(from, 'node_modules', 'dep', 'index.js'), 'x');
  fs.mkdirSync(join(from, 'deps'), { recursive: true });
  fs.writeFileSync(join(from, 'deps', 'ffmpeg.bin'), 'x');
  fs.writeFileSync(join(from, 'plugin.json'), JSON.stringify({
    id: 'src-ext', serverName: 'src-ext', name: '旧的', description: 'd',
    transport: 'stdio', command: 'node', args: ['server.mjs'],
    sha256: 'deadbeef', locallyModified: true, modifiedAt: 123,
  }, null, 2));
  fs.writeFileSync(join(from, '.source.json'), JSON.stringify({ repo: 'x/y' }));
  fs.writeFileSync(join(from, 'server.mjs'), '// hi\n');

  const to = join(base, 'new-ext');
  const r = forkExtension({ from, to, newId: 'new-ext', name: '新的' });
  assert.equal(r.manifest.id, 'new-ext');
  assert.equal(r.manifest.serverName, 'new-ext', 'serverName 必须跟着 id 改，否则工具前缀对不上');
  assert.equal(r.manifest.name, '新的');
  assert.equal('sha256' in r.manifest, false, '校验和盖的是旧内容，必须清掉');
  assert.equal('locallyModified' in r.manifest, false);
  assert.equal('modifiedAt' in r.manifest, false);

  assert.equal(fs.existsSync(join(to, 'node_modules')), false, 'node_modules 不能复制');
  assert.equal(fs.existsSync(join(to, 'deps')), false, 'deps 是宿主共享依赖，不能复制');
  assert.equal(fs.existsSync(join(to, '.source.json')), false, '留着会被当成市场资产，更新时拒绝覆盖');
  assert.equal(fs.existsSync(join(to, 'server.mjs')), true);
  assert.equal(r.files, 2, '只该有 plugin.json 与 server.mjs');
});

test('forkExtension：清单坏了要把半份目标清掉，不留「有清单没代码」的目录', () => {
  const base = tmp();
  const from = join(base, 'broken');
  fs.mkdirSync(from, { recursive: true });
  fs.writeFileSync(join(from, 'plugin.json'), '{ 这不是 JSON');
  fs.writeFileSync(join(from, 'server.mjs'), 'x');
  const to = join(base, 'out');
  assert.throws(() => forkExtension({ from, to, newId: 'out' }));
  assert.equal(fs.existsSync(to), false, '失败后目标目录不能留着，否则面板会报「清单不合格」');
});

test('countFiles：只数文件，不把目录算进去', () => {
  const base = tmp();
  fs.mkdirSync(join(base, 'a', 'b'), { recursive: true });
  fs.writeFileSync(join(base, 'a', 'x.txt'), '1');
  fs.writeFileSync(join(base, 'a', 'b', 'y.txt'), '2');
  assert.equal(countFiles(join(base, 'a')), 2);
  assert.equal(countFiles(join(base, 'nope')), 0);
});

test('前端：引导卡排在已装清单之前，三个动作与教程都在，空状态提到「自己写」', () => {
  const src = fs.readFileSync(join(ROOT, 'client', 'client.js'), 'utf8');
  const extTab = src.slice(src.indexOf('function ExtTab('), src.indexOf('function ExtMarketTab('));
  assert.ok(extTab.includes('h(ExtAuthoringCard'), '已装页要有引导卡');
  assert.ok(extTab.indexOf('ExtAuthoringCard') < extTab.indexOf('ExtSettingsBlock'),
    '引导卡必须在清单前面，否则用户先看到一屏已装项，还是不知道能自己写');
  assert.ok(extTab.indexOf('ExtWizardBlock') < extTab.indexOf('ExtSettingsBlock'),
    '新建向导也要在清单前面');

  assert.ok(src.includes("get('/extensions/prompt')"), '引导卡要能拿到话术');
  assert.ok(src.includes("post('/extensions/open'"), '打开文件夹要走宿主');
  assert.ok(src.includes("'/extensions/fork'"), '复制一份来改要调 fork');
  assert.ok(src.includes('复制一份来改') && src.includes('打开文件夹') && src.includes('复制给 DSH 的话'));

  const marketTab = src.slice(src.indexOf('function ExtMarketTab('), src.indexOf('function ExtUiPage('));
  assert.ok(marketTab.includes('ExtGuideBlock'), '市场页底部也要有教程');

  assert.match(src, /还没装扩展[^]{0,120}自己写一个/, '空状态要告诉用户「可以自己写」');
  assert.match(src, /r\.prompt[\s\S]{0,200}clipboard\.writeText/, '骨架生成后要自动复制话术');
});

test('宿主：四条引导路由都经 regAuthor 注册（清理时才会被注销）', () => {
  const src = fs.readFileSync(join(ROOT, 'src', 'host.js'), 'utf8');
  for (const p of ['guide', 'prompt', 'open', 'fork']) {
    assert.ok(src.includes(`regAuthor('/extensions/${p}'`), `${p} 路由要用 regAuthor，否则重载会重复注册`);
  }
  assert.ok(src.includes('...authorOffs'), 'offs 要展开 authorOffs，不然清理函数漏掉它们');
});
