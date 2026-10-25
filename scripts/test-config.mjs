#!/usr/bin/env node
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { validateConfigPatch } from '../app/lib/config.mjs';

assert.throws(() => validateConfigPatch({ evilKey: 1 }), /不支持的配置项/);
assert.throws(() => validateConfigPatch(null), /必须是对象/);
assert.throws(() => validateConfigPatch({ port: 80 }), /端口/);
assert.throws(() => validateConfigPatch({ comfyUrl: 'file:///etc/passwd' }), /http/);
assert.throws(() => validateConfigPatch({ repairMode: 'chaos' }), /修复模式/);
assert.throws(() => validateConfigPatch({ targetHeightMm: 9999 }), /目标高度/);

const relative = validateConfigPatch({ installRoot: 'relative\\install' });
assert.ok(isAbsolute(relative.installRoot), 'relative install root should be resolved');

const url = validateConfigPatch({ comfyUrl: 'http://127.0.0.1:8188/' });
assert.equal(url.comfyUrl, 'http://127.0.0.1:8188');

const valid = validateConfigPatch({
  port: 17860,
  targetHeightMm: 80.25,
  decimateRatio: 0.5,
  preset: '2k',
  lastImage: 'C:\\work\\a.png',
});
assert.equal(valid.targetHeightMm, 80.3);
assert.equal(valid.decimateRatio, 0.5);
assert.equal(valid.preset, '2k');

// A __proto__ key from JSON must be rejected like any other unknown key.
const polluted = JSON.parse('{"__proto__":{"polluted":true}}');
assert.throws(() => validateConfigPatch(polluted), /不支持的配置项/);
assert.equal({}.polluted, undefined);
console.log('config validation test OK');
