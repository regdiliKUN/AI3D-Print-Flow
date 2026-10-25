#!/usr/bin/env node
/**
 * ComfyUI 安装目录检查与不完整目录保留的回归测试。
 *
 * 背景：官方 Easy Install 只要看到同名目录就退出。旧代码只检查
 * `ComfyUI\main.py`，所以「有 main.py、缺 python_embeded\python.exe」的
 * 半成品目录不会被改名，一键部署每次都会在安装器阶段失败。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectComfyInstall, preserveIncompleteComfy } from '../app/lib/installer.mjs';

const root = mkdtempSync(join(tmpdir(), 'ai3d-test-install-'));

function touch(path) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'x');
}

function fakeJobs() {
  const logs = [];
  return {
    logs,
    log(id, line, stream = 'info') {
      logs.push({ id, line, stream });
    },
  };
}

function makeInstall(name, { main = false, python = false } = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  if (main) touch(join(dir, 'ComfyUI', 'main.py'));
  if (python) touch(join(dir, 'python_embeded', 'python.exe'));
  return dir;
}

try {
  // ---- inspectComfyInstall ------------------------------------------
  const missing = inspectComfyInstall(join(root, 'does-not-exist'));
  assert.equal(missing.exists, false);
  assert.equal(missing.complete, false);
  assert.deepEqual(missing.missing, ['ComfyUI\\main.py', 'python_embeded\\python.exe']);

  const onlyMain = makeInstall('only-main', { main: true });
  const mainState = inspectComfyInstall(onlyMain);
  assert.equal(mainState.exists, true);
  assert.equal(mainState.hasMain, true);
  assert.equal(mainState.hasPython, false);
  assert.equal(mainState.complete, false);
  assert.deepEqual(mainState.missing, ['python_embeded\\python.exe']);

  const onlyPython = makeInstall('only-python', { python: true });
  const pythonState = inspectComfyInstall(onlyPython);
  assert.equal(pythonState.hasMain, false);
  assert.equal(pythonState.hasPython, true);
  assert.equal(pythonState.complete, false);
  assert.deepEqual(pythonState.missing, ['ComfyUI\\main.py']);

  const complete = makeInstall('complete', { main: true, python: true });
  assert.equal(inspectComfyInstall(complete).complete, true);
  assert.deepEqual(inspectComfyInstall(complete).missing, []);

  // ---- preserveIncompleteComfy --------------------------------------
  const jobs = fakeJobs();
  const partial = makeInstall('partial', { main: true });
  const backup = preserveIncompleteComfy(jobs, 'job_test', partial);
  assert.ok(backup, '不完整目录应被改名');
  assert.match(backup, /\.incomplete-\d+/);
  assert.equal(existsSync(partial), false, '原目录应已移走');
  assert.equal(existsSync(join(backup, 'ComfyUI', 'main.py')), true, '旧文件必须保留');
  assert.equal(inspectComfyInstall(backup).complete, false);
  assert.equal(jobs.logs.length, 1);
  assert.match(jobs.logs[0].line, /不完整/);
  assert.match(jobs.logs[0].line, /python_embeded/);
  assert.equal(jobs.logs[0].stream, 'warn');

  const partial2 = makeInstall('partial2', { python: true });
  const backup2 = preserveIncompleteComfy(fakeJobs(), 'job_test', partial2);
  assert.ok(backup2);
  assert.equal(existsSync(join(backup2, 'python_embeded', 'python.exe')), true);
  assert.equal(inspectComfyInstall(backup2).hasMain, false);

  const completeAgain = makeInstall('complete-again', { main: true, python: true });
  assert.equal(preserveIncompleteComfy(fakeJobs(), 'job_test', completeAgain), null);
  assert.equal(existsSync(completeAgain), true, '完整目录不得被改名');

  assert.equal(preserveIncompleteComfy(fakeJobs(), 'job_test', join(root, 'never-created')), null);

  console.log('install test OK');
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
