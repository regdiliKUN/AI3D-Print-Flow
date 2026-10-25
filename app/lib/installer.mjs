import {
  copyFileSync,
  createWriteStream,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { statfs } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { loadConfig, saveConfig } from './config.mjs';
import { VENDOR_DIR, VERSION } from './paths.mjs';
import { formatBytes, findGit, isDir, isFile, openPath, openUrl, replaceFile, run, safeName } from './util.mjs';
import { invalidateChecks, locateBlender } from './checks.mjs';
import { scanCompatibleModels } from './models.mjs';
import { installVendorWorkflows, listWorkflowFiles } from './workflows.mjs';

export const COMFY_ZIP_URL =
  'https://github.com/Tavris1/ComfyUI-Easy-Install/releases/latest/download/ComfyUI-Easy-Install.zip';
export const BLENDER_DOWNLOAD_URL = 'https://www.blender.org/download/';
export const CHITUBOX_DOWNLOAD_URL = 'https://www.chitubox.com/en/download/chitubox-free';

const QWEN_MODELS = [
  {
    label: 'Qwen-Image 2.1 主模型',
    sub: 'diffusion_models',
    file: 'qwen_image_2.1_int8_convrot.safetensors',
    size: 6.76 * 1024 ** 3,
    url: 'https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_int8_convrot.safetensors',
  },
  {
    label: 'Qwen3-VL 文本编码器',
    sub: 'text_encoders',
    file: 'qwen3vl_8b_int8_convrot.safetensors',
    size: 8.71 * 1024 ** 3,
    url: 'https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3vl_8b_int8_convrot.safetensors',
  },
  {
    label: 'Qwen3.5 提示词增强器',
    sub: 'text_encoders',
    file: 'qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors',
    size: 8.82 * 1024 ** 3,
    url: 'https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors',
  },
  {
    label: 'Qwen-Image VAE',
    sub: 'vae',
    file: 'qwen_image_2.1_vae_bf16.safetensors',
    size: 0.63 * 1024 ** 3,
    url: 'https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors',
  },
];

const MODEL_SIZES = {
  'trellis_2_int8_convrot.safetensors': 4.89 * 1024 ** 3,
  'pixal3d_int8_convrot.safetensors': 5.2 * 1024 ** 3,
  'trellis_2_shape_vae_bf16.safetensors': 1.02 * 1024 ** 3,
  'trellis_2_texture_vae_bf16.safetensors': 0.9 * 1024 ** 3,
  'dino_v3_L_naf_fp32.safetensors': 1.13 * 1024 ** 3,
  'birefnet.safetensors': 0.42 * 1024 ** 3,
  'shape_enc_next_dc_f16c32_fp16.safetensors': 0.2 * 1024 ** 3,
  'moge_2_vitl_normal_fp16.safetensors': 0.63 * 1024 ** 3,
  ...Object.fromEntries(QWEN_MODELS.map((item) => [item.file, item.size])),
};

function walkBats(root, maxDepth = 3) {
  const out = [];
  if (!isDir(root)) return out;
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
        if (entry.isFile() && /\.(bat|cmd)$/i.test(entry.name)) out.push(full);
        else if (entry.isDirectory() && depth < maxDepth) next.push({ dir: full, depth: depth + 1 });
      }
    }
    frontier = next;
  }
  return out;
}

export function findComfyInstaller(root) {
  const direct = [
    join(root, 'ComfyUI-Easy-Install.bat'),
    join(root, 'ComfyUI-Easy-Install', 'ComfyUI-Easy-Install.bat'),
  ];
  for (const p of direct) if (isFile(p)) return p;
  const bats = walkBats(root, 1).filter((p) => /ComfyUI-Easy-Install\.bat$/i.test(p));
  return bats[0] || null;
}

export function findStartBat(root) {
  const direct = [
    join(root, 'Start ComfyUI.bat'),
    join(root, 'Start ComfyUI FlashAttention.bat'),
  ];
  for (const p of direct) if (isFile(p)) return p;
  const bats = walkBats(root, 2)
    .filter((p) => /start\s*comfyui/i.test(p))
    .sort((a, b) => {
      const score = (p) => (/flash/i.test(p) ? 0 : /sage/i.test(p) ? 1 : 2);
      return score(a) - score(b);
    });
  return bats[0] || null;
}

export function findAddonBat(root, pattern) {
  const bases = [join(root, 'Add-ons'), join(root, 'Addons'), root];
  for (const base of bases) {
    const bats = walkBats(base, 3).filter((p) => pattern.test(p) && !/uninstall|remove/i.test(p));
    if (bats.length) return bats.sort((a, b) => a.length - b.length)[0];
  }
  return null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(headers, attempt, fallbackMs) {
  const raw = String(headers?.get?.('retry-after') || '').trim();
  if (!raw) return fallbackMs;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(60_000, Math.max(250, seconds * 1000));
  }
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.min(60_000, Math.max(250, when - Date.now()));
  return fallbackMs;
}

async function discardBody(res) {
  try {
    await res.body?.cancel();
  } catch {}
}

function parseContentRange(value) {
  const match = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(String(value || ''));
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === '*' ? 0 : Number(match[3]),
  };
}

function parseRangeTotal(value) {
  const match = /bytes\s+\*\/(\d+)/i.exec(String(value || ''));
  return match ? Number(match[1]) : 0;
}

