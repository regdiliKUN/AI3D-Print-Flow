#!/usr/bin/env node
/**
 * CLI 任务播报器用例。
 *
 * 回归点：`publicJob.logs` 是日志尾部，每次更新都会重发已打印过的行；
 * 早期实现只记住最后一行，导致同一批日志被反复打印。
 */
import assert from 'node:assert/strict';
import { createJobReporter } from '../app/lib/report.mjs';

const lines = [];
const report = createJobReporter({ write: (line) => lines.push(line) });

const all = Array.from({ length: 12 }, (_, i) => ({ t: `t${i}`, stream: 'stdout', text: `line-${i}` }));
const snapshot = (n) => ({
  id: 'job',
  progress: n,
  message: `步骤 ${n}`,
  logs: all.slice(Math.max(0, n - 5), n),
});

for (let n = 1; n <= 12; n += 1) report(snapshot(n));

const logLines = lines.filter((l) => l.startsWith('  '));
assert.equal(logLines.length, 12, '每行日志只应打印一次');
assert.equal(new Set(logLines).size, 12, '不应出现重复日志');
assert.equal(lines.filter((l) => l.startsWith('[')).length, 12, '每次更新打印一行进度');

const before = lines.length;
report(snapshot(12));
assert.equal(lines.length, before, '重复投递同一快照不应再次打印');

// 消息变化但进度不变时也应播报
report({ id: 'job', progress: 12, message: '步骤 12（重试）', logs: [] });
assert.equal(lines.length, before + 1, '消息变化时应打印新状态');

console.log('report test OK');
