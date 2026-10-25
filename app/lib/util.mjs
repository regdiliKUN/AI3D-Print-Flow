import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

/**
 * Replace a destination file, retrying transient Windows locks (antivirus,
 * indexer, explorer preview). The final rename is attempted before deleting
 * the destination, so a normal replacement stays atomic.
 */
export async function replaceFile(temp, dest, { retries = 5 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      await rename(temp, dest);
      return;
    } catch (err) {
      lastError = err;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      try {
        if (existsSync(dest)) await unlink(dest);
      } catch {}
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 60 * (attempt + 1)));
    }
  }
  throw lastError || new Error(`无法替换文件：${dest}`);
}

export function run(cmd, args = [], opts = {}) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        windowsHide: true,
        env: { ...process.env, ...(opts.env || {}) },
      });
    } catch (err) {
      resolvePromise({ ok: false, code: -1, stdout, stderr: String(err), ms: 0 });
      return;
    }

    const timeout = opts.timeout ?? 30000;
    const timer = setTimeout(() => {
      try {
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          child.kill('SIGKILL');
        }
      } catch {}
    }, timeout);

    child.stdout?.on('data', (d) => {
      stdout += d.toString();
      if (stdout.length > 200000) stdout = stdout.slice(-200000);
      opts.onStdout?.(d.toString());
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 200000) stderr = stderr.slice(-200000);
      opts.onStderr?.(d.toString());
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ ok: false, code: -1, stdout, stderr: stderr + String(err), ms: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ ok: code === 0, code: code ?? -1, stdout, stderr, ms: Date.now() - started });
    });
  });
}

export function spawnDetached(cmd, args = [], opts = {}) {
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: { ...process.env, ...(opts.env || {}) },
  });
  child.unref();
  return child.pid;
}

export function openPath(path) {
  if (!path) return false;
  try {
    // explorer.exe accepts the path as one argument, including spaces and CJK characters.
    const child = spawn('explorer.exe', [path], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function openUrl(url) {
  try {
    const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function findFile(root, names, maxDepth = 4) {
  if (!isDir(root)) return null;
  const wanted = names.map((n) => String(n).toLowerCase());
  let frontier = [{ dir: root, depth: 0 }];
  while (frontier.length) {
    const next = [];
    for (const { dir, depth } of frontier) {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isFile() && wanted.includes(entry.name.toLowerCase())) return full;
        if (entry.isDirectory() && depth < maxDepth && !/^(\.git|__pycache__|node_modules)$/i.test(entry.name)) {
          next.push({ dir: full, depth: depth + 1 });
        }
      }
    }
    frontier = next;
  }
  return null;
}

export function listDirs(root, predicate = () => true) {
  if (!isDir(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && predicate(e.name))
      .map((e) => join(root, e.name));
  } catch {
    return [];
  }
}

export function findExecutable(candidates) {
  for (const c of candidates) {
    if (c && isFile(c)) return c;
  }
  return null;
}

const GIT_CANDIDATES = [
  join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd', 'git.exe'),
  join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'cmd', 'git.exe'),
  join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'cmd', 'git.exe'),
  join(process.env.USERPROFILE || '', 'scoop', 'apps', 'git', 'current', 'cmd', 'git.exe'),
];

export async function findGit() {
  const candidates = [...GIT_CANDIDATES];
  // `spawn('git')` can fail on Windows when Git is only available through
  // `git.exe`/`git.cmd`; `where.exe` returns the real absolute path.
  const where = await run('where.exe', ['git.exe'], { timeout: 5000 });
  if (where.ok) {
    for (const line of where.stdout.split(/\r?\n/)) {
      const path = line.trim();
      if (path) candidates.push(path);
    }
  }
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate) || !isFile(candidate)) continue;
    seen.add(candidate);
    const version = await run(candidate, ['--version'], { timeout: 8000 });
    if (version.ok) {
      return { path: candidate, version: version.stdout.trim() || 'git' };
    }
  }
  return null;
}

// Windows 保留设备名：即使带扩展名（CON.png）也无法创建文件。
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Turn an arbitrary user-supplied name into a single safe file name.
 *
 * Security notes:
 * - `.` and `..` are rejected: `join(dir, '..')` would escape the target
 *   directory, and the upload endpoint accepts a client-supplied name.
 * - Windows silently strips trailing dots/spaces, so a name like `a.png.`
 *   would create `a.png` while callers still stat `a.png.` and fail.
 * - Reserved device names (CON, NUL, COM1, ...) cannot be created at all.
 */
export function safeName(name, fallback = 'file') {
  const raw = basename(String(name ?? '').replace(/\0/g, ''));
  let base = raw
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  if (!base || /^\.+$/.test(base)) return fallback;
  if (RESERVED.test(base)) base = `_${base}`;
  // Keep headroom for the longest suffix we append (`_YYYYMMDD_HHMMSS.stl`).
  if (base.length > 150) {
    const dot = base.lastIndexOf('.');
    const ext = dot > 0 && base.length - dot <= 12 ? base.slice(dot) : '';
    base = base.slice(0, 150 - ext.length) + ext;
  }
  return base || fallback;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function normalizePath(p) {
  return p ? resolve(String(p).replace(/^"|"$/g, '')) : '';
}

/**
 * Remove stale temporary files left behind by an interrupted upload or a
 * crashed config write. Only files matching `pattern` and older than
 * `maxAgeMs` are touched, so an in-flight transfer started seconds ago (or a
 * download resume point) is never deleted.
 */
export function cleanupStaleTemp(dir, { pattern = /^\..*\.part$|\.tmp-\d+$/, maxAgeMs = 24 * 3600 * 1000 } = {}) {
  if (!isDir(dir)) return [];
  const removed = [];
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return removed;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isFile() || !pattern.test(entry.name)) continue;
    const full = join(dir, entry.name);
    try {
      if (now - statSync(full).mtimeMs < maxAgeMs) continue;
      unlinkSync(full);
      removed.push(full);
    } catch {}
  }
  return removed;
}