function readPartMeta(metaPath) {
  try {
    const value = JSON.parse(readFileSync(metaPath, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function removePartFiles(part, metaPath) {
  for (const file of [part, metaPath]) {
    try {
      unlinkSync(file);
    } catch {}
  }
}

/**
 * Download with progress, automatic retry and HTTP Range resume.
 * `.part` is kept on failure, so a 25 GB model download can continue where it
 * stopped instead of starting from zero.
 */
export async function downloadFile(
  url,
  dest,
  { onProgress, signal, connectTimeoutMs = 30000, idleTimeoutMs = 60000, maxAttempts = 5 } = {},
) {
  const parent = dirname(dest);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

  const part = `${dest}.part`;
  const metaPath = `${part}.json`;
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (signal?.aborted) throw new Error('下载已取消');
    let meta = readPartMeta(metaPath);
    if (meta?.url && meta.url !== url) {
      removePartFiles(part, metaPath);
      meta = null;
    }
    let have = existsSync(part) ? statSync(part).size : 0;
    let res = null;
    const controller = new AbortController();
    let connectTimer = setTimeout(() => controller.abort(new Error('连接服务器超时')), connectTimeoutMs);
    let idleTimer = null;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(new Error('下载停滞超时')), idleTimeoutMs);
    };
    const signals = [controller.signal];
    if (signal) signals.push(signal);
    const combined = signals.length > 1 ? AbortSignal.any(signals) : controller.signal;
    const headers = {
      'User-Agent': `AI3D-Print-Flow/${VERSION}`,
      // Keep Content-Length aligned with the bytes Node receives. Without this,
      // GitHub may gzip the response and the progress total becomes too small.
      'Accept-Encoding': 'identity',
    };
    if (have > 0) headers.Range = `bytes=${have}-`;

    try {
      res = await fetch(url, { redirect: 'follow', signal: combined, headers });
    } catch (err) {
      lastError = err;
      if (signal?.aborted) throw new Error('下载已取消');
      const retry = attempt < maxAttempts - 1;
      if (retry) {
        await delay(900 * 2 ** attempt);
        continue;
      }
      throw new Error(`无法连接下载服务器：${err.message}`);
    } finally {
      clearTimeout(connectTimer);
      connectTimer = null;
    }

    if (res.status === 416 && have > 0) {
      const total = parseRangeTotal(res.headers.get('content-range'));
      if (total > 0 && have === total) {
        await replaceFile(part, dest);
        try {
          unlinkSync(metaPath);
        } catch {}
        onProgress?.(have, have, { speed: 0, eta: 0, resumed: true });
        return { path: dest, bytes: have, resumed: true };
      }
      // A stale .part from an older URL or a changed remote file. Resetting is
      // safer than promoting a file with the wrong bytes.
      await discardBody(res);
      removePartFiles(part, metaPath);
      lastError = new Error('断点文件与服务器文件不匹配，已重新下载');
      if (attempt < maxAttempts - 1) {
        await delay(500);
        continue;
      }
      throw lastError;
    }

    if (!res.ok) {
      lastError = new Error(`下载失败 HTTP ${res.status} ${res.statusText}`);
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      await discardBody(res);
      if (retryable && attempt < maxAttempts - 1) {
        await delay(retryDelay(res.headers, attempt, 1000 * 2 ** attempt));
        continue;
      }
      throw lastError;
    }

    if (!res.body) {
      lastError = new Error('下载响应为空');
      if (attempt < maxAttempts - 1) {
        await delay(500);
        continue;
      }
      throw lastError;
    }

    const range = parseContentRange(res.headers.get('content-range'));
    const contentLength = Number(res.headers.get('content-length') || 0);
    const append = res.status === 206 && have > 0 && (!range || range.start === have);
    if (!append) have = 0;
    const total = range?.total || (res.status === 206 ? have + contentLength : contentLength);

    const remoteEtag = res.headers.get('etag') || '';
    if (meta?.etag && remoteEtag && meta.etag !== remoteEtag) {
      await discardBody(res);
      removePartFiles(part, metaPath);
      lastError = new Error('服务器文件已更新，旧断点已丢弃');
      if (attempt < maxAttempts - 1) {
        await delay(500);
        continue;
      }
      throw lastError;
    }
    try {
      writeFileSync(metaPath, JSON.stringify({
        url,
        etag: remoteEtag,
        lastModified: res.headers.get('last-modified') || '',
        total: total || null,
      }), 'utf8');
    } catch {}

    const remaining = total > 0 ? Math.max(0, total - have) : 0;
    const free = await freeSpace(parent);
    if (free != null && remaining > 0 && free < remaining + 256 * 1024 ** 2) {
      await discardBody(res);
      throw new Error(
        `磁盘空间不足：还需要约 ${formatBytes(remaining)}，当前仅剩 ${formatBytes(free)}。请清理磁盘后重试，已下载的断点会保留。`,
      );
    }

    let received = have;
    let lastAt = 0;
    let phaseStart = Date.now();
    let phaseBytes = 0;
    const source = Readable.fromWeb(res.body);
    source.on('data', (chunk) => {
      resetIdle();
      received += chunk.length;
      phaseBytes += chunk.length;
      const now = Date.now();
      if (now - lastAt > 250) {
        lastAt = now;
        const seconds = Math.max(0.25, (now - phaseStart) / 1000);
        const speed = phaseBytes / seconds;
        const reportTotal = total > 0 && received <= total ? total : 0;
        const eta = reportTotal > 0 && speed > 0 ? Math.max(0, (reportTotal - received) / speed) : null;
        onProgress?.(received, reportTotal, { speed, eta, resumed: append });
      }
    });
    resetIdle();

    try {
      await pipeline(source, createWriteStream(part, { flags: append ? 'a' : 'w' }));
    } catch (err) {
      if (signal?.aborted) throw new Error('下载已取消');
      lastError = new Error(`下载中断：${err.message}`);
      if (/ENOSPC|no space/i.test(String(err.message))) {
        throw new Error(`磁盘空间不足，已保留断点：${err.message}`);
      }
      if (attempt < maxAttempts - 1) {
        await delay(1000 * 2 ** attempt);
        continue;
      }
      throw new Error(`下载中断，已保留断点：${err.message}`);
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
    }

    if (total > 0 && received < total) {
      lastError = new Error(`下载不完整：${formatBytes(received)} / ${formatBytes(total)}`);
      if (attempt < maxAttempts - 1) {
        await delay(1000 * 2 ** attempt);
        continue;
      }
      throw new Error(`${lastError.message}，已保留断点，可重试`);
    }

    await replaceFile(part, dest);
    try {
      unlinkSync(metaPath);
    } catch {}
    onProgress?.(received, total > received ? total : received, { speed: 0, eta: 0, resumed: append });
    return { path: dest, bytes: received, resumed: append };
  }

  throw lastError || new Error('下载失败');
}

function downloadDetail(received, total, extra = {}) {
  const parts = [total > 0 ? `${formatBytes(received)} / ${formatBytes(total)}` : `已下载 ${formatBytes(received)}`];
  if (extra.speed > 0) parts.push(`${formatBytes(extra.speed)}/s`);
  if (extra.eta != null && Number.isFinite(extra.eta)) {
    const seconds = Math.round(extra.eta);
    const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
    const ss = String(seconds % 60).padStart(2, '0');
    parts.push(`剩余 ${mm}:${ss}`);
  }
  if (extra.resumed && received > 0) parts.push('断点续传');
  return parts.join(' · ');
}

export async function downloadComfyUI(jobs, jobId, { start = 2, end = 100 } = {}) {
  const config = loadConfig();
  const root = config.installRoot;
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const zip = join(root, 'ComfyUI-Easy-Install.zip');
  const span = Math.max(1, end - start);
  const at = (ratio) => Math.round(start + span * ratio);

  const downloadZip = async () => {
    jobs.progress(jobId, at(0), '连接 GitHub 下载 ComfyUI Easy Install…', {
      stage: 'comfy',
      detail: '官方 ZIP 约 1.8 MB；如果网络较慢，进度会停在这里等待响应。',
      indeterminate: true,
    });
    const signal = jobs.abortSignal(jobId);
    await downloadFile(COMFY_ZIP_URL, zip, {
      signal,
      onProgress: (received, total, extra) => {
        const ratio = total ? Math.min(0.78, (received / total) * 0.78) : 0.4;
        jobs.progress(jobId, at(ratio), `下载 ComfyUI Easy Install · ${formatBytes(received)}`, {
          stage: 'comfy',
          detail: downloadDetail(received, total, extra),
          bytes: received,
          totalBytes: total || null,
          speed: extra.speed || null,
          eta: extra.eta ?? null,
          indeterminate: !total,
        });
      },
    });
    jobs.log(jobId, `已下载：${zip}`);
  };

  if (!isFile(zip) || statSync(zip).size < 1_000_000) {
    await downloadZip();
  } else {
    jobs.log(jobId, `使用已下载的安装包：${zip}`);
  }

  const extract = async () => {
    jobs.progress(jobId, at(0.8), '解压 ComfyUI Easy Install…', {
      stage: 'comfy',
      detail: '正在释放安装器与 Helper-CEI.zip',
      indeterminate: true,
    });
    return jobs.runProcess(
      jobId,
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${root.replace(/'/g, "''")}' -Force`,
      ],
      { timeout: 10 * 60 * 1000, cwd: root },
    );
  };

  let ps = await extract();
  if (!ps.ok) {
    jobs.log(jobId, '安装包解压失败，可能下载不完整；正在删除并重新下载一次。', 'warn');
    try {
      unlinkSync(zip);
    } catch {}
    await downloadZip();
    ps = await extract();
  }
  if (!ps.ok) throw new Error(`解压失败：${(ps.stderr || ps.stdout).slice(-300)}`);

  const installer = findComfyInstaller(root);
  if (!installer) throw new Error('解压完成，但未找到 ComfyUI-Easy-Install.bat');
  // 官方安装器会在解压目录下创建 ComfyUI-Easy-Install 子目录。
  const expectedRoot = join(root, 'ComfyUI-Easy-Install');
  saveConfig({ installRoot: root, comfyuiRoot: expectedRoot });
  invalidateChecks();
  jobs.progress(jobId, end, 'ComfyUI Easy Install 已就绪', {
    stage: 'comfy',
    detail: '接下来运行安装器，自动安装 ComfyUI + Python 3.12 + PyTorch。',
    indeterminate: false,
  });
  return {
    zip,
    installer,
    comfyuiRoot: expectedRoot,
    next: '运行 ComfyUI 安装器；安装完成后回到本页面点「重新检查」。',
  };
}

/* ------------------------------------------------------------------ */
/* One-click deployment                                               */
/* ------------------------------------------------------------------ */

async function runBatch(jobs, jobId, bat, args = [], opts = {}) {
  const argLine = args.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(' ');
  const line = `call "${bat}"${argLine ? ` ${argLine}` : ''}`;
  return jobs.runProcess(jobId, 'cmd.exe', ['/d', '/s', '/c', line], {
    cwd: opts.cwd || dirname(bat),
    windowsVerbatimArguments: true,
    timeout: opts.timeout,
    env: opts.env,
    onLine: opts.onLine,
  });
}

function comfyRootFromConfig(config) {
  const candidates = [
    config.comfyuiRoot,
    join(config.installRoot || '', 'ComfyUI-Easy-Install'),
  ].filter(Boolean);
  return candidates.find((p) => isFile(join(p, 'ComfyUI', 'main.py'))) || candidates[0];
}

/**
 * An Easy Install folder is only usable when both the ComfyUI source and its
 * embedded Python exist. An interrupted official installer often leaves
 * `ComfyUI\main.py` behind but no `python_embeded\python.exe`; the old check
 * only looked at main.py, so the partial folder stayed in place and the
 * official installer aborted with "folder already exists".
 */
export function inspectComfyInstall(root) {
  const base = root ? String(root).replace(/^"|"$/g, '') : '';
  const main = base ? join(base, 'ComfyUI', 'main.py') : '';
  const python = base ? join(base, 'python_embeded', 'python.exe') : '';
  const hasMain = !!main && isFile(main);
  const hasPython = !!python && isFile(python);
  const missing = [];
  if (!hasMain) missing.push('ComfyUI\\main.py');
  if (!hasPython) missing.push('python_embeded\\python.exe');
  return {
    root: base,
    exists: !!base && isDir(base),
    hasMain,
    hasPython,
    complete: hasMain && hasPython,
    missing,
  };
}

function hasComfyInstall(root) {
  return inspectComfyInstall(root).complete;
}

/**
 * Keep an interrupted install for inspection instead of deleting it. The
 * official Easy Install batch file refuses to run when a folder with the same
 * name exists, so the partial folder must move out of the way first.
 */
export function preserveIncompleteComfy(jobs, jobId, root) {
  if (!root) return null;
  const state = inspectComfyInstall(root);
  if (!state.exists || state.complete) return null;
  let backup = `${state.root}.incomplete-${Date.now()}`;
  for (let i = 1; existsSync(backup); i += 1) {
    backup = `${state.root}.incomplete-${Date.now()}-${i}`;
  }
  try {
    renameSync(state.root, backup);
    jobs?.log?.(
      jobId,
      `检测到不完整的 ComfyUI 安装目录（缺少 ${state.missing.join('、')}），已重命名为：${backup}（不会删除原文件）`,
      'warn',
    );
    return backup;
  } catch (err) {
    throw new Error(
      `ComfyUI 安装目录已存在但不完整：${state.root}\n` +
        `缺少：${state.missing.join('、')}\n` +
        `自动改名失败：${err.message}\n` +
        '请先关闭 ComfyUI / python.exe、资源管理器中打开该目录的窗口，并检查杀毒软件（火绒 / Windows Defender）是否正在扫描或隔离该目录。' +
        '处理后重试，或手动把该目录改名为 ComfyUI-Easy-Install.incomplete-<时间>。',
    );
  }
}

/**
 * Reuse weights that already exist elsewhere on this machine. Only exact
 * filenames are accepted (see models.mjs); a same-volume hard link avoids
 * duplicating multi-gigabyte files. Cross-volume or FAT/exFAT copies are
 * reported instead of silently copying tens of gigabytes.
 */
export function linkCompatibleModels(jobs, jobId, comfyRoot) {
  const found = scanCompatibleModels(loadConfig()).filter((item) => item.enough);
  const linked = [];
  const already = [];
  const skipped = [];

  for (const item of found) {
    const dest = modelFile(comfyRoot, item.sub, item.file);
    if (isFile(dest) && statSync(dest).size >= item.size * 0.9) {
      already.push({ file: item.file, path: dest });
      continue;
    }
    if (resolve(item.path).toLowerCase() === resolve(dest).toLowerCase()) {
      already.push({ file: item.file, path: dest });
      continue;
    }
    if (isFile(dest)) {
      const reason = `目标位置已有同名文件但大小不足（${formatBytes(statSync(dest).size)}），未覆盖`;
      skipped.push({ file: item.file, path: item.path, reason });
      jobs?.log?.(jobId, `跳过复用 ${item.file}：${reason}。请手动检查 ${dest}`, 'warn');
      continue;
    }
    try {
      mkdirSync(dirname(dest), { recursive: true });
      linkSync(item.path, dest);
      linked.push({ file: item.file, path: dest, source: item.path, size: item.size });
      jobs?.log?.(jobId, `已复用模型：${item.file} → ${dest}（硬链接，不额外占用空间）`);
    } catch (err) {
      const code = err?.code || '';
      const reason =
        code === 'EXDEV'
          ? '源文件与安装目录不在同一个磁盘，Windows 不能跨盘硬链接'
          : code === 'EPERM' || code === 'EACCES'
            ? '当前用户或文件系统不允许创建硬链接（FAT/exFAT 不支持硬链接）'
            : err.message;
      skipped.push({ file: item.file, path: item.path, reason });
      jobs?.log?.(
        jobId,
        `无法自动复用 ${item.file}（${reason}）。可手动复制 ${item.path} 到 ${dest}。`,
        'warn',
      );
    }
  }
  return { scanned: found.length, linked, already, skipped };
}

function nodeDirs(root) {
  const dir = join(root, 'ComfyUI', 'custom_nodes');
  if (!isDir(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function hasCustomNode(root, pattern) {
  return nodeDirs(root).some((name) => pattern.test(name));
}

function modelFile(root, sub, file) {
  return join(root, 'ComfyUI', 'models', sub, file);
}

function hasModel(root, sub, file, minRatio = 0.9) {
  const path = modelFile(root, sub, file);
  if (!isFile(path)) return false;
  const expected = MODEL_SIZES[file];
  if (!expected) return statSync(path).size > 1024 * 1024;
  return statSync(path).size >= expected * minRatio;
}

async function freeSpace(path) {
  let probe = path;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  try {
    const stats = await statfs(probe);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

async function prepareComfyInstaller(jobs, jobId, installer, root) {
  const git = await findGit();
  if (!git) {
    jobs.log(jobId, '未检测到 Git，官方安装器会通过 winget 安装。');
    return installer;
  }
  try {
    const text = readFileSync(installer, 'utf8');
    if (!/call\s+:install_git/i.test(text)) return installer;
    // The upstream installer always runs `winget install Git.Git`, which can
    // trigger a UAC prompt or upgrade Git unnecessarily. If Git is already
    // available, skip only that step.
    const patched = join(root, 'ComfyUI-Easy-Install.auto.bat');
    writeFileSync(
      patched,
      text.replace(/^([ \t]*)call\s+:install_git[ \t]*$/gim, '$1rem call :install_git (Git already installed)'),
      'utf8',
    );
    jobs.log(jobId, `检测到 Git：${git.version}（${git.path}）；已跳过安装器里的 Git 升级步骤。`);
    return patched;
  } catch (err) {
    jobs.log(jobId, `准备安装器时未能跳过 Git 步骤：${err.message}`, 'warn');
    return installer;
  }
}

async function comfyRunning(url) {
  return fetch(`${url}/system_stats`, { signal: AbortSignal.timeout(1500) })
    .then((res) => res.ok)
    .catch(() => false);
}

function heartbeat(jobs, jobId, { stage, from, to, message, detail, everyMs = 30000 }) {
  let pct = from;
  const startedAt = Date.now();
  const tick = () => {
    pct = Math.min(to, pct + 1);
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    jobs.progress(jobId, pct, message, {
      stage,
      detail: typeof detail === 'function' ? detail(elapsed) : detail,
      indeterminate: true,
    });
  };
  const timer = setInterval(tick, everyMs);
  return {
    bump(value) {
      pct = Math.max(pct, value);
      jobs.progress(jobId, pct, message, {
        stage,
        detail: typeof detail === 'function' ? detail(Math.round((Date.now() - startedAt) / 1000)) : detail,
        indeterminate: true,
      });
    },
    stop() {
      clearInterval(timer);
    },
  };
}

function tail(result, count = 700) {
  return (result.stderr || result.stdout || '').slice(-count);
}

export async function downloadQwenModels(jobs, jobId, { start = 0, end = 100 } = {}) {
  const config = loadConfig();
  const root = comfyRootFromConfig(config);
  if (!hasComfyInstall(root)) throw new Error('请先完成 ComfyUI 安装，再下载 Qwen 模型。');
  const span = Math.max(1, end - start);
  const totalBytes = QWEN_MODELS.reduce((sum, item) => sum + item.size, 0);
  const downloaded = [];
  let doneBytes = 0;

  const missingBytes = QWEN_MODELS.reduce((sum, item) => {
    const dest = modelFile(root, item.sub, item.file);
    if (isFile(dest) && statSync(dest).size >= item.size * 0.9) return sum;
    return sum + item.size;
  }, 0);
  const free = await freeSpace(root);
  if (free != null && missingBytes > 0 && free < missingBytes + 512 * 1024 ** 2) {
    throw new Error(
      `Qwen 模型还需要约 ${formatBytes(missingBytes)}，当前安装盘仅剩 ${formatBytes(free)}。请清理磁盘后重试，已下载文件不会丢失。`,
    );
  }

  for (const item of QWEN_MODELS) {
    const dest = modelFile(root, item.sub, item.file);
    if (isFile(dest) && statSync(dest).size >= item.size * 0.9) {
      doneBytes += item.size;
      downloaded.push({ ...item, path: dest, skipped: true });
      jobs.log(jobId, `已存在，跳过：${item.file}`);
      continue;
    }
    jobs.progress(jobId, start + (doneBytes / totalBytes) * span, `下载 ${item.label}…`, {
      stage: 'qwen',
      detail: `${item.file} · ${formatBytes(item.size)}`,
      indeterminate: true,
      bytes: 0,
      totalBytes: item.size,
    });
    const signal = jobs.abortSignal(jobId);
    await downloadFile(item.url, dest, {
      signal,
      connectTimeoutMs: 45000,
      onProgress: (received, total, extra) => {
        const fileTotal = total || item.size;
        const overall = start + ((doneBytes + received) / totalBytes) * span;
        jobs.progress(jobId, overall, `下载 ${item.label}…`, {
          stage: 'qwen',
          detail: `${item.file} · ${downloadDetail(received, fileTotal, extra)}`,
          bytes: received,
          totalBytes: fileTotal,
          speed: extra.speed || null,
          eta: extra.eta ?? null,
          indeterminate: !total,
        });
      },
    });
    const size = statSync(dest).size;
    if (size < item.size * 0.9) throw new Error(`${item.file} 下载不完整（${formatBytes(size)}），请重试。`);
    doneBytes += item.size;
    downloaded.push({ ...item, path: dest, skipped: false });
    jobs.log(jobId, `已下载：${dest}`);
  }
  jobs.progress(jobId, end, 'Qwen-Image 2.1 模型已就绪', {
    stage: 'qwen',
    detail: '4 个模型文件已写入 ComfyUI/models。',
    indeterminate: false,
  });
  return downloaded;
}

/**
 * Runs the whole Windows deployment chain with one button. Every stage is
 * idempotent: completed stages are skipped, so a failed run can be resumed by
 * clicking the button again.
 */
export async function oneClickDeploy(jobs, jobId, { includeQwen = false, reuseModels = true } = {}) {
  const config = loadConfig();
  const root = config.installRoot || 'D:\\AI3D';
  const configuredComfyRoot = config.comfyuiRoot ? resolve(config.comfyuiRoot) : '';
  const comfyRoot =
    configuredComfyRoot && hasComfyInstall(configuredComfyRoot)
      ? configuredComfyRoot
      : join(root, 'ComfyUI-Easy-Install');
  const skipped = [];
  const startedAt = Date.now();
  const elapsed = () => `${Math.max(1, Math.round((Date.now() - startedAt) / 60000))} 分钟`;

  const stage = (key, pct, message, detail, extra = {}) =>
    jobs.progress(jobId, pct, message, {
      stage: key,
      detail,
      bytes: null,
      totalBytes: null,
      speed: null,
      eta: null,
      indeterminate: false,
      ...extra,
    });

  stage('preflight', 1, '检查磁盘和安装目录…', root);
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const free = await freeSpace(root);
  const requiredFree = includeQwen ? 55 * 1024 ** 3 : 30 * 1024 ** 3;
  if (free != null && free < requiredFree) {
    throw new Error(
      `安装盘剩余空间只有 ${formatBytes(free)}，${includeQwen ? '勾选 Qwen 后' : '基础部署'}至少需要约 ${formatBytes(requiredFree)}（建议预留 80 GB）。请清理磁盘或更换安装目录后重试。`,
    );
  }
  if (free != null) jobs.log(jobId, `安装盘可用空间：${formatBytes(free)}`);

  const python = join(comfyRoot, 'python_embeded', 'python.exe');
  const needsComfy = !hasComfyInstall(comfyRoot);
  const needsTorchOrNodes = needsComfy || !hasCustomNode(comfyRoot, /trellis/i) || !hasCustomNode(comfyRoot, /wtivo|watertight/i);
  if (needsTorchOrNodes && (await comfyRunning(config.comfyUrl))) {
    throw new Error('ComfyUI 正在运行。安装 Torch / TRELLIS.2 / 水密节点前，请先关闭 ComfyUI 窗口，再点一键部署。');
  }

  // ---- 1. ComfyUI package + official installer ------------------------
  if (needsComfy) {
    // The official installer refuses to run if this folder exists. Move any
    // partial folder (missing main.py OR python.exe) out of the way first.
    preserveIncompleteComfy(jobs, jobId, comfyRoot);
    stage('comfy', 2, '下载并解压 ComfyUI Easy Install…', '官方 ZIP 约 1.8 MB，随后运行官方安装器。');
    await downloadComfyUI(jobs, jobId, { start: 2, end: 9 });

    const installer = findComfyInstaller(root);
    if (!installer) throw new Error('未找到 ComfyUI-Easy-Install.bat，请重试下载。');
    const staleAuto = join(root, 'ComfyUI-Easy-Install.auto.bat');
    if (isFile(staleAuto)) {
      try {
        unlinkSync(staleAuto);
      } catch {}
    }
    const effectiveInstaller = await prepareComfyInstaller(jobs, jobId, installer, root);
    stage('comfy', 10, '安装 ComfyUI（自动）…', '官方安装器会安装 Git、ComfyUI、Python 3.12 和 PyTorch；约 10–30 分钟。');
    const hb = heartbeat(jobs, jobId, {
      stage: 'comfy',
      from: 10,
      to: 43,
      message: '安装 ComfyUI（自动）…',
      detail: (seconds) => `官方安装器运行中 · 已用 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`,
      everyMs: 45000,
    });
    let result;
    try {
      result = await runBatch(jobs, jobId, effectiveInstaller, [], {
        timeout: 120 * 60 * 1000,
        onLine: (line) => {
          const text = line.trim();
          if (/installation complete/i.test(text)) hb.bump(44);
          else if (/installing.*torch/i.test(text)) hb.bump(38);
          else if (/pre-installation/i.test(text)) hb.bump(30);
          else if (/installing.*comfyui|cloning/i.test(text)) hb.bump(22);
          else if (/installing.*git/i.test(text)) hb.bump(12);
        },
      });
    } finally {
      hb.stop();
      if (effectiveInstaller !== installer) {
        for (let i = 0; i < 5; i += 1) {
          try {
            unlinkSync(effectiveInstaller);
            break;
          } catch {
            await delay(200 * (i + 1));
          }
        }
      }
    }
    if (!result || !result.ok) {
      const output = result ? `${result.stdout || ''}\n${result.stderr || ''}` : '';
      if (/folder already exists/i.test(output)) {
        throw new Error(
          `ComfyUI 安装器检测到已存在的 ComfyUI-Easy-Install 目录并退出（退出码 ${result?.code ?? -1}）。\n` +
            `这通常是上次安装中断留下的不完整目录（当前缺少：${inspectComfyInstall(comfyRoot).missing.join('、') || '未知组件'}）。\n` +
            '请关闭 ComfyUI / python.exe 和打开该目录的资源管理器窗口，并检查火绒 / Windows Defender 的隔离区或白名单；' +
            '然后重新点「一键部署」。下次运行会先把旧目录改名为 .incomplete-<时间>，不会删除。',
        );
      }
      throw new Error(`ComfyUI 安装器失败（退出码 ${result?.code ?? -1}）：\n${result ? tail(result) : '安装器没有返回结果'}`);
    }
    const installed = inspectComfyInstall(comfyRoot);
    if (!installed.complete) {
      throw new Error(
        `ComfyUI 安装未完成：缺少 ${installed.missing.join('、')}。\n` +
          `请查看日志并检查 ${comfyRoot}。如果 python.exe 被删掉，优先检查火绒 / Windows Defender 的隔离记录，` +
          '把安装目录加入白名单后重试（旧目录会自动改名为 .incomplete-<时间>）。',
      );
    }
    stage('comfy', 45, 'ComfyUI 安装完成', `已用 ${elapsed()}`, { indeterminate: false });
  } else {
    skipped.push('ComfyUI 已安装');
    stage('comfy', 45, 'ComfyUI 已安装，跳过', comfyRoot);
  }
  saveConfig({ installRoot: root, comfyuiRoot: comfyRoot });
  invalidateChecks();

  // ---- 1b. Reuse already-downloaded models ---------------------------
  let reuse = null;
  if (reuseModels) {
    stage('comfy', 45, '扫描本机可复用模型…', '只复用文件名和大小完全匹配的权重；硬链接，源文件保持原位。');
    reuse = linkCompatibleModels(jobs, jobId, comfyRoot);
    if (reuse.linked.length) {
      stage('comfy', 45, `已复用 ${reuse.linked.length} 个本机模型`, '使用硬链接，不额外占用磁盘空间。');
    } else if (reuse.already.length) {
      stage('comfy', 45, '可复用模型已在目标位置', `${reuse.already.length} 个同名文件已就绪。`);
    } else {
      stage('comfy', 45, '未发现可复用的同名模型', '继续从官方源安装/下载所需模型。');
    }
  } else {
    skipped.push('未启用本机模型复用');
  }

  // ---- 2. PyTorch 2.8.0 + CUDA 12.8 ----------------------------------
  const torchProbe = await run(
    python,
    ['-c', 'import torch; print(torch.__version__); print(torch.version.cuda or "")'],
    { timeout: 120000 },
  );
  const torchOk = torchProbe.ok && /^2\.8\./m.test(torchProbe.stdout) && /12\.8/.test(torchProbe.stdout);
  if (torchOk) {
    skipped.push('PyTorch 2.8.0+cu128 已就绪');
    stage('torch', 56, 'PyTorch 2.8.0 + CUDA 12.8 已就绪', torchProbe.stdout.trim().replace(/\r?\n/g, ' · '));
  } else {
    const bat = findAddonBat(comfyRoot, /torch\s*2\.8/i);
    if (!bat) throw new Error('未找到 Torch 2.8.0 切换脚本，请先完成 ComfyUI Easy Install。');
    stage('torch', 46, '切换 PyTorch 2.8.0 + CUDA 12.8…', 'WTiVo 预编译后端要求这个精确版本；会卸载旧 Torch 并重新安装。');
    const hb = heartbeat(jobs, jobId, {
      stage: 'torch',
      from: 46,
      to: 55,
      message: '切换 PyTorch 2.8.0 + CUDA 12.8…',
      detail: (seconds) => `pip 安装约 3 GB，已用 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`,
      everyMs: 30000,
    });
    const result = await (async () => {
      try {
        return await runBatch(jobs, jobId, bat, [], { timeout: 45 * 60 * 1000 });
      } finally {
        hb.stop();
      }
    })();
    if (!result.ok) throw new Error(`Torch 2.8 安装失败（退出码 ${result.code}）：\n${tail(result)}`);
    const verify = await run(
      python,
      ['-c', 'import torch; print(torch.__version__); print(torch.version.cuda or "")'],
      { timeout: 120000 },
    );
    if (!verify.ok || !/^2\.8\./m.test(verify.stdout) || !/12\.8/.test(verify.stdout)) {
      throw new Error(`Torch 版本仍不符合要求：${(verify.stdout || verify.stderr).trim().slice(-300)}`);
    }
    stage('torch', 56, 'PyTorch 2.8.0 + CUDA 12.8 已就绪', verify.stdout.trim().replace(/\r?\n/g, ' · '));
  }

  // ---- 3. TRELLIS.2 + Pixal3D nodes ----------------------------------
  if (!hasCustomNode(comfyRoot, /trellis/i)) {
    const bat = findAddonBat(comfyRoot, /trellis\s*2/i);
    if (!bat) throw new Error('未找到 Trellis2 安装脚本，请查看 ComfyUI-Easy-Install\\Add-ons。');
    stage('trellis', 57, '安装 TRELLIS.2 + Pixal3D 节点…', '会下载 DINOv3 等节点依赖，约 5–20 分钟。');
    const hb = heartbeat(jobs, jobId, {
      stage: 'trellis',
      from: 57,
      to: 76,
      message: '安装 TRELLIS.2 + Pixal3D 节点…',
      detail: (seconds) => `正在拉取节点和依赖 · 已用 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`,
      everyMs: 45000,
    });
    const result = await (async () => {
      try {
        return await runBatch(jobs, jobId, bat, ['NoPause'], { timeout: 60 * 60 * 1000 });
      } finally {
        hb.stop();
      }
    })();
    if (!result.ok) throw new Error(`TRELLIS.2 安装失败（退出码 ${result.code}）：\n${tail(result)}`);
    if (!hasCustomNode(comfyRoot, /trellis/i)) {
      throw new Error('Trellis2 安装脚本已结束，但未检测到 custom_nodes 中的 Trellis 节点。请查看日志。');
    }
    stage('trellis', 78, 'TRELLIS.2 + Pixal3D 节点已安装', `已用 ${elapsed()}`);
  } else {
    skipped.push('TRELLIS.2 节点已安装');
    stage('trellis', 78, 'TRELLIS.2 节点已安装，跳过', '继续检查水密节点和模型。');
  }

  // ---- 4. PixelArtistry watertight nodes + models --------------------
  const requiredModels = [
    ['diffusion_models', 'trellis_2_int8_convrot.safetensors', 'TRELLIS.2 主模型'],
    ['vae', 'trellis_2_shape_vae_bf16.safetensors', '形状 VAE'],
    ['vae', 'trellis_2_texture_vae_bf16.safetensors', '纹理 VAE'],
    ['clip_vision', 'dino_v3_L_naf_fp32.safetensors', 'DINOv3'],
    ['background_removal', 'birefnet.safetensors', 'BiRefNet'],
    ['Trellis2\\encoders', 'shape_enc_next_dc_f16c32_fp16.safetensors', '形状编码器'],
  ];
  const pixelNode = hasCustomNode(comfyRoot, /wtivo|watertight/i);
  const missingModels = requiredModels.filter(([sub, file]) => !hasModel(comfyRoot, sub, file));
  if (!pixelNode || missingModels.length) {
    const source = join(VENDOR_DIR, 'pixelartistry', 'watertightMeshes_win_installer.bat');
    if (!isFile(source)) throw new Error('内置的 PixelArtistry 安装器缺失。');
    const addons = [join(comfyRoot, 'Add-ons'), join(comfyRoot, 'Addons'), comfyRoot].find((p) => isDir(p));
    if (!addons) throw new Error('未找到 ComfyUI Easy Install 的 Add-ons 目录。');
    const installer = join(addons, 'PixelArtistry-Watertight-Installer.bat');
    copyFileSync(source, installer);
    stage(
      'pixel',
      79,
      '安装水密节点并下载模型…',
      missingModels.length
        ? `将自动下载 ${missingModels.length} 个缺失模型（约 8–15 GB），已用 ${elapsed()}`
        : '节点已存在，正在补齐缺失组件。',
    );
    const hb = heartbeat(jobs, jobId, {
      stage: 'pixel',
      from: 79,
      to: 92,
      message: '安装水密节点并下载模型…',
      detail: (seconds) => `AUTO_DL=Y 自动下载缺失模型 · 已用 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`,
      everyMs: 45000,
    });
    const result = await (async () => {
      try {
        return await runBatch(jobs, jobId, installer, [], {
          env: { AUTO_DL: 'Y' },
          timeout: 180 * 60 * 1000,
          onLine: (line) => {
            const text = line.trim();
            const step = text.match(/\[(\d)\/8\]/);
            if (step) hb.bump(79 + Number(step[1]) * 1.6);
            if (/downloading|下载/i.test(text)) hb.bump(90);
            if (/SUMMARY/i.test(text)) hb.bump(93);
            if (/\[FAIL\]/i.test(text)) jobs.log(jobId, text, 'error');
          },
        });
      } finally {
        hb.stop();
      }
    })();
    if (!result.ok) throw new Error(`水密节点安装器失败（退出码 ${result.code}）：\n${tail(result)}`);
    if (/\[FAIL\]\s+WTiVo backend/i.test(result.stdout + result.stderr)) {
      throw new Error('WTiVo 后端自检失败。请确认 PyTorch 2.8.0+cu128 安装成功，再重试一键部署。');
    }
    const stillMissing = requiredModels.filter(([sub, file]) => !hasModel(comfyRoot, sub, file));
    if (stillMissing.length) {
      throw new Error(`仍有 ${stillMissing.length} 个必需模型缺失：${stillMissing.map(([, , label]) => label).join('、')}。请检查网络后重试。`);
    }
    stage('pixel', 94, '水密节点与基础模型已就绪', `已用 ${elapsed()}`);
  } else {
    skipped.push('水密节点与基础模型已安装');
    stage('pixel', 94, '水密节点与基础模型已就绪，跳过', '继续写入工作流。');
  }

  // ---- 5. Workflows ---------------------------------------------------
  stage('workflows', 95, '写入 PixelArtistry 工作流…', '4 个打印/游戏资产工作流会出现在 ComfyUI 侧边栏。');
  const workflows = installVendorWorkflows();
  jobs.log(jobId, `已写入工作流：${workflows.copied.join('、') || '（无）'}`);

  // ---- 6. Optional Qwen image models ---------------------------------
  let qwen = null;
  if (includeQwen) {
    stage('qwen', 95, '下载 Qwen-Image 2.1 模型…', '约 25 GB，支持断点续传；耗时取决于网络。');
    qwen = await downloadQwenModels(jobs, jobId, { start: 95, end: 99 });
  } else {
    skipped.push('未勾选 Qwen 模型（可稍后单独下载）');
    stage('qwen', 99, '跳过 Qwen 图像模型', 'TRELLIS.2 可以直接使用你上传的图片。');
  }

  // ---- 7. Finish ------------------------------------------------------
  invalidateChecks();
  stage('done', 100, '一键部署完成', `总耗时约 ${elapsed()}。下一步：启动 ComfyUI，打开 Workflows → PixelArtistry。`, {
    indeterminate: false,
  });
  return {
    ok: true,
    installRoot: root,
    comfyuiRoot: comfyRoot,
    skipped,
    qwen,
    reuse,
    workflows: listWorkflowFiles(),
    next: [
      '关闭本页面前保持本地服务运行。',
      '查看页面「部署后自检」，按红色项提示处理缺失组件。',
      '点「启动 ComfyUI」，等待 8188 端口就绪。',
      '首次运行工作流时，在紫色 Blender 路径节点填写 blender.exe 路径。',
    ],
  };
}


export function runComfyInstaller(jobs, jobId) {
  const config = loadConfig();
  const target = config.comfyuiRoot || join(config.installRoot || '', 'ComfyUI-Easy-Install');
  preserveIncompleteComfy(jobs, jobId, target);
  const installer =
    findComfyInstaller(config.comfyuiRoot) ||
    findComfyInstaller(config.installRoot) ||
    findComfyInstaller(join(config.installRoot, 'ComfyUI-Easy-Install'));
  if (!installer) throw new Error('未找到 ComfyUI-Easy-Install.bat，请先下载并解压。');
  const ok = jobs.spawnInteractive(jobId, installer, [], { cwd: installer.replace(/[\\/][^\\/]+$/, '') });
  if (!ok) throw new Error('启动安装器失败');
  jobs.log(jobId, '安装器已在独立窗口打开。完成后回到控制台点「重新检查」。');
  return { installer, message: '安装器已打开，请按向导完成安装。' };
}

export function runTorch28(jobs, jobId) {
  const config = loadConfig();
  const bat =
    findAddonBat(config.comfyuiRoot, /torch\s*2\.8/i) ||
    findAddonBat(join(config.installRoot, 'ComfyUI-Easy-Install'), /torch\s*2\.8/i);
  if (!bat) throw new Error('未找到 Torch 2.8.0 切换脚本，请先完成 ComfyUI Easy Install。');
  jobs.spawnInteractive(jobId, bat, [], { cwd: bat.replace(/[\\/][^\\/]+$/, '') });
  jobs.log(jobId, `已打开：${bat}`);
  return { bat, message: 'Torch 2.8.0 切换脚本已打开。' };
}

export function runTrellisInstaller(jobs, jobId) {
  const config = loadConfig();
  const bat =
    findAddonBat(config.comfyuiRoot, /trellis\s*2/i) ||
    findAddonBat(join(config.installRoot, 'ComfyUI-Easy-Install'), /trellis\s*2/i);
  if (!bat) throw new Error('未找到 Trellis2 安装脚本。请确认已完成 ComfyUI Easy Install，并查看 Add-ons 目录。');
  jobs.spawnInteractive(jobId, bat, [], { cwd: bat.replace(/[\\/][^\\/]+$/, '') });
  jobs.log(jobId, `已打开：${bat}`);
  return { bat, message: 'Trellis2 安装脚本已打开；它会下载模型，耗时取决于网络。' };
}

export function runPixelInstaller(jobs, jobId) {
  const config = loadConfig();
  const root = existsSync(join(config.comfyuiRoot, 'ComfyUI', 'main.py'))
    ? config.comfyuiRoot
    : join(config.installRoot, 'ComfyUI-Easy-Install');
  const addons = [join(root, 'Add-ons'), join(root, 'Addons'), root].find((p) => isDir(p));
  if (!addons) throw new Error('未找到 ComfyUI Easy Install 的 Add-ons 目录。');
  const source = join(VENDOR_DIR, 'pixelartistry', 'watertightMeshes_win_installer.bat');
  if (!isFile(source)) throw new Error('内置的 PixelArtistry 安装器缺失。');
  const dest = join(addons, 'PixelArtistry-Watertight-Installer.bat');
  copyFileSync(source, dest);
  jobs.spawnInteractive(jobId, dest, [], { cwd: addons });
  jobs.log(jobId, `已复制并打开：${dest}`);
  return { bat: dest, message: 'PixelArtistry 安装器已打开；关闭 ComfyUI 后再运行，按提示补全缺失模型。' };
}

export async function startComfyUI(jobs, jobId) {
  const config = loadConfig();
  if (await comfyRunning(config.comfyUrl)) {
    jobs.progress(jobId, 100, 'ComfyUI 已在运行');
    return { url: config.comfyUrl, alreadyRunning: true };
  }
  const root = existsSync(join(config.comfyuiRoot, 'ComfyUI', 'main.py'))
    ? config.comfyuiRoot
    : join(config.installRoot, 'ComfyUI-Easy-Install');
  const bat = findStartBat(root);
  if (!bat) throw new Error('未找到 Start ComfyUI.bat，请先完成安装。');
  jobs.spawnInteractive(jobId, bat, [], { cwd: bat.replace(/[\\/][^\\/]+$/, '') });
  let endpoint = config.comfyUrl;
  try {
    const parsed = new URL(config.comfyUrl);
    endpoint = `${parsed.hostname}:${parsed.port || '8188'}`;
  } catch {}
  jobs.progress(jobId, 20, `ComfyUI 启动中，等待 ${endpoint} 就绪…`);
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const ok = await fetch(`${config.comfyUrl}/system_stats`, { signal: AbortSignal.timeout(1500) })
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) {
      jobs.progress(jobId, 100, 'ComfyUI 已启动');
      invalidateChecks();
      return { url: config.comfyUrl, bat };
    }
    jobs.progress(jobId, 40, '仍在启动…首次启动可能需要 1–2 分钟');
  }
  throw new Error('等待 ComfyUI 超时。请查看弹出的命令行窗口是否有报错。');
}

/**
 * winget ships with Windows 11 / updated Windows 10 (App Installer). On a
 * machine without it, `spawn('winget')` fails with a bare ENOENT that says
 * nothing actionable, so check first and point at the download page instead.
 */
async function wingetAvailable() {
  const probe = await run('where.exe', ['winget.exe'], { timeout: 8000 });
  return probe.ok && probe.stdout.trim().length > 0;
}

export async function installBlender(jobs, jobId) {
  jobs.progress(jobId, 3, '检查 winget…');
  if (!(await wingetAvailable())) {
    throw new Error(
      '未找到 winget（Windows「应用安装程序」）。请点「官网下载」手动安装 Blender，或在设置里直接填写 blender.exe 路径。',
    );
  }
  jobs.progress(jobId, 5, '调用 winget 安装 Blender…');
  const result = await jobs.runProcess(
    jobId,
    'winget',
    [
      'install',
      '--id',
      'BlenderFoundation.Blender',
      '--exact',
      '--silent',
      '--accept-package-agreements',
      '--accept-source-agreements',
    ],
    {
      timeout: 20 * 60 * 1000,
      onLine: (line) => {
        const m = line.match(/(\d{1,3})\s*%/);
        if (m) jobs.progress(jobId, Math.min(95, 8 + Number(m[1]) * 0.85), '正在安装 Blender…');
      },
    },
  );
  if (!result.ok && !/already installed|已安装|找到已安装/i.test(result.stdout + result.stderr)) {
    throw new Error(`Blender 安装失败：${(result.stderr || result.stdout).slice(-400)}`);
  }
  invalidateChecks();
  // Close the loop: detect the fresh install and persist the path so the
  // post-process panel works without the user copying a path by hand.
  const detected = locateBlender(loadConfig());
  if (detected) {
    saveConfig({ blenderPath: detected });
    jobs.log(jobId, `已自动识别 Blender：${detected}`);
  }
  jobs.progress(jobId, 100, 'Blender 安装完成');
  return {
    message: detected
      ? `Blender 已安装，路径已自动写入设置：${detected}`
      : 'Blender 已安装；回到控制台点「重新检查」自动识别路径。',
    path: detected || '',
  };
}

export function openComfyUI(url) {
  openUrl(url || loadConfig().comfyUrl);
  return { ok: true };
}

export function openFolder(path) {
  if (!path || !existsSync(path)) throw new Error(`目录不存在：${path}`);
  openPath(path);
  return { ok: true, path };
}

export function openChitubox(path) {
  const config = loadConfig();
  const exe = path || config.chituboxPath;
  if (!exe || !existsSync(exe)) throw new Error('未找到 CHITUBOX，请先在设置中填写路径。');
  openPath(exe);
  return { ok: true, path: exe };
}

export function openDownload(kind) {
  const url = kind === 'blender' ? BLENDER_DOWNLOAD_URL : CHITUBOX_DOWNLOAD_URL;
  openUrl(url);
  return { ok: true, url };
}

export function safeFileName(name) {
  return safeName(name, 'file');
}
