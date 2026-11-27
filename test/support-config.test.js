// 诊断包配置视图：泄密一次就够了，这些断言全是「假密钥不能出现在产物里」。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { redactConfig, configFeatureSummary, DEFAULT_MASK } from '../src/support-config.js';
import { bundleText } from '../src/support.js';

test('脱敏：webui.accessKey / appSecret / token 抹掉，appId 与开关保留', () => {
  const raw = {
    appId: '1234567890',
    logLevel: 'debug',
    webui: { enabled: true, accessKey: 'PANEL-KEY-ABCDEFG', port: 15207 },
    bot: { appSecret: 'QQ-SECRET-123456', dryRun: false },
    up: { apiKey: 'sk-abcdefghijklmnopqrstuvwxyz' },
  };
  const out = redactConfig(raw);
  assert.equal(out.appId, '1234567890', 'AppID 不是密钥，排障要看是哪个机器人');
  assert.equal(out.logLevel, 'debug');
  assert.equal(out.webui.enabled, true, '布尔开关不能因为同在 webui 段就被抹掉');
  assert.equal(out.webui.port, 15207);
  assert.equal(out.webui.accessKey, DEFAULT_MASK);
  assert.equal(out.bot.appSecret, DEFAULT_MASK);
  assert.equal(out.bot.dryRun, false);
  assert.equal(out.up.apiKey, DEFAULT_MASK);
  const text = JSON.stringify(out);
  for (const s of ['PANEL-KEY-ABCDEFG', 'QQ-SECRET-123456', 'sk-abcdefghijklmnopqrstuvwxyz']) {
    assert.equal(text.includes(s), false, `假密钥 ${s} 漏进了配置视图`);
  }
  assert.equal(raw.webui.accessKey, 'PANEL-KEY-ABCDEFG', '不能就地改原对象');
});

test('脱敏：主人 openid / 白名单只留条数，不泄露标识本身', () => {
  const out = redactConfig({
    owners: ['openid-alice', 'openid-bob'],
    whitelist: { enabled: true, users: ['openid-carol'], groups: ['group-dave'] },
  });
  assert.equal(out.owners, '[已隐藏 2 项]');
  assert.equal(out.whitelist.enabled, true);
  assert.equal(out.whitelist.users, '[已隐藏 1 项]');
  assert.equal(out.whitelist.groups, '[已隐藏 1 项]');
  const text = JSON.stringify(out);
  assert.equal(/openid-|group-dave/.test(text), false);
});

test('脱敏：已知密钥即使出现在无关字段也要抹', () => {
  const out = redactConfig(
    { note: '之前贴过 TOKEN-XYZ-123456 到这里' },
    { secrets: ['TOKEN-XYZ-123456'] },
  );
  assert.equal(out.note.includes('TOKEN-XYZ-123456'), false);
  assert.ok(out.note.includes(DEFAULT_MASK));
});

test('脱敏：PEM 私钥整串抹掉，不留头尾', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg...\n-----END PRIVATE KEY-----';
  const out = redactConfig({ security: { trust: { key: pem } } });
  assert.equal(JSON.stringify(out).includes('MIIEvQIBADANBg'), false);
});

test('脱敏：常见第三方 token 形状也认得，粘在备注里也不落盘', () => {
  const note = [
    'xoxb-123456789012-abcdefghijkl',
    'AKIAABCDEFGHIJKLMNOP',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghijklmnop',
  ].join(' / ');
  const out = redactConfig({
    note,
    embedded: '用户备注 xoxb-123456789012-abcdefghijkl 结束 / AKIAABCDEFGHIJKLMNOP / '
      + 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghijklmnop',
  });
  const text = JSON.stringify(out);
  for (const s of ['xoxb-', 'AKIAABCDEFGHIJKLMNOP', 'eyJhbGciOiJIUzI1NiJ9']) {
    assert.equal(text.includes(s), false, `${s} 形状漏出去了`);
  }
});

test('功能摘要：dsh 开关逐条列出，框架机器人只报主人条数', () => {
  const text = configFeatureSummary({
    dshFeatures: [
      { id: 'botEnabled', label: '总开关', on: true },
      { id: 'dryRun', label: '试运行', on: false },
    ],
    fwGlobal: { logLevel: 'debug', webui: { enabled: true, port: 15207 }, webhook: { enabled: false } },
    fwBots: [{ id: 'main', enabled: true, intents: 311296, plugins: { mode: 'all' }, whitelist: { enabled: true }, owners: ['a', 'b'] }],
  });
  assert.match(text, /开 总开关（botEnabled）/);
  assert.match(text, /关 试运行（dryRun）/);
  assert.match(text, /日志级别：debug/);
  assert.match(text, /1 只鸟/);
  assert.match(text, /main：enabled=true/);
  assert.match(text, /主人=2/);
  assert.equal(text.includes('openid'), false);
});

test('诊断包正文：配置段排在日志前面，且不吞掉原有内容', () => {
  const text = bundleText({
    diagnostics: 'dsh-roost 1.2.3',
    configNote: '[功能开关 · dsh-roost]\n  开 总开关（botEnabled）',
    entries: [{ time: '01:02:03', level: 'error', area: 'inbound', text: '崩了' }],
  });
  assert.match(text, /\[环境\]/);
  assert.match(text, /\[配置与功能\]/);
  assert.match(text, /开 总开关（botEnabled）/);
  assert.ok(text.indexOf('[配置与功能]') < text.indexOf('[最近 error]'), '配置段要在日志前面');
  assert.match(text, /崩了/);
});
