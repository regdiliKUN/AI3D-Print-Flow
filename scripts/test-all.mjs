#!/usr/bin/env node
/**
 * 依次运行全部回归测试。每个用例都是独立进程，互不污染；
 * 任意一个失败则整体返回非 0，便于脚本或 CI 直接判断。
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const SUITES = [
  ['配置校验', 'test-config.mjs'],
  ['任务状态', 'test-jobs.mjs'],
  ['下载续传', 'test-download.mjs'],
  ['工具函数', 'test-util.mjs'],
  ['STL 分析', 'test-stl.mjs'],
  ['CLI 播报', 'test-report.mjs'],
  ['错误契约', 'test-errors.mjs'],
  ['安装目录', 'test-install.mjs'],
  ['HTTP 接口', 'test-api.mjs'],
  ['图片交互', 'test-image-flow.mjs'],
  ['多模态输入', 'test-multimodal.mjs'],
  ['安全冒烟', 'smoke-test.mjs'],
];

const root = resolve(import.meta.dirname, '..');
const results = [];

for (const [label, file] of SUITES) {
  const startedAt = Date.now();
  const code = await new Promise((resolveCode) => {
    const child = spawn(process.execPath, [`scripts/${file}`], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('close', (exitCode) => {
      if (exitCode !== 0) process.stdout.write(`${output.trimEnd()}\n`);
      resolveCode(exitCode ?? -1);
    });
  });
  const ms = Date.now() - startedAt;
  results.push({ label, file, code, ms });
  console.log(`${code === 0 ? '[通过]' : '[失败]'} ${label.padEnd(6, '　')} ${file.padEnd(18)} ${ms} ms`);
}

const failed = results.filter((r) => r.code !== 0);
console.log('');
console.log(`共 ${results.length} 组，通过 ${results.length - failed.length} 组，失败 ${failed.length} 组。`);
if (failed.length) {
  console.log(`失败用例：${failed.map((r) => r.file).join('、')}`);
  process.exitCode = 1;
}
