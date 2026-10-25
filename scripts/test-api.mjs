#!/usr/bin/env node
/**
 * HTTP 接口回归测试。在临时沙箱里启动一份服务，配置指向空的安装目录，
 * 因此不会读取或修改本机真实的 ComfyUI / 配置。
 *
 * 覆盖：健康检查、诊断快照、错误码契约、上传校验、产物列表，
 * 以及「交互式安装动作失败后不得留下 running 任务」这个关键回归点。
 */
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const PKG_ROOT = resolve(import.meta.dirname, '..');
const root = join(tmpdir(), `ai3d-test-api-${process.pid}-${Date.now()}`);

function makeSandbox() {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  for (const dir of ['app', 'blender', 'vendor', 'docs']) {
    cpSync(join(PKG_ROOT, dir), join(root, dir), { recursive: true });
  }
  cpSync(join(PKG_ROOT, 'package.json'), join(root, 'package.json'));
  const installRoot = join(root, 'AI3D');
  mkdirSync(installRoot, { recursive: true });
  mkdirSync(join(root, 'config'), { recursive: true });
  cpSync(join(PKG_ROOT, 'config', 'default.json'), join(root, 'config', 'default.json'));
  writeFileSync(
    join(root, 'config', 'config.json'),
    JSON.stringify({ version: 1, installRoot, comfyuiRoot: join(installRoot, 'ComfyUI-Easy-Install') }, null, 2),
  );
  for (const dir of ['workspace/input', 'workspace/glb', 'workspace/stl', 'workspace/reports', 'workflows', 'logs']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
}

function startServer(port) {
  const child = spawn(process.execPath, ['app/server.mjs', '--no-open'], {
    cwd: root,
    env: { ...process.env, AI3D_NO_OPEN: '1', AI3D_NO_SAVE_PORT: '1', AI3D_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const ready = new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`服务未启动：\n${output}`)), 20000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const match = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(output);
      if (match) {
        clearTimeout(timer);
        resolveReady(`http://127.0.0.1:${match[1]}`);
      }
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
  });
  return { child, ready };
}

const port = 18200 + (process.pid % 400);
makeSandbox();
const { child, ready } = startServer(port);
const base = await ready;

const post = (action, payload = {}, headers = { 'Content-Type': 'application/json' }) =>
  fetch(`${base}/api/action`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action, payload }),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));

try {
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.app, 'ai3d-print-flow');
  assert.ok(health.version);

  const diagnostics = await (await fetch(`${base}/api/diagnostics`)).json();
  assert.equal(diagnostics.checks, null, '未检测时诊断不应触发探测');
  assert.ok(diagnostics.paths.logs);

  // 错误码契约
  const unknown = await post('does.not.exist');
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.code, 'E_UNKNOWN_ACTION');

  const wrongType = await post('app.info', {}, { 'Content-Type': 'text/plain' });
  assert.equal(wrongType.status, 415);
  assert.equal(wrongType.body.code, 'E_CONTENT_TYPE');

  // 配置白名单
  const badConfig = await post('config.save', { patch: { evilKey: 1 } });
  assert.equal(badConfig.status, 400);
  assert.equal(badConfig.body.code, 'E_INVALID');

  // 上传：非法文件名与伪造图片都必须被拒绝
  const traversal = await fetch(`${base}/api/upload?kind=input&name=${encodeURIComponent('../evil.png')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: Buffer.from('not a png'),
  });
  assert.equal(traversal.status, 400, '伪造图片应被拒绝');

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=',
    'base64',
  );
  const upload = await fetch(`${base}/api/upload?kind=input&name=ok.png`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: png,
  });
  assert.equal(upload.status, 200);
  const uploaded = await upload.json();
  assert.equal(uploaded.size, png.length);
  const preview = await fetch(`${base}/api/file?path=${encodeURIComponent(uploaded.path)}`);
  assert.equal(preview.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png, 'Preview must serve uploaded PNG bytes');
  const repeated = await fetch(`${base}/api/upload?kind=input&name=ok.png`, {
    method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png,
  });
  assert.equal(repeated.status, 200);
  const repeatedImage = await repeated.json();
  assert.notEqual(repeatedImage.path, uploaded.path, 'Same-name uploads must preserve previous files');
  assert.deepEqual(Buffer.from(await (await fetch(`${base}/api/file?path=${encodeURIComponent(uploaded.path)}`)).arrayBuffer()), png);

  // 产物列表
  writeFileSync(join(root, 'workspace', 'stl', 'a.stl'), Buffer.alloc(128, 1));
  const artifacts = await post('artifacts.list', { limit: 5 });
  assert.equal(artifacts.body.items.length, 1);
  assert.equal(artifacts.body.items[0].name, 'a.stl');

  // 关键回归：交互式安装动作失败后不得留下 running 任务
  for (const action of ['install.comfy.run', 'install.torch28.run', 'install.trellis.run', 'install.pixel.run']) {
    const res = await post(action);
    assert.equal(res.status, 400, `${action} 应返回 400，实际 ${res.status}`);
  }
  const jobs = await (await fetch(`${base}/api/jobs`)).json();
  const running = jobs.jobs.filter((job) => job.status === 'running');
  assert.equal(running.length, 0, `不应有残留 running 任务，实际 ${running.length}`);
  const retry = await post('install.comfy.run');
  assert.doesNotMatch(String(retry.body.error || ''), /正在进行中/, '失败后不应被自己的任务阻塞');

  console.log('api test OK');
} finally {
  child.kill();
  setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {}
  }, 1000).unref();
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
