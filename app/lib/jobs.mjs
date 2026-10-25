import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const MAX_JOBS = 30;
const MAX_CAPTURE = 256 * 1024;

function appendTail(current, text, max = MAX_CAPTURE) {
  const next = current + text;
  return next.length > max ? next.slice(-max) : next;
}

export class JobManager extends EventEmitter {
  constructor() {
    super();
    this.jobs = new Map();
    this.children = new Map();
    this.aborts = new Map();
  }

  create(type, title, meta = {}) {
    const id = `job_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
    const job = {
      id,
      type,
      title,
      status: 'running',
      progress: 0,
      message: '准备中…',
      stage: '',
      detail: '',
      bytes: null,
      totalBytes: null,
      speed: null,
      eta: null,
      indeterminate: false,
      logs: [],
      result: null,
      error: null,
      meta,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      endedAt: null,
    };
    this.jobs.set(id, job);
    this.emit('update', this.publicJob(job));
    this.trim();
    return job;
  }

  trim() {
    const list = [...this.jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    for (const job of list.slice(MAX_JOBS)) {
      if (job.status !== 'running') this.jobs.delete(job.id);
    }
  }

  publicJob(job) {
    if (!job) return null;
    return {
      id: job.id,
      type: job.type,
      title: job.title,
      status: job.status,
      progress: job.progress,
      message: job.message,
      stage: job.stage,
      detail: job.detail,
      bytes: job.bytes,
      totalBytes: job.totalBytes,
      speed: job.speed,
      eta: job.eta,
      indeterminate: job.indeterminate,
      logs: job.logs.slice(-400),
      result: job.result,
      error: job.error,
      meta: job.meta,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      endedAt: job.endedAt,
    };
  }

  get(id) {
    return this.publicJob(this.jobs.get(id));
  }

  list(limit = 30) {
    return [...this.jobs.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit)
      .map((j) => this.publicJob({ ...j, logs: [] }));
  }

  hasRunning(type) {
    for (const job of this.jobs.values()) {
      if (job.status === 'running' && (!type || job.type === type)) return job;
    }
    return null;
  }

  runningCount() {
    let count = 0;
    for (const job of this.jobs.values()) if (job.status === 'running') count += 1;
    return count;
  }

  cancelAll(reason = '服务停止，任务已取消') {
    const running = [...this.jobs.values()].filter((job) => job.status === 'running');
    for (const job of running) {
      this.cancel(job.id, reason);
    }
    return running.length;
  }

  update(id, patch) {
    const job = this.jobs.get(id);
    if (!job) return null;
    Object.assign(job, patch);
    job.updatedAt = new Date().toISOString();
    this.emit('update', this.publicJob(job));
    return job;
  }

  log(id, line, stream = 'info') {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'running' || line == null) return;
    const clean = String(line).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
    for (const text of clean.split(/\r?\n/)) {
      if (!text.trim()) continue;
      job.logs.push({ t: new Date().toISOString(), stream, text: text.slice(0, 2000) });
      if (job.logs.length > 800) job.logs.splice(0, job.logs.length - 800);
    }
    this.emit('update', this.publicJob(job));
  }

  progress(id, percent, message, extra = {}) {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'running') return;
    job.progress = Math.max(job.progress, Math.min(100, Math.round(percent)));
    if (message) job.message = message;
    Object.assign(job, extra);
    job.updatedAt = new Date().toISOString();
    this.emit('update', this.publicJob(job));
  }

  done(id, result, message = '完成') {
    const current = this.jobs.get(id);
    if (!current || current.status !== 'running') return this.publicJob(current);
    const job = this.update(id, {
      status: 'done',
      progress: 100,
      message,
      result,
      endedAt: new Date().toISOString(),
    });
    this.children.delete(id);
    this.aborts.delete(id);
    return this.publicJob(job);
  }

  fail(id, error, message = '失败') {
    const current = this.jobs.get(id);
    // A cancelled child process often exits with a non-zero code. Never turn
    // that expected exit into a red error card after the user cancelled.
    if (!current || current.status !== 'running') return this.publicJob(current);
    const text = error instanceof Error ? error.message : String(error || '未知错误');
    this.log(id, text, 'error');
    const job = this.update(id, {
      status: 'error',
      message,
      error: text,
      endedAt: new Date().toISOString(),
    });
    this.children.delete(id);
    this.aborts.delete(id);
    return this.publicJob(job);
  }

  cancel(id, reason = '已取消') {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'running') return false;
    this.aborts.get(id)?.abort();
    const child = this.children.get(id);
    if (child?.pid) {
      try {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        killer.on('error', () => {});
      } catch {}
    }
    this.update(id, {
      status: 'cancelled',
      message: reason,
      endedAt: new Date().toISOString(),
    });
    this.children.delete(id);
    this.aborts.delete(id);
    return true;
  }

  abortSignal(id) {
    const existing = this.aborts.get(id);
    if (existing) return existing.signal;
    const ac = new AbortController();
    this.aborts.set(id, ac);
    return ac.signal;
  }

  runProcess(id, command, args = [], opts = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        this.children.delete(id);
        resolve(result);
      };

      const current = this.jobs.get(id);
      if (!current || current.status !== 'running') {
        resolve({ ok: false, code: -1, stdout: '', stderr: '任务已取消', cancelled: true });
        return;
      }

      this.log(id, `$ ${command} ${args.join(' ')}`, 'cmd');
      let child;
      try {
        child = spawn(command, args, {
          cwd: opts.cwd,
          windowsHide: opts.windowsHide !== false,
          windowsVerbatimArguments: opts.windowsVerbatimArguments === true,
          // Batch installers end with `pause`; an ignored stdin makes it return
          // instead of leaving the install job stuck forever.
          stdio: opts.stdio || ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ...(opts.env || {}) },
        });
      } catch (err) {
        finish({ ok: false, code: -1, stdout: '', stderr: String(err) });
        return;
      }
      this.children.set(id, child);

      let stdout = '';
      let stderr = '';
      let buffer = '';
      const onData = (chunk, stream) => {
        const text = chunk.toString();
        if (stream === 'stdout') stdout = appendTail(stdout, text);
        else stderr = appendTail(stderr, text);
        buffer += text;
        const lines = buffer.split(/\r?\n|\r/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.trim()) {
            this.log(id, line, stream);
            opts.onLine?.(line, stream);
          }
        }
      };

      child.stdout?.on('data', (d) => onData(d, 'stdout'));
      child.stderr?.on('data', (d) => onData(d, 'stderr'));

      const timer = opts.timeout
        ? setTimeout(() => {
            try {
              const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
              killer.on('error', () => {});
            } catch {}
            this.log(id, `超时（${opts.timeout} ms），进程已终止`, 'error');
            // If taskkill itself is blocked, do not leave the job running
            // forever waiting for a close event that may never arrive.
            setTimeout(() => {
              finish({ ok: false, code: -2, stdout, stderr: appendTail(stderr, '进程超时且无法确认已退出') });
            }, 10000).unref();
          }, opts.timeout)
        : null;

      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        finish({ ok: false, code: -1, stdout, stderr: appendTail(stderr, String(err)) });
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (buffer.trim()) {
          this.log(id, buffer, 'stdout');
          opts.onLine?.(buffer, 'stdout');
        }
        finish({ ok: code === 0, code: code ?? -1, stdout, stderr });
      });
    });
  }

  spawnInteractive(id, command, args, opts = {}) {
    this.log(id, `$ start ${command} ${args.join(' ')}`, 'cmd');
    try {
      const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
      const line = [
        'start',
        '""',
        '/D',
        quote(opts.cwd || process.cwd()),
        quote(command),
        ...args.map(quote),
      ].join(' ');
      const child = spawn('cmd.exe', ['/d', '/c', line], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        windowsVerbatimArguments: true,
      });
      child.unref();
      return true;
    } catch (err) {
      this.log(id, String(err), 'error');
      return false;
    }
  }
}

export const jobs = new JobManager();
