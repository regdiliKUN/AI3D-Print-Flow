import {
  appendFileSync,
  closeSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';
import http from 'node:http';
import { statfs } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
import { URL } from 'node:url';
import { loadConfig, publicConfig, saveConfig } from './lib/config.mjs';
import { checkEnvironment, invalidateChecks, locateBlender, peekChecks } from './lib/checks.mjs';
import { runDeployDoctor } from './lib/doctor.mjs';
import { reuseSummary } from './lib/models.mjs';
import { jobs } from './lib/jobs.mjs';
import {
  downloadComfyUI,
  downloadQwenModels,
  installBlender,
  oneClickDeploy,
  openChitubox,
  openComfyUI,
  openDownload,
  openFolder,
  runComfyInstaller,
  runPixelInstaller,
  runTorch28,
  runTrellisInstaller,
  startComfyUI,
} from './lib/installer.mjs';
import { preparePixelWorkflow, prepareQwenWorkflow, installVendorWorkflows, listWorkflowFiles, presetInfo } from './lib/workflows.mjs';
import { runPostprocess, verifyStlFile } from './lib/postprocess.mjs';
import { analyzeStl } from './lib/stl.mjs';
import {
  ensureDirs,
  LOGS_DIR,
  PUBLIC_DIR,
  APP_ROOT,
  VERSION,
  resolveWorkspace,
  resolveComfyRoot,
} from './lib/paths.mjs';
import {
  cleanupStaleTemp,
  formatBytes,
  isFile,
  openPath,
  openUrl,
  replaceFile,
  run,
  safeName,
} from './lib/util.mjs';
import { AppError, ERROR_CODES, errorPayload } from './lib/errors.mjs';

ensureDirs();
const config = loadConfig();
const START_PORT = Number(process.env.AI3D_PORT || config.port || 17860);
const SERVER_LOG = join(LOGS_DIR, 'server.log');
const LOG_MAX_BYTES = 5 * 1024 * 1024;
let logWrites = 0;

/**
 * An upload interrupted by a crash or a power loss leaves `.upload-*.part`
 * files behind; a killed config write leaves `config.json.tmp-*`. Both are
 * harmless but slowly eat disk in the workspace, so they are swept once at
 * startup (older than 24 h only, so live transfers are never touched).
 */
function sweepStaleTempFiles() {
  const ws = resolveWorkspace(config);
  const targets = [join(ws, 'input'), join(ws, 'glb'), join(APP_ROOT, 'config')];
  for (const dir of targets) {
    const removed = cleanupStaleTemp(dir);
    if (removed.length) logLine('warn', `已清理 ${removed.length} 个残留临时文件（${dir}）`);
  }
}

function rotateServerLog() {
  try {
    if (!existsSync(SERVER_LOG) || statSync(SERVER_LOG).size < LOG_MAX_BYTES) return;
    for (let i = 2; i >= 1; i -= 1) {
      const from = `${SERVER_LOG}.${i}`;
      const to = `${SERVER_LOG}.${i + 1}`;
      if (existsSync(from)) {
        if (existsSync(to)) unlinkSync(to);
        renameSync(from, to);
      }
    }
    renameSync(SERVER_LOG, `${SERVER_LOG}.1`);
  } catch {}
}

function errorText(err) {
  if (!err) return 'Unknown error';
  if (err instanceof Error) return err.stack || `${err.name}: ${err.message}`;
  return String(err);
}

function logLine(level, message, detail = '') {
  logWrites += 1;
  if (logWrites % 50 === 0) rotateServerLog();
  const clean = (value) => String(value).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${clean(message)}${detail ? `\n${clean(detail)}` : ''}\n`;
  try {
    appendFileSync(SERVER_LOG, line, 'utf8');
  } catch {}
  if (level === 'error') console.error(line.trimEnd());
  else console.log(line.trimEnd());
}

function logError(context, err) {
  logLine('error', context, errorText(err));
}

function readLogTail(maxBytes = 64 * 1024) {
  try {
    const text = readFileSync(SERVER_LOG, 'utf8');
    return {
      text: text.slice(-maxBytes),
      truncated: text.length > maxBytes,
    };
  } catch {
    return { text: '', truncated: false };
  }
}

process.on('uncaughtException', (err) => {
  // Never let a background install/download take the whole local service down.
  logError('uncaughtException (service kept alive)', err);
});
process.on('unhandledRejection', (err) => {
  logError('unhandledRejection (service kept alive)', err);
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.stl': 'model/stl',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
};

const MAX_UPLOAD = {
  input: 40 * 1024 ** 2,
  glb: 4 * 1024 ** 3,
};

const STATIC_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  securityHeaders(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text) {
  securityHeaders(res);
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function pipeFile(req, res, file, options = {}) {
  const stream = createReadStream(file, options);
  const abort = () => {
    if (!stream.destroyed) stream.destroy();
  };
  req.once('aborted', abort);
  res.once('close', abort);
  stream.on('error', (err) => {
    logError(`读取文件失败 ${file}`, err);
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: '读取文件失败', hint: '文件可能已被移动或删除，请刷新后重试。' });
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
}

function readJson(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolvePromise, reject) => {
    const type = String(req.headers['content-type'] || '').toLowerCase();
    if (!/^application\/json(?:\s*;|$)/.test(type)) {
      reject(Object.assign(new Error('请求必须使用 application/json'), { status: 415 }));
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const onData = (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        // Drain the rest of the body instead of destroying the socket, so the
        // 413 response can still reach the browser.
        req.removeListener('data', onData);
        req.resume();
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        resolvePromise(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(Object.assign(new Error('请求体不是有效 JSON'), { status: 400 }));
      }
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function originAllowed(req) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return true; // CLI and curl have no Origin header.
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const host = String(req.headers.host || '').toLowerCase();
  return /^https?:$/.test(parsed.protocol) && parsed.host.toLowerCase() === host;
}

function hostAllowed(req) {
  const host = String(req.headers.host || '').toLowerCase();
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
}

function isInside(parent, child) {
  const p = process.platform === 'win32' ? parent.toLowerCase() : parent;
  const c = process.platform === 'win32' ? child.toLowerCase() : child;
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

async function freeDisk(path) {
  let probe = path;
  while (!existsSync(probe)) {
    const parent = resolve(probe, '..');
    if (parent === probe) break;
    probe = parent;
  }
  try {
    const stats = await statfs(probe);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

function safeStatic(urlPath) {
  let clean;
  try {
    clean = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, '');
  } catch {
    return null;
  }
  if (clean.includes('\0')) return null;
  const full = resolve(PUBLIC_DIR, clean || 'index.html');
  if (!isInside(resolve(PUBLIC_DIR), full)) return null;
  return full;
}

function workspaceFile(urlPath) {
  const p = new URL(urlPath, 'http://127.0.0.1').searchParams.get('path');
  if (!p) return null;
  const full = resolve(p);
  const ws = resolve(resolveWorkspace(loadConfig()));
  if (!isInside(ws, full)) return null;
  return full;
}

function sendWorkspaceFile(req, res, path, { download = false } = {}) {
  const stat = statSync(path);
  const ext = extname(path).toLowerCase();
  const headers = {
    'Content-Type': download ? 'application/octet-stream' : MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
  };
  if (download) {
    const filename = path.split(/[\\/]/).pop();
    const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    headers['Content-Disposition'] = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  }

  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  const range = String(req.headers.range || '');
  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (match && stat.size > 0) {
    if (match[1]) start = Number(match[1]);
    if (match[2]) end = Number(match[2]);
    if (!match[1] && match[2]) {
      start = Math.max(0, stat.size - Number(match[2]));
      end = stat.size - 1;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= stat.size) {
      securityHeaders(res);
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    end = Math.min(end, stat.size - 1);
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  }

  headers['Content-Length'] = Math.max(0, end - start + 1);
  securityHeaders(res);
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || stat.size === 0) {
    res.end();
    return;
  }
  pipeFile(req, res, path, { start, end });
}

function userPath(p) {
  if (!p) return '';
  return resolve(APP_ROOT, String(p).replace(/^"|"$/g, ''));
}

/**
 * ComfyUI/output can accumulate tens of thousands of preview images. The GLB
 * scan is bounded so "导入最新 GLB" never turns into a multi-second freeze.
 */
const GLB_SCAN_LIMIT = 20000;

function findLatestGlb(comfyRoot) {
  const roots = [
    join(comfyRoot, 'ComfyUI', 'output', '3d', 'PixelArtistry_watertight'),
    join(comfyRoot, 'ComfyUI', 'output', '3d', 'ComfyUI'),
    join(comfyRoot, 'ComfyUI', 'output', '3d'),
    join(comfyRoot, 'ComfyUI', 'output'),
  ];
  const found = [];
  let scanned = 0;
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let frontier = [{ dir: root, depth: 0 }];
    let foundHere = 0;
    while (frontier.length && scanned < GLB_SCAN_LIMIT) {
      const next = [];
      for (const { dir, depth } of frontier) {
        let entries = [];
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          scanned += 1;
          if (scanned > GLB_SCAN_LIMIT) break;
          const full = join(dir, e.name);
          if (e.isFile() && /\.(glb|gltf)$/i.test(e.name)) {
            try {
              // One stat instead of two (mtime + size were separate calls).
              const info = statSync(full);
              if (info.size > 0) {
                found.push({ path: full, mtime: info.mtimeMs, size: info.size });
                foundHere += 1;
              }
            } catch {}
          } else if (e.isDirectory() && depth < 4) {
            next.push({ dir: full, depth: depth + 1 });
          }
        }
      }
      frontier = next;
    }
    if (foundHere) break;
  }
  if (found.length > 1) found.sort((a, b) => b.mtime - a.mtime);
  return found[0] || null;
}

async function pickFile(kind) {
  const filter = kind === 'image'
    ? 'Image files (*.png;*.jpg;*.jpeg;*.webp)|*.png;*.jpg;*.jpeg;*.webp|All files (*.*)|*.*'
    : '3D files (*.glb;*.gltf)|*.glb;*.gltf|All files (*.*)|*.*';
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = 'AI3D Print Flow - 选择文件'
$d.Filter = '${filter.replace(/'/g, "''")}'
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }
`;
  const result = await run('powershell', ['-NoProfile', '-STA', '-Command', script], { timeout: 120000 });
  const path = result.stdout.trim().split(/\r?\n/).pop() || '';
  return path && existsSync(path) ? path : '';
}

function uploadSignatureOk(path, name, kind) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.alloc(12);
    const read = readSync(fd, head, 0, head.length, 0);
    if (read < 4) return false;
    if (kind === 'input') {
      if (/\.png$/i.test(name)) {
        return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      }
      if (/\.jpe?g$/i.test(name)) return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
      if (/\.webp$/i.test(name)) {
        return read >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP';
      }
    }
    if (kind === 'glb' && /\.glb$/i.test(name)) {
      return read >= 12 && head.toString('ascii', 0, 4) === 'glTF' && head.readUInt32LE(4) === 2;
    }
    return true;
  } catch {
    return false;
  } finally {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

const HEAVY_JOB_TYPES = ['install', 'install.oneclick', 'install.qwen'];
const PRESET_KEYS = ['1k', '1.5k', '2k'];
const MAX_PROMPT = 4000;

/** Reject an unknown VRAM preset instead of silently falling back to 1.5K. */
function assertPreset(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const preset = String(value).toLowerCase();
  if (!PRESET_KEYS.includes(preset)) {
    throw new Error(`显存档位只能是 ${PRESET_KEYS.join(' / ')}，收到：${String(value)}`);
  }
  return preset;
}

/**
 * Run a task that finishes inside the request (opening an installer window,
 * writing workflows). Without the try/catch a synchronous throw would leave the
 * job in `running` forever, and `assertIdle()` would then reject every later
 * install until the local service is restarted.
 */
function runInlineJob(type, title, task, { done, fail }) {
  const job = jobs.create(type, title);
  try {
    const result = task(job.id);
    jobs.done(job.id, result, done);
    return { jobId: job.id, result };
  } catch (err) {
    if (jobs.get(job.id)?.status !== 'cancelled') {
      logError(`${type} ${job.id}`, err);
      jobs.fail(job.id, err, fail);
    }
    throw err;
  }
}

/**
 * Recent STL / report artefacts in the workspace. The console used to expose
 * only `lastStl`, so an earlier export could only be found by browsing the
 * folder; this powers the "最近产物" list.
 */
function listArtifacts(limit = 12) {
  const ws = resolveWorkspace(loadConfig());
  const items = [];
  for (const [kind, sub, pattern] of [
    ['stl', 'stl', /\.stl$/i],
    ['report', 'reports', /\.json$/i],
  ]) {
    const dir = join(ws, sub);
    if (!existsSync(dir)) continue;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !pattern.test(entry.name)) continue;
      const full = join(dir, entry.name);
      try {
        const info = statSync(full);
        items.push({ kind, name: entry.name, path: full, size: info.size, mtime: info.mtimeMs });
      } catch {}
    }
  }
  items.sort((a, b) => b.mtime - a.mtime);
  return {
    dir: join(ws, 'stl'),
    total: items.length,
    items: items.slice(0, Math.max(1, Math.min(50, Number(limit) || 12))),
  };
}

