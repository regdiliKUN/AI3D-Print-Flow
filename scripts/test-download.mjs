#!/usr/bin/env node
/**
 * Small self-contained download-resume test. It does not touch the internet:
 * a local HTTP server serves a 1 MB payload and intentionally drops the first
 * connection halfway through the body.
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { downloadFile } from '../app/lib/installer.mjs';

const root = join(tmpdir(), `ai3d-download-test-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

const payload = Buffer.alloc(1024 * 1024);
for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;
const expected = createHash('sha256').update(payload).digest('hex');

let requests = 0;
let retryHits = 0;
let cutOnce = true;
const server = createServer((req, res) => {
  requests += 1;
  if (req.url === '/retry.bin') {
    retryHits += 1;
    if (retryHits === 1) {
      res.writeHead(429, { 'Retry-After': '0', 'Content-Length': '0' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Length': payload.length, ETag: '"retry-payload-v1"' });
    res.end(payload);
    return;
  }
  const range = /^bytes=(\d+)-/.exec(String(req.headers.range || ''));
  const start = range ? Number(range[1]) : 0;
  if (start >= payload.length) {
    res.writeHead(416, { 'Content-Range': `bytes */${payload.length}` });
    res.end();
    return;
  }
  const body = payload.subarray(start);
  if (start === 0 && cutOnce) {
    cutOnce = false;
    res.writeHead(200, { 'Content-Length': payload.length });
    res.write(body.subarray(0, 350 * 1024), () => {
      setTimeout(() => req.socket.destroy(), 30);
    });
    return;
  }
  const headers = { 'Content-Length': body.length, ETag: '"test-payload-v1"' };
  if (start > 0) headers['Content-Range'] = `bytes ${start}-${payload.length - 1}/${payload.length}`;
  res.writeHead(start > 0 ? 206 : 200, headers);
  res.end(body);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/payload.bin`;
const dest = join(root, 'payload.bin');
let lastBytes = 0;

const result = await downloadFile(url, dest, {
  maxAttempts: 4,
  connectTimeoutMs: 5000,
  idleTimeoutMs: 5000,
  onProgress: (received) => {
    lastBytes = received;
  },
});
const actual = createHash('sha256').update(readFileSync(dest)).digest('hex');
if (actual !== expected) throw new Error(`hash mismatch after resume (${lastBytes} progress bytes)`);
if (requests < 2) throw new Error('server was not retried after the dropped connection');
if (!result.resumed) throw new Error('download did not report a resumed stream');

// A stale part larger than the remote file must be discarded, not renamed.
const staleDest = join(root, 'stale.bin');
const stalePart = `${staleDest}.part`;
writeFileSync(stalePart, Buffer.alloc(payload.length + 100, 7));
await downloadFile(url, staleDest, { maxAttempts: 3, connectTimeoutMs: 5000, idleTimeoutMs: 5000 });
const staleHash = createHash('sha256').update(readFileSync(staleDest)).digest('hex');
if (staleHash !== expected) throw new Error('stale part was promoted instead of re-downloaded');
if (existsSync(stalePart) || existsSync(`${stalePart}.json`)) throw new Error('part/meta files were not cleaned up');

// A 429 with Retry-After must be retried rather than treated as a hard failure.
const retryDest = join(root, 'retry.bin');
const retryUrl = `http://127.0.0.1:${port}/retry.bin`;
await downloadFile(retryUrl, retryDest, {
  maxAttempts: 3,
  connectTimeoutMs: 5000,
  idleTimeoutMs: 5000,
});
if (retryHits < 2) throw new Error('429 Retry-After was not retried');
const retryHash = createHash('sha256').update(readFileSync(retryDest)).digest('hex');
if (retryHash !== expected) throw new Error('retry payload hash mismatch');

server.close();
const finalSize = statSync(dest).size;
rmSync(root, { recursive: true, force: true });
console.log(`download resume OK (${requests} requests, ${finalSize} bytes)`);
