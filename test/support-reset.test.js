// 危险操作的计划函数：宁可多测几行，不能靠肉眼相信白名单。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, parse, resolve } from 'node:path';
import { homedir } from 'node:os';

import {
  RESET_KEEP_PATHS, resetDshSettings, clearDataPlan, safeRoot, backupStamp,
  DSH_CLEAR_NAMES, DSH_KEEP_NAMES,
} from '../src/support-reset.js';

const DEFAULTS = {
  enabled: true,
  dryRun: false,
  server: { port: 17321, token: '' },
  setup: { roostDir: '', wizardVersion: 0, wizardSkippedVersion: 0, frameworkAutoUpdate: false },
  roostHost: { enabled: false, url: '', token: '', transport: 'auto' },
};

test('恢复默认：连接引导与凭证搬回来，开关与向导以外的设置回默认', () => {
  const cur = {
    enabled: false,
    dryRun: true,
    server: { port: 18000, token: 'panel-token' },
    setup: { roostDir: 'D:\\bot', wizardVersion: 1, wizardSkippedVersion: 1, frameworkAutoUpdate: true },
    roostHost: { enabled: true, url: 'http://127.0.0.1:6801', token: 'host-token', transport: 'ws' },
  };
  const out = resetDshSettings(cur, DEFAULTS);
  assert.equal(out.enabled, true);
  assert.equal(out.dryRun, false);
  assert.equal(out.server.port, 18000);
  assert.equal(out.server.token, 'panel-token');
  assert.equal(out.setup.roostDir, 'D:\\bot');
  assert.equal(out.setup.wizardVersion, 1);
  assert.equal(out.setup.frameworkAutoUpdate, false, '非保留项必须回默认');
  assert.equal(out.roostHost.enabled, true);
  assert.equal(out.roostHost.url, 'http://127.0.0.1:6801');
  assert.equal(out.roostHost.token, 'host-token');
  assert.equal(out.roostHost.transport, 'auto');
  assert.equal(cur.enabled, false, '不改原对象');
  assert.equal(DEFAULTS.server.port, 17321, '不污染默认值');
});

test('恢复默认：空值 / 掩码 / 坏端口都不搬，避免把怪值当凭证写回去', () => {
  const out = resetDshSettings({
    setup: { roostDir: '', wizardVersion: 0 },
    server: { port: 0, token: '******' },
    roostHost: { token: '******' },
  }, DEFAULTS);
  assert.equal(out.setup.roostDir, '');
  assert.equal(out.server.port, 17321);
  assert.equal(out.server.token, '', '掩码不是凭证，不能被当成真值保留');
  assert.equal(out.roostHost.token, '');
  assert.ok(RESET_KEEP_PATHS.every((p) => Array.isArray(p) && p.length));
});

test('清理计划：不认未知 side；dsh 白名单里有记忆、没有配置与凭证目录', () => {
  const bad = clearDataPlan({ side: 'all', dshDir: 'D:\\data' });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'side');

  const plan = clearDataPlan({ side: 'dsh', dshDir: 'D:\\data\\dsh-roost', stamp: 'clear-x' });
  assert.equal(plan.ok, true);
  const names = plan.jobs.map((j) => j.from.slice(j.from.lastIndexOf('\\') + 1));
  assert.ok(names.includes('memory.json'));
  assert.ok(names.includes('journal.sqlite'));
  assert.ok(names.includes('gallery'));
  for (const mustKeep of DSH_KEEP_NAMES) assert.equal(names.includes(mustKeep), false, `${mustKeep} 不能被清`);
  assert.ok(plan.jobs.every((j) => j.to.includes(join('backups', 'clear-x'))));
});

test('清理计划：护栏拒绝根目录 / 家目录 / 盘根', () => {
  assert.equal(safeRoot(''), false);
  assert.equal(safeRoot('/'), false);
  assert.equal(safeRoot(parse('/').root), false);
  assert.equal(safeRoot(homedir()), false);
  assert.equal(safeRoot(resolve(homedir(), '..')), false);
  assert.equal(clearDataPlan({ side: 'dsh', dshDir: homedir() }).reason, 'dsh-dir');
  assert.equal(clearDataPlan({ side: 'framework', fwDir: '/' }).reason, 'framework-dir');
});

test('清理计划：框架只清 data/ 下真实条目，跳过备份目录与隐藏项', () => {
  const plan = clearDataPlan({
    side: 'framework', fwDir: 'D:\\bot', stamp: 'clear-1',
    fwDataNames: [
      'bots', 'quota.json', '_backup', '.gitkeep', '../escape', 'identity.json',
      'backups', 'config', 'secrets', 'onnx-models',
    ],
  });
  assert.equal(plan.ok, true);
  const names = plan.jobs.map((j) => j.from.slice(j.from.lastIndexOf('\\') + 1));
  assert.deepEqual(names, ['bots', 'quota.json', 'identity.json']);
  assert.ok(plan.jobs.every((j) => j.from.includes(join('bot', 'data'))));
  assert.ok(plan.jobs.every((j) => j.to.includes(join('_backup', 'clear-1'))));
});

test('清理计划：两边都清时共用同一个备份时间戳', () => {
  const plan = clearDataPlan({
    side: 'both', dshDir: 'D:\\dsh\\dsh-roost', fwDir: 'D:\\bot',
    fwDataNames: ['quota.json'], stamp: 'clear-both',
  });
  assert.equal(plan.ok, true);
  assert.ok(plan.jobs.some((j) => j.side === 'dsh'));
  assert.ok(plan.jobs.some((j) => j.side === 'framework'));
  assert.ok(plan.jobs.every((j) => j.to.includes('clear-both')));
  assert.ok(plan.kept.includes('config.json'));
  assert.ok(DSH_CLEAR_NAMES.length > 20, '白名单不该短得可疑');
});

test('备份目录名：全数字、无冒号，Windows 能存', () => {
  const s = backupStamp(new Date(2026, 10, 28, 2, 9, 5));
  assert.equal(s, 'clear-20261128-020905');
  assert.equal(/[:\\/]/.test(s), false);
});
