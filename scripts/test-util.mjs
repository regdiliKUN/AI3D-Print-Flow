#!/usr/bin/env node
/**
 * util.mjs 的边界用例：文件名清洗与临时文件清理。
 *
 * 这些用例来自真实缺陷：上传接口直接使用客户端提供的文件名，
 * `..` 会逃出目标目录，Windows 保留设备名与尾部点号会导致落盘失败。
 */
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanupStaleTemp, formatBytes, safeName } from '../app/lib/util.mjs';

const cases = [
  ['..', 'file'],
  ['.', 'file'],
  ['...', 'file'],
  ['CON', '_CON'],
  ['nul.png', '_nul.png'],
  ['COM1.glb', '_COM1.glb'],
  ['a.png.', 'a.png'],
  ['a.png ', 'a.png'],
  ['  spaced.png  ', 'spaced.png'],
  ['x/y.png', 'y.png'],
  ['..\\..\\etc\\passwd', 'passwd'],
  ['   ', 'file'],
  ['', 'file'],
  [null, 'file'],
  ['model.glb', 'model.glb'],
  ['中文 模型.png', '中文 模型.png'],
];

for (const [input, expected] of cases) {
  assert.equal(safeName(input), expected, `safeName(${JSON.stringify(input)})`);
}

const long = `${'x'.repeat(300)}.safetensors`;
const trimmed = safeName(long);
assert.ok(trimmed.length <= 150, '长文件名应被截断');
assert.ok(trimmed.endsWith('.safetensors'), '截断后应保留扩展名');

assert.equal(formatBytes(0), '0 B');
assert.equal(formatBytes(1024), '1.0 KB');
assert.equal(formatBytes(-1), '0 B');

const dir = join(tmpdir(), `ai3d-test-util-${process.pid}-${Date.now()}`);
mkdirSync(dir, { recursive: true });
try {
  const stale = join(dir, '.upload-1-deadbeef.part');
  const fresh = join(dir, '.upload-2-cafebabe.part');
  const staleCfg = join(dir, 'config.json.tmp-123');
  const keep = join(dir, 'model.glb');
  for (const file of [stale, fresh, staleCfg, keep]) writeFileSync(file, 'x');
  const old = (Date.now() - 3 * 24 * 3600 * 1000) / 1000;
  utimesSync(stale, old, old);
  utimesSync(staleCfg, old, old);

  const removed = cleanupStaleTemp(dir);
  assert.equal(removed.length, 2, `应清理 2 个残留文件，实际 ${removed.length}`);
  assert.ok(!existsSync(stale), '过期 .part 应被删除');
  assert.ok(existsSync(fresh), '新鲜 .part 必须保留');
  assert.ok(existsSync(keep), '普通文件必须保留');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('util test OK');
