#!/usr/bin/env node
/**
 * Local HTTP smoke test. Starts an isolated server instance on a free-ish port
 * and verifies health, static security headers, origin checks and JSON errors.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const node = process.execPath;
const child = spawn(node, ['app/server.mjs', '--no-open'], {
  cwd: resolve(import.meta.dirname, '..'),
  env: {
    ...process.env,
    AI3D_NO_OPEN: '1',
    AI3D_NO_SAVE_PORT: '1',
    AI3D_PORT: String(18000 + (process.pid % 500)),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let output = '';
const base = await new Promise((resolvePromise, reject) => {
  const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 15000);
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
    const match = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(output);
    if (match) {
      clearTimeout(timer);
      resolvePromise(`http://127.0.0.1:${match[1]}`);
    }
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.once('exit', (code) => reject(new Error(`server exited ${code}:\n${output}`)));
});

async function check(path, options) {
  const res = await fetch(`${base}${path}`, options);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { res, text, json };
}

try {
  const health = await check('/api/health');
  assert.equal(health.res.status, 200);
  assert.equal(health.json.ok, true);
  assert.equal(health.json.app, 'ai3d-print-flow');
  assert.ok(health.json.version);

  const diagnostics = await check('/api/diagnostics');
  assert.equal(diagnostics.res.status, 200);
  assert.equal(diagnostics.json.ok, true);
  assert.equal(diagnostics.json.app, 'ai3d-print-flow');
  assert.ok(diagnostics.json.paths.logs);
  assert.equal(typeof diagnostics.json.log.text, 'string');

  const page = await check('/');
  assert.equal(page.res.status, 200);
  assert.match(page.res.headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.match(page.res.headers.get('content-security-policy') || '', /form-action 'self'/);
  assert.equal(page.res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.res.headers.get('x-frame-options'), 'DENY');
  assert.match(page.res.headers.get('permissions-policy') || '', /camera=\(\)/);
  assert.equal(page.res.headers.get('cross-origin-opener-policy'), 'same-origin');

  const script = await check('/app.js?v=smoke');
  assert.equal(script.res.status, 200);
  assert.match(script.res.headers.get('cache-control') || '', /no-cache/);
  const etag = script.res.headers.get('etag');
  assert.ok(etag);
  const cached = await fetch(`${base}/app.js?v=smoke`, { headers: { 'If-None-Match': etag } });
  assert.equal(cached.status, 304);

  const pageHead = await fetch(`${base}/`, { method: 'HEAD' });
  assert.equal(pageHead.status, 200);
  assert.ok(Number(pageHead.headers.get('content-length')) > 1000);

  const evil = await check('/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
    body: JSON.stringify({ action: 'app.info' }),
  });
  assert.equal(evil.res.status, 403);

  const wrongType = await check('/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ action: 'app.info' }),
  });
  assert.equal(wrongType.res.status, 415);

  const info = await check('/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'app.info' }),
  });
  assert.equal(info.res.status, 200, info.text);
  assert.equal(info.json.ok, true);

  // 错误码契约：未知操作必须是稳定的 E_UNKNOWN_ACTION
  const unknown = await check('/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'nope.nope' }),
  });
  assert.equal(unknown.res.status, 400);
  assert.equal(unknown.json.code, 'E_UNKNOWN_ACTION');

  // 诊断快照在未检测过时不得触发探测
  assert.equal(diagnostics.json.checks, null);

  // 产物列表：空工作区也应返回结构化的空列表
  const artifacts = await check('/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'artifacts.list', payload: { limit: 5 } }),
  });
  assert.equal(artifacts.res.status, 200, artifacts.text);
  assert.ok(Array.isArray(artifacts.json.items));

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=',
    'base64',
  );
  const upload = await fetch(`${base}/api/upload?kind=input&name=smoke.png`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: png,
  });
  const uploaded = await upload.json();
  assert.equal(upload.status, 200, JSON.stringify(uploaded));
  assert.equal(uploaded.size, png.length);

  const fileUrl = `${base}/api/file?path=${encodeURIComponent(uploaded.path)}`;
  const head = await fetch(fileUrl, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), png.length);
  assert.equal(head.headers.get('accept-ranges'), 'bytes');

  const range = await fetch(fileUrl, { headers: { Range: 'bytes=0-7' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 0-7/${png.length}`);
  assert.equal((await range.arrayBuffer()).byteLength, 8);

  const downloadHead = await fetch(`${base}/api/download?path=${encodeURIComponent(uploaded.path)}`, {
    method: 'HEAD',
  });
  assert.equal(downloadHead.status, 200);
  assert.match(downloadHead.headers.get('content-disposition') || '', /attachment;/);

  const badUpload = await fetch(`${base}/api/upload?kind=input&name=smoke-bad.png`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: Buffer.from('not a png'),
  });
  assert.equal(badUpload.status, 400);

  await fetch(`${base}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'config.save', payload: { patch: { lastImage: '' } } }),
  });
  rmSync(uploaded.path, { force: true });

  console.log(`smoke test OK (${base})`);
} finally {
  child.kill();
  setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {}
  }, 1000).unref();
}
