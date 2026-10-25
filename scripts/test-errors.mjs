#!/usr/bin/env node
/**
 * 错误契约单测：确认「校验类错误 → 4xx」「引擎级异常 → 5xx」的分流正确，
 * 且 Node 的 errno 不会作为 API 错误码泄漏出去。
 */
import assert from 'node:assert/strict';
import { AppError, ERROR_CODES, errorPayload } from '../app/lib/errors.mjs';

const cases = [
  ['AppError 保留自身状态码', new AppError(ERROR_CODES.BUSY, '任务忙', { status: 409, hint: '等一等' }), 409, 'E_BUSY', /等一等/],
  ['带 status 的普通错误', Object.assign(new Error('请求体过大'), { status: 413 }), 413, 'E_TOO_LARGE', /^$/],
  ['ENOSPC 映射为磁盘满', Object.assign(new Error('no space'), { code: 'ENOSPC' }), 507, 'E_DISK_FULL', /清理磁盘/],
  ['校验类普通错误 → 400', new Error('GLB 不存在：x.glb'), 400, 'E_INVALID', /^$/],
  ['TypeError → 500 内部错误', new TypeError('x is not a function'), 500, 'E_INTERNAL', /server\.log/],
  ['ReferenceError → 500', new ReferenceError('foo is not defined'), 500, 'E_INTERNAL', /server\.log/],
  ['非 Error 抛出物不崩', 'boom', 400, 'E_INVALID', /^$/],
  ['未登记的 4xx 仍给 E_INVALID', new Error('x'), 422, 'E_INVALID', /^$/, { status: 422 }],
  ['未登记的 5xx 给 E_INTERNAL', new Error('x'), 503, 'E_INTERNAL', /server\.log/, { status: 503 }],
];

let failed = 0;
for (const [name, err, status, code, hint, forced = {}] of cases) {
  const payload = errorPayload(err, forced);
  try {
    assert.equal(payload.ok, false);
    assert.equal(payload.status, status);
    assert.equal(payload.code, code);
    assert.match(payload.hint, hint);
    assert.equal(typeof payload.error, 'string');
    assert.ok(!/^E[A-Z]+$/.test(payload.code), '错误码不得是 Node errno');
    console.log(`ok   ${name} → ${payload.status} ${payload.code}`);
  } catch (err2) {
    failed += 1;
    console.log(`FAIL ${name} → ${JSON.stringify(payload)}（${err2.message.split('\n')[0]}）`);
  }
}

console.log(failed === 0 ? '错误契约测试 OK' : `错误契约测试失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