async function handleAction(action, payload = {}) {
  const assertIdle = (type, label) => {
    const types = HEAVY_JOB_TYPES.includes(type) ? HEAVY_JOB_TYPES : [type];
    for (const candidate of types) {
      const running = jobs.hasRunning(candidate);
      if (running) {
        throw new AppError(
          ERROR_CODES.BUSY,
          `${label}正在进行中（任务 ${running.id}），请等待完成或先取消。`,
          { status: 409 },
        );
      }
    }
  };

  switch (action) {
    case 'checks':
      return { checks: await checkEnvironment({ refresh: true }) };

    case 'config.save': {
      const next = saveConfig(payload.patch || {});
      invalidateChecks();
      return { config: publicConfig(), saved: next };
    }

    case 'install.oneclick': {
      const running = jobs.hasRunning('install.oneclick');
      if (running) return { jobId: running.id, alreadyRunning: true };
      const qwenBusy = jobs.hasRunning('install.qwen');
      if (qwenBusy) throw new Error(`Qwen 模型下载正在进行中（任务 ${qwenBusy.id}），请等待完成或先取消。`);
      const installBusy = jobs.hasRunning('install');
      if (installBusy) throw new Error(`安装任务正在进行中（任务 ${installBusy.id}），请等待完成或先取消。`);
      const includeQwen = payload.includeQwen === true || payload.includeQwen === 'Y';
      const reuseModels = payload.reuseModels !== false && payload.reuseModels !== 'N';
      const job = jobs.create('install.oneclick', '一键部署 AI 建模工作流', {
        includeQwen,
        reuseModels,
        stage: 'preflight',
      });
      oneClickDeploy(jobs, job.id, { includeQwen, reuseModels })
        .then((result) => jobs.done(job.id, result, '一键部署完成'))
        .catch((err) => {
          if (jobs.get(job.id)?.status === 'cancelled') return;
          logError(`oneClickDeploy ${job.id}`, err);
          jobs.fail(job.id, err, '一键部署失败');
        });
      return { jobId: job.id, includeQwen, reuseModels };
    }

    case 'deploy.doctor':
      return { doctor: await runDeployDoctor({ refresh: payload.refresh !== false }) };

    case 'models.scan':
      return { reuse: reuseSummary() };

    case 'install.qwenModels': {
      const running = jobs.hasRunning('install.qwen');
      if (running) return { jobId: running.id, alreadyRunning: true };
      for (const type of ['install', 'install.oneclick']) {
        const busy = jobs.hasRunning(type);
        if (busy) throw new Error(`安装任务正在进行中（任务 ${busy.id}），请等待完成或先取消。`);
      }
      const job = jobs.create('install.qwen', '下载 Qwen-Image 2.1 模型');
      downloadQwenModels(jobs, job.id)
        .then((result) => jobs.done(job.id, { models: result }, 'Qwen 模型已就绪'))
        .catch((err) => {
          if (jobs.get(job.id)?.status === 'cancelled') return;
          logError(`downloadQwenModels ${job.id}`, err);
          jobs.fail(job.id, err, 'Qwen 模型下载失败');
        });
      return { jobId: job.id };
    }

    case 'install.comfy.download': {
      assertIdle('install', '安装任务');
      const job = jobs.create('install', '下载并解压 ComfyUI Easy Install');
      downloadComfyUI(jobs, job.id)
        .then((result) => jobs.done(job.id, result, 'ComfyUI 安装包已就绪'))
        .catch((err) => {
          logError(`downloadComfyUI ${job.id}`, err);
          jobs.fail(job.id, err, '下载失败');
        });
      return { jobId: job.id };
    }

    case 'install.comfy.run': {
      assertIdle('install', '安装任务');
      return runInlineJob(
        'install',
        '运行 ComfyUI Easy Install',
        (jobId) => runComfyInstaller(jobs, jobId),
        { done: '安装器已打开', fail: '启动安装器失败' },
      );
    }

    case 'install.torch28.run': {
      assertIdle('install', '安装任务');
      return runInlineJob(
        'install',
        '切换 PyTorch 2.8.0 + CUDA 12.8',
        (jobId) => runTorch28(jobs, jobId),
        { done: 'Torch 安装器已打开', fail: '启动 Torch 安装器失败' },
      );
    }

    case 'install.trellis.run': {
      assertIdle('install', '安装任务');
      return runInlineJob(
        'install',
        '安装 TRELLIS.2 与模型',
        (jobId) => runTrellisInstaller(jobs, jobId),
        { done: 'Trellis2 安装器已打开', fail: '启动 TRELLIS.2 安装器失败' },
      );
    }

    case 'install.pixel.run': {
      assertIdle('install', '安装任务');
      return runInlineJob(
        'install',
        '安装 PixelArtistry 水密节点',
        (jobId) => runPixelInstaller(jobs, jobId),
        { done: 'PixelArtistry 安装器已打开', fail: '启动 PixelArtistry 安装器失败' },
      );
    }

    case 'install.workflows': {
      const result = installVendorWorkflows();
      invalidateChecks();
      return { result };
    }

    case 'workflow.list':
      return { result: listWorkflowFiles() };

    case 'install.blender': {
      assertIdle('install', '安装任务');
      const job = jobs.create('install', '安装 Blender');
      installBlender(jobs, job.id)
        .then((result) => jobs.done(job.id, result, 'Blender 已安装'))
        .catch((err) => jobs.fail(job.id, err, 'Blender 安装失败'));
      return { jobId: job.id };
    }

    case 'comfy.start': {
      assertIdle('comfy', 'ComfyUI 启动任务');
      const job = jobs.create('comfy', '启动 ComfyUI');
      startComfyUI(jobs, job.id)
        .then((result) => jobs.done(job.id, result, 'ComfyUI 已启动'))
        .catch((err) => jobs.fail(job.id, err, 'ComfyUI 启动失败'));
      return { jobId: job.id };
    }

    case 'comfy.open': {
      const target = String(payload.url || loadConfig().comfyUrl || '');
      if (!/^https?:\/\//i.test(target)) throw new Error('ComfyUI 地址必须以 http:// 或 https:// 开头。');
      return openComfyUI(target);
    }

    case 'folder.open': {
      const map = {
        package: APP_ROOT,
        install: loadConfig().installRoot,
        comfy: resolveComfyRoot(loadConfig()),
        workspace: resolveWorkspace(loadConfig()),
        input: join(resolveWorkspace(loadConfig()), 'input'),
        glb: join(resolveWorkspace(loadConfig()), 'glb'),
        stl: join(resolveWorkspace(loadConfig()), 'stl'),
        reports: join(resolveWorkspace(loadConfig()), 'reports'),
        logs: join(APP_ROOT, 'logs'),
        docs: join(APP_ROOT, 'docs'),
        comfyOutput: join(resolveComfyRoot(loadConfig()), 'ComfyUI', 'output'),
        workflows: join(resolveComfyRoot(loadConfig()), 'ComfyUI', 'user', 'default', 'workflows', 'PixelArtistry'),
      };
      // An unknown target used to fall through to `map.workspace`, so a typo
      // opened the wrong folder with no feedback. Reject it instead.
      if (payload.path) return openFolder(payload.path);
      const target = String(payload.target || '');
      if (!target) throw new Error(`缺少目录标识。可用：${Object.keys(map).join('、')}`);
      if (!map[target]) throw new Error(`未知目录标识：${target}。可用：${Object.keys(map).join('、')}`);
      return openFolder(map[target]);
    }

    case 'comfy.output.open':
      return openFolder(join(resolveComfyRoot(loadConfig()), 'ComfyUI', 'output'));

    case 'comfy.latestGlb': {
      const latest = findLatestGlb(resolveComfyRoot(loadConfig()));
      if (!latest) throw new Error('ComfyUI/output 下还没有 GLB。先在 ComfyUI 里运行水密工作流。');
      const ws = resolveWorkspace(loadConfig());
      const destDir = join(ws, 'glb');
      if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
      const dest = join(destDir, `${safeName(latest.path.split(/[\\/]/).pop(), 'model.glb')}`);
      copyFileSync(latest.path, dest);
      // ComfyUI may still be flushing the file. A short copy silently produces
      // a truncated GLB that Blender then fails on with a confusing error.
      let copied = 0;
      try {
        copied = statSync(dest).size;
      } catch {}
      if (copied !== latest.size) {
        throw new Error(
          `GLB 正在写入（${formatBytes(copied)} / ${formatBytes(latest.size)}）。请等 ComfyUI 保存完成后再点一次「导入最新 GLB」。`,
        );
      }
      saveConfig({ lastGlb: dest });
      return { source: latest.path, path: dest, size: latest.size, mtime: latest.mtime };
    }

    case 'workflow.preparePixel': {
      const preset = assertPreset(payload.preset, '1.5k');
      const result = preparePixelWorkflow({
        preset,
        imagePath: payload.imagePath || loadConfig().lastImage,
        imageName: payload.imageName,
        blenderPath: payload.blenderPath || locateBlender(loadConfig()) || 'blender',
      });
      return { result };
    }

    case 'workflow.prepareQwen': {
      const prompt = String(payload.prompt ?? '').trim();
      if (prompt.length > MAX_PROMPT) {
        throw new Error(`提示词过长（${prompt.length} 字符），上限 ${MAX_PROMPT} 字符。`);
      }
      let seed;
      if (payload.seed !== undefined && payload.seed !== null && payload.seed !== '') {
        seed = Number(payload.seed);
        if (!Number.isInteger(seed) || seed < 0 || seed > Number.MAX_SAFE_INTEGER) {
          throw new Error(`随机种子必须是 0 以上的整数，收到：${String(payload.seed)}`);
        }
      }
      const result = prepareQwenWorkflow({
        prompt,
        preset: assertPreset(payload.preset, '2k'),
        seed,
      });
      return { result };
    }

    case 'postprocess.run': {
      assertIdle('postprocess', 'Blender 处理任务');
      const job = jobs.create('postprocess', 'Blender 清理并导出 STL');
      runPostprocess(jobs, job.id, payload)
        .then((result) => jobs.done(job.id, result, result.watertight === false ? '完成（网格未完全水密）' : 'STL 已生成'))
        .catch((err) => jobs.fail(job.id, err, 'Blender 处理失败'));
      return { jobId: job.id };
    }

    case 'stl.verify': {
      const path = payload.path || loadConfig().lastStl;
      return { analysis: await verifyStlFile(path) };
    }

    case 'artifacts.list':
      return listArtifacts(payload.limit);

    case 'file.pick': {
      const path = await pickFile(payload.kind || 'image');
      return { path };
    }

    case 'file.import': {
      const src = payload.path;
      if (!src || !existsSync(src)) throw new Error(`文件不存在：${src || ''}`);
      const kind = payload.kind === 'glb' ? 'glb' : 'input';
      const ws = resolveWorkspace(loadConfig());
      const destDir = join(ws, kind);
      if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
      const dest = join(destDir, safeName(src.split(/[\\/]/).pop(), kind === 'glb' ? 'model.glb' : 'input.png'));
      copyFileSync(src, dest);
      saveConfig(kind === 'glb' ? { lastGlb: dest } : { lastImage: dest });
      return { path: dest, size: statSync(dest).size };
    }

    case 'chitubox.open':
      return openChitubox(payload.path ? userPath(payload.path) : loadConfig().chituboxPath);

    case 'download.open':
      return openDownload(payload.kind || 'chitubox');

    case 'shortcut.create': {
      const result = await run('powershell', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(APP_ROOT, 'scripts', 'create-shortcut.ps1'),
        '-PackageRoot',
        APP_ROOT,
      ], { timeout: 60000 });
      if (!result.ok) throw new Error((result.stderr || result.stdout).slice(-500));
      return { message: result.stdout.trim() || '桌面快捷方式已创建' };
    }

    case 'open.path':
      if (!payload.path) throw new Error('路径为空');
      {
        const full = userPath(payload.path);
        if (!existsSync(full)) throw new Error(`路径不存在：${full}`);
        openPath(full);
      }
      return { ok: true };

    case 'open.url':
      if (!/^https?:\/\//i.test(String(payload.url || ''))) throw new Error('只允许打开 http/https 链接。');
      openUrl(payload.url);
      return { ok: true };

    case 'jobs.cancel':
      if (!payload.jobId || typeof payload.jobId !== 'string') throw new Error('缺少任务 ID');
      return { cancelled: jobs.cancel(payload.jobId) };

    case 'app.info':
      return {
        version: VERSION,
        root: APP_ROOT,
        node: process.version,
        platform: process.platform,
        presets: {
          '1k': presetInfo('1k'),
          '1.5k': presetInfo('1.5k'),
          '2k': presetInfo('2k'),
        },
      };

    default:
      throw new AppError(ERROR_CODES.UNKNOWN_ACTION, `未知操作：${action}`, { status: 400 });
  }
}

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - startedAt;
    if (res.statusCode >= 500 || ms > 5000) {
      logLine('warn', `${req.method} ${req.url} → ${res.statusCode} (${ms} ms)`);
    }
  });
  try {
    if (!hostAllowed(req)) {
      sendText(res, 403, 'Forbidden');
      return;
    }
    if (!originAllowed(req)) {
      sendText(res, 403, 'Forbidden origin');
      return;
    }
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

    if (url.pathname === '/api/health' && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        app: 'ai3d-print-flow',
        version: VERSION,
        uptime: Math.round(process.uptime()),
        pid: process.pid,
        node: process.version,
        memoryMb: Math.round(process.memoryUsage().rss / 1024 ** 2),
        runningJobs: jobs.runningCount(),
      });
      return;
    }

    if (url.pathname === '/api/diagnostics' && req.method === 'GET') {
      const cfg = loadConfig();
      const snapshot = peekChecks();
      sendJson(res, 200, {
        ok: true,
        app: 'ai3d-print-flow',
        version: VERSION,
        generatedAt: new Date().toISOString(),
        pid: process.pid,
        uptime: Math.round(process.uptime()),
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        memoryMb: Math.round(process.memoryUsage().rss / 1024 ** 2),
        paths: {
          appRoot: APP_ROOT,
          config: join(APP_ROOT, 'config', 'config.json'),
          logs: LOGS_DIR,
          workspace: resolveWorkspace(cfg),
        },
        config: publicConfig(),
        // Cached snapshot only: diagnostics is copied exactly when the machine
        // feels broken, so it must never trigger a multi-second probe itself.
        checks: snapshot
          ? {
              checkedAt: snapshot.checkedAt,
              ready: snapshot.ready,
              summary: snapshot.summary,
              timings: snapshot.timings,
            }
          : null,
        recentJobs: jobs.list().slice(0, 8),
        log: readLogTail(),
      });
      return;
    }

    if (url.pathname === '/api/state' && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        version: VERSION,
        config: publicConfig(),
        checks: await checkEnvironment(),
        jobs: jobs.list(),
      });
      return;
    }

    if (url.pathname === '/api/checks' && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        checks: await checkEnvironment({ refresh: url.searchParams.get('refresh') === '1' }),
      });
      return;
    }

    if (url.pathname === '/api/action' && req.method === 'POST') {
      const body = await readJson(req);
      try {
        const result = await handleAction(body.action, body.payload || {});
        sendJson(res, 200, { ok: true, ...result });
      } catch (err) {
        // No forced status: `errorPayload()` distinguishes validation errors
        // (plain Error → 400) from engine-level faults (TypeError → 500).
        const payload = errorPayload(err);
        if (payload.status >= 500) logError(`action ${body.action}`, err);
        sendJson(res, payload.status, payload);
      }
      return;
    }

    if (url.pathname === '/api/upload' && req.method === 'POST') {
      const kind = url.searchParams.get('kind') === 'glb' ? 'glb' : 'input';
      let name = safeName(url.searchParams.get('name') || (kind === 'glb' ? 'model.glb' : 'image.png'));
      if (kind === 'glb' && !/\.(glb|gltf)$/i.test(name)) throw new Error('只接受 .glb / .gltf');
      if (kind === 'input' && !/\.(png|jpe?g|webp)$/i.test(name)) throw new Error('只接受 png / jpg / webp');
      const max = MAX_UPLOAD[kind];
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > max) {
        throw Object.assign(new Error(`文件过大：上限 ${formatBytes(max)}`), { status: 413 });
      }
      const ws = resolveWorkspace(loadConfig());
      const destDir = join(ws, kind);
      if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
      const free = await freeDisk(destDir);
      // Without Content-Length (chunked upload) the exact requirement is
      // unknown, so require a sane floor instead of skipping the check
      // entirely and failing halfway through with ENOSPC.
      const needed = declared > 0 ? declared + 200 * 1024 ** 2 : 512 * 1024 ** 2;
      if (free != null && free < needed) {
        throw Object.assign(
          new Error(
            declared > 0
              ? `磁盘空间不足：上传需要 ${formatBytes(declared)}，当前仅剩 ${formatBytes(free)}。`
              : `磁盘空间不足：当前仅剩 ${formatBytes(free)}，上传至少需要 ${formatBytes(needed)} 可用空间。`,
          ),
          { status: 507 },
        );
      }
      let dest = join(destDir, name);
      // Defense in depth: safeName() already strips separators and dot-only
      // names, but the destination must still be verified to stay inside the
      // workspace before anything is written.
      if (!isInside(destDir, dest) || dest === destDir) {
        throw Object.assign(new Error('文件名不合法'), { status: 400 });
      }
      const temp = join(destDir, `.upload-${process.pid}-${randomBytes(4).toString('hex')}.part`);
      let received = 0;
      let tooLarge = false;
      const limiter = new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length;
          if (received > max) {
            tooLarge = true;
            callback(Object.assign(new Error('文件过大'), { status: 413 }));
            return;
          }
          callback(null, chunk);
        },
      });
      try {
        await pipeline(req, limiter, createWriteStream(temp, { flags: 'wx' }));
        if (tooLarge) throw Object.assign(new Error(`文件过大：上限 ${formatBytes(max)}`), { status: 413 });
        if (received === 0) throw new Error('上传文件为空');
        if (!uploadSignatureOk(temp, name, kind)) {
          throw Object.assign(new Error('文件内容与扩展名不匹配，请确认选择的是真实的 PNG / JPEG / WebP / GLB 文件。'), {
            status: 400,
          });
        }
        // Preserve earlier inputs and avoid Windows file locks when the user
        // selects a file that already lives in this workspace directory.
        if (existsSync(dest)) {
          const ext = extname(name);
          const stem = name.slice(0, -ext.length).slice(0, 120);
          do {
            name = safeName(`${stem}_${randomBytes(6).toString('hex')}${ext}`);
            dest = join(destDir, name);
          } while (existsSync(dest));
        }
        await replaceFile(temp, dest);
      } catch (err) {
        try {
          unlinkSync(temp);
        } catch {}
        if (tooLarge && !err.status) err.status = 413;
        throw err;
      }
      const size = statSync(dest).size;
      if (kind === 'glb') saveConfig({ lastGlb: dest });
      else saveConfig({ lastImage: dest });
      sendJson(res, 200, { ok: true, path: dest, name, size, formatted: formatBytes(size) });
      return;
    }

    if (url.pathname === '/api/job' && req.method === 'GET') {
      const job = jobs.get(url.searchParams.get('id'));
      sendJson(res, job ? 200 : 404, job ? { ok: true, job } : { ok: false, error: '任务不存在' });
      return;
    }

    if (url.pathname === '/api/jobs' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, jobs: jobs.list() });
      return;
    }

    if (url.pathname === '/api/file' && (req.method === 'GET' || req.method === 'HEAD')) {
      const path = workspaceFile(req.url);
      if (!path || !isFile(path)) {
        sendText(res, 404, 'Not found');
        return;
      }
      sendWorkspaceFile(req, res, path);
      return;
    }

    if (url.pathname === '/api/download' && (req.method === 'GET' || req.method === 'HEAD')) {
      const path = workspaceFile(req.url);
      if (!path || !isFile(path)) {
        sendText(res, 404, 'Not found');
        return;
      }
      sendWorkspaceFile(req, res, path, { download: true });
      return;
    }

    if (url.pathname === '/api/shutdown' && req.method === 'POST') {
      // There is intentionally no UI button for this endpoint. Requiring a
      // custom header means a cross-site form cannot shut down the console
      // without a successful CORS preflight (which this server never grants).
      if (req.headers['x-ai3d-shutdown'] !== '1') {
        sendText(res, 403, 'Forbidden');
        return;
      }
      sendJson(res, 200, { ok: true });
      setTimeout(() => shutdown('api'), 100);
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const full = safeStatic(url.pathname === '/' ? '/index.html' : url.pathname);
      if (full && isFile(full)) {
        const ext = extname(full).toLowerCase();
        const stat = statSync(full);
        const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
        securityHeaders(res);
        if (ext === '.html') {
          res.setHeader('Content-Security-Policy', STATIC_CSP);
          res.setHeader('Cache-Control', 'no-store');
        } else if (ext === '.js' || ext === '.css') {
          // Revalidate on every page load, but use ETag to make it a cheap 304.
          // Versioned query strings in index.html also avoid stale UI after an
          // in-place package update.
          res.setHeader('Cache-Control', 'no-cache');
        } else {
          res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
        }
        res.setHeader('ETag', etag);
        res.setHeader('Last-Modified', stat.mtime.toUTCString());
        const inm = String(req.headers['if-none-match'] || '');
        const ims = Date.parse(String(req.headers['if-modified-since'] || ''));
        if (inm === etag || (!inm && Number.isFinite(ims) && ims >= Math.floor(stat.mtimeMs / 1000) * 1000)) {
          res.writeHead(304);
          res.end();
          return;
        }
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Content-Length': stat.size,
        });
        if (req.method === 'HEAD') res.end();
        else pipeFile(req, res, full);
        return;
      }
    }

    sendText(res, 404, 'Not found');
  } catch (err) {
    logError(`${req.method} ${req.url}`, err);
    if (!res.headersSent) {
      const payload = errorPayload(err, { status: Number(err?.status) || 500 });
      sendJson(res, payload.status, payload);
    } else {
      try {
        res.destroy();
      } catch {}
    }
  }
});

