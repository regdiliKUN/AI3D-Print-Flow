#!/usr/bin/env node
import assert from 'node:assert/strict';
import { JobManager } from '../app/lib/jobs.mjs';

const jobs = new JobManager();
const job = jobs.create('test', 'cancel test');
const running = jobs.runProcess(job.id, process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
  timeout: 20000,
});
// Let spawn attach before cancelling.
await new Promise((resolve) => setTimeout(resolve, 250));
assert.equal(jobs.cancel(job.id, 'test cancel'), true);
const result = await running;
assert.equal(result.cancelled, undefined);
const cancelled = jobs.get(job.id);
assert.equal(cancelled.status, 'cancelled');
assert.equal(cancelled.message, 'test cancel');

// A late child-process rejection must not overwrite the cancelled state.
jobs.fail(job.id, new Error('late failure'));
assert.equal(jobs.get(job.id).status, 'cancelled');

// A completed job must not be overwritten by a late failure either.
const doneJob = jobs.create('test', 'done test');
jobs.done(doneJob.id, { ok: true });
jobs.fail(doneJob.id, new Error('late failure'));
assert.equal(jobs.get(doneJob.id).status, 'done');

// Log lines are bounded, and ANSI escape sequences are stripped.
const logJob = jobs.create('test', 'log test');
for (let i = 0; i < 1000; i += 1) jobs.log(logJob.id, `\u001b[31mline ${i}\u001b[0m`);
const logs = jobs.get(logJob.id).logs;
assert.ok(logs.length <= 400, 'public log tail should be bounded');
assert.ok(!logs.some((entry) => entry.text.includes('\u001b')), 'ANSI must be stripped');
assert.equal(jobs.hasRunning('no-such-type'), null);
console.log('jobs cancel/state/log test OK');