server.requestTimeout = 15 * 60 * 1000;
server.headersTimeout = 30 * 1000;
server.keepAliveTimeout = 5000;

server.on('clientError', (err, socket) => {
  logLine('warn', `clientError: ${err.message}`);
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.on('error', (err) => {
  // listen() has its own one-shot handler for EADDRINUSE. This persistent
  // handler only logs errors after the server is already accepting requests.
  if (server.listening) logError('HTTP server error', err);
});

function listen(port, attempt = 0) {
  const onError = (err) => {
    server.removeListener('listening', onListening);
    if (err.code === 'EADDRINUSE' && attempt < 20) {
      listen(port + 1, attempt + 1);
    } else {
      console.error('服务启动失败：', err.message);
      process.exit(1);
    }
  };
  const onListening = () => {
    server.removeListener('error', onError);
    const actual = server.address().port;
    if (process.env.AI3D_NO_SAVE_PORT !== '1' && actual !== config.port) saveConfig({ port: actual });
    const url = `http://127.0.0.1:${actual}/${process.argv.includes('--deploy') ? '#deploy' : ''}`;
    // Startup banner in the log too: a support report without the port and
    // package root is much harder to reason about.
    logLine('info', `服务启动 v${VERSION} · 端口 ${actual} · PID ${process.pid} · ${APP_ROOT}`);
    console.log('');
    console.log('  AI3D Print Flow 已启动');
    console.log(`  ${url}`);
    console.log('');
    const open = !process.argv.includes('--no-open') && process.env.AI3D_NO_OPEN !== '1';
    if (open) openUrl(url);
  };
  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port, '127.0.0.1');
}

async function probeExisting(port) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: controller.signal,
      headers: { Connection: 'close' },
    });
    if (!res.ok) return null;
    const info = await res.json().catch(() => null);
    return info?.app === 'ai3d-print-flow' && info.pid !== process.pid ? info : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function startServer() {
  sweepStaleTempFiles();
  const existing = await probeExisting(START_PORT);
  if (existing && String(existing.version) === VERSION) {
    const url = `http://127.0.0.1:${START_PORT}/${process.argv.includes('--deploy') ? '#deploy' : ''}`;
    console.log('');
    console.log('  AI3D Print Flow 已在运行，直接复用现有服务。');
    console.log(`  ${url}`);
    console.log(`  PID ${existing.pid} · 关闭原启动窗口即可停止服务`);
    console.log('');
    if (!process.argv.includes('--no-open') && process.env.AI3D_NO_OPEN !== '1') openUrl(url);
    process.exit(0);
    return;
  }
  listen(START_PORT);
}

startServer();

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logLine('warn', `收到 ${signal}，正在停止服务…`);
  const cancelled = jobs.cancelAll();
  if (cancelled) logLine('warn', `已取消 ${cancelled} 个后台任务`);
  const force = setTimeout(() => process.exit(0), 5000);
  force.unref();
  // Stop keep-alive sockets immediately; uploads/downloads still in flight get
  // a short grace period, then the hard timeout above closes the process.
  server.close(() => process.exit(0));
  server.closeIdleConnections?.();
  const drain = setTimeout(() => server.closeAllConnections?.(), 1500);
  drain.unref();
  // If the server is already closed (for example during startup), do not
  // leave the console window hanging.
  if (!server.listening) process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGBREAK', () => shutdown('SIGBREAK'));
