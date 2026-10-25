import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig } from './config.mjs';
import {
  fileSize,
  findExecutable,
  findGit,
  formatBytes,
  isDir,
  isFile,
  listDirs,
  run,
} from './util.mjs';

const cache = { at: 0, data: null };
const CACHE_MS = 20000;

export const MODEL_SPECS = [
  {
    id: 'model.trellis2',
    file: 'trellis_2_int8_convrot.safetensors',
    sub: 'diffusion_models',
    size: 4.89 * 1024 ** 3,
    required: true,
    label: 'TRELLIS.2 主模型',
  },
  {
    id: 'model.pixal3d',
    file: 'pixal3d_int8_convrot.safetensors',
    sub: 'diffusion_models',
    size: 5.2 * 1024 ** 3,
    required: false,
    label: 'Pixal3D 主模型（可选）',
  },
  {
    id: 'model.shapevae',
    file: 'trellis_2_shape_vae_bf16.safetensors',
    sub: 'vae',
    size: 1.02 * 1024 ** 3,
    required: true,
    label: '形状 VAE',
  },
  {
    id: 'model.texturevae',
    file: 'trellis_2_texture_vae_bf16.safetensors',
    sub: 'vae',
    size: 0.9 * 1024 ** 3,
    required: true,
    label: '纹理 VAE',
  },
  {
    id: 'model.dino',
    file: 'dino_v3_L_naf_fp32.safetensors',
    sub: 'clip_vision',
    size: 1.13 * 1024 ** 3,
    required: true,
    label: 'DINOv3 视觉编码器',
  },
  {
    id: 'model.birefnet',
    file: 'birefnet.safetensors',
    sub: 'background_removal',
    size: 0.42 * 1024 ** 3,
    required: true,
    label: 'BiRefNet 去背景',
  },
  {
    id: 'model.shapeencoder',
    file: 'shape_enc_next_dc_f16c32_fp16.safetensors',
    sub: 'Trellis2\\encoders',
    size: 0.2 * 1024 ** 3,
    required: true,
    label: 'TRELLIS.2 形状编码器',
  },
  {
    id: 'model.moge',
    file: 'moge_2_vitl_normal_fp16.safetensors',
    sub: 'geometry_estimation',
    size: 0.63 * 1024 ** 3,
    required: false,
    label: 'MoGe 几何估计（Pixal3D 可选）',
  },
  {
    id: 'model.qwen',
    file: 'qwen_image_2.1_int8_convrot.safetensors',
    sub: 'diffusion_models',
    size: 6.76 * 1024 ** 3,
    required: false,
    label: 'Qwen-Image 2.1 主模型（可选）',
  },
  {
    id: 'model.qwenencoder',
    file: 'qwen3vl_8b_int8_convrot.safetensors',
    sub: 'text_encoders',
    size: 8.71 * 1024 ** 3,
    required: false,
    label: 'Qwen3-VL 文本编码器（可选）',
  },
  {
    id: 'model.qwenpe',
    file: 'qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors',
    sub: 'text_encoders',
    size: 8.82 * 1024 ** 3,
    required: false,
    label: 'Qwen3.5 提示词增强器（可选）',
  },
  {
    id: 'model.qwenvae',
    file: 'qwen_image_2.1_vae_bf16.safetensors',
    sub: 'vae',
    size: 0.63 * 1024 ** 3,
    required: false,
    label: 'Qwen-Image VAE（可选）',
  },
];

const PIXEL_NODES = [
  ['WTiVo-WatertightVoxel-ComfyuiNode', 'WTiVo 水密网格', true],
  ['ComfyUI-Mesh-Quad-Reconstruct', 'Quad Reconstruct', true],
  ['LODTailor-The-Mesh-Trimmer-ComfyuiNode', 'LODTailor 网格精简', true],
  ['WTiVo-FastMergeByDistance', 'Fast Merge 顶点焊接', true],
  ['ComfyUI-Memory-Cleaner', '显存清理', true],
  ['ComfyUI-CuMesh-Decimate', 'CuMesh 减面', true],
];

function item(id, group, label, status, value, hint = '', extra = {}) {
  return { id, group, label, status, value, hint, ...extra };
}

/**
 * `custom_nodes` is listed once per check run instead of once per node. The
 * folder holds a few hundred entries on a typical install, and seven
 * independent `readdirSync` calls were pure overhead on every refresh.
 */
function createNodeLookup(nodesRoot) {
  let names = null;
  return (needle) => {
    if (!names) {
      try {
        names = readdirSync(nodesRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        names = [];
      }
    }
    const wanted = String(needle).toLowerCase();
    return names.find((name) => name.toLowerCase().includes(wanted)) || null;
  };
}

function locateComfy(config) {
  const candidates = [
    config.comfyuiRoot,
    join(config.comfyuiRoot || '', 'ComfyUI-Easy-Install'),
    join(config.installRoot || '', 'ComfyUI-Easy-Install'),
    config.installRoot,
    'D:\\AI3D\\ComfyUI-Easy-Install',
    'C:\\AI3D\\ComfyUI-Easy-Install',
    join(os.homedir(), 'ComfyUI-Easy-Install'),
    join(os.homedir(), 'Documents', 'ComfyUI-Easy-Install'),
    'C:\\ComfyUI-Easy-Install',
    'D:\\ComfyUI-Easy-Install',
  ].filter(Boolean);

  const seen = new Set();
  for (const c of candidates) {
    const normalized = String(c).replace(/^"|"$/g, '');
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    if (isFile(join(normalized, 'ComfyUI', 'main.py')) && isFile(join(normalized, 'python_embeded', 'python.exe'))) {
      return { root: normalized, source: 'candidate' };
    }
  }
  return null;
}

export function locateBlender(config) {
  const candidates = [
    config.blenderPath,
    'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe',
    'C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe',
    'C:\\Program Files\\Blender Foundation\\Blender 5.0\\blender.exe',
    'C:\\Program Files\\Blender Foundation\\Blender 4.5\\blender.exe',
    'C:\\Program Files\\Blender Foundation\\Blender 4.4\\blender.exe',
    'C:\\Program Files\\Blender Foundation\\Blender 4.3\\blender.exe',
    'C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe',
  ]
    .filter(Boolean)
    .map((p) => String(p).replace(/^"|"$/g, ''));

  const direct = findExecutable(candidates);
  if (direct) return direct;

  for (const base of ['C:\\Program Files\\Blender Foundation', 'D:\\Program Files\\Blender Foundation']) {
    for (const dir of listDirs(base, (n) => /^Blender/i.test(n)).sort().reverse()) {
      const exe = join(dir, 'blender.exe');
      if (isFile(exe)) return exe;
    }
  }
  return null;
}

function locateChitubox(config) {
  return findExecutable([
    config.chituboxPath && String(config.chituboxPath).replace(/^"|"$/g, ''),
    'C:\\Program Files\\CHITUBOX\\CHITUBOX.exe',
    'C:\\Program Files\\Chitubox\\CHITUBOX.exe',
    'D:\\Program Files\\CHITUBOX\\CHITUBOX.exe',
  ]);
}

async function diskFree(path) {
  let target = path;
  while (target && !existsSync(target)) {
    const parent = target.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, '');
    if (!parent || parent === target) break;
    target = parent;
  }
  try {
    const st = await statfs(target || 'C:\\');
    return st.bavail * st.bsize;
  } catch {
    return 0;
  }
}

const SKIP_DIRS = /^(\.git|__pycache__|node_modules|\.cache)$/i;

/**
 * Build one index of the models tree instead of walking it once per model.
 *
 * The old `findFile()` call inside `modelPath()` re-traversed the whole
 * `ComfyUI/models` directory for every one of the 12 model specs, so a check on
 * a machine with many custom model folders did the same walk 12 times. The
 * index is built lazily (only when an expected path is missing) and reused for
 * the rest of that check run.
 */
function buildModelIndex(modelsRoot, maxDepth = 4) {
  const index = new Map();
  if (!isDir(modelsRoot)) return index;
  let frontier = [{ dir: modelsRoot, depth: 0 }];
  while (frontier.length) {
    const next = [];
    for (const { dir, depth } of frontier) {
      let entries = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isFile()) {
          const key = entry.name.toLowerCase();
          if (!index.has(key)) index.set(key, full);
        } else if (entry.isDirectory() && depth < maxDepth && !SKIP_DIRS.test(entry.name)) {
          next.push({ dir: full, depth: depth + 1 });
        }
      }
    }
    frontier = next;
  }
  return index;
}

function createModelLookup(comfyRoot) {
  const modelsRoot = join(comfyRoot, 'ComfyUI', 'models');
  let index = null;
  return (spec) => {
    const expected = join(modelsRoot, spec.sub, spec.file);
    if (isFile(expected)) return expected;
    if (!index) index = buildModelIndex(modelsRoot);
    return index.get(spec.file.toLowerCase()) || null;
  };
}

function versionFromComfy(root) {
  for (const rel of ['ComfyUI\\comfyui_version.py', 'ComfyUI\\pyproject.toml', 'ComfyUI\\requirements.txt']) {
    try {
      const text = requireRead(join(root, rel));
      const m = text.match(/__version__\s*=\s*["']([^"']+)/i) || text.match(/version\s*=\s*["']([^"']+)/i) || text.match(/^version\s*=\s*["']?([\d.]+)/im);
      if (m) return m[1];
    } catch {}
  }
  return '';
}

function requireRead(path) {
  return readFileSync(path, 'utf8');
}

let inFlight = null;

/**
 * Expose the last computed snapshot without triggering a new probe. Diagnostics
 * must stay instant: it is copied precisely when the machine feels broken, and
 * a 10-second nvidia-smi/torch probe would make that worse.
 */
export function peekChecks() {
  return cache.data;
}

export function checkEnvironment({ refresh = false } = {}) {
  if (!refresh && cache.data && Date.now() - cache.at < CACHE_MS) return Promise.resolve(cache.data);
  // The dashboard refreshes state from several places. Collapse concurrent
  // probes into one run so we do not spawn duplicate nvidia-smi/torch checks.
  if (inFlight) return inFlight;
  inFlight = runEnvironmentChecks().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runEnvironmentChecks() {
  const config = loadConfig();
  const items = [];
  const startedAt = Date.now();
  // Per-probe timings: a "检测很慢" report can then be pinned to the actual
  // probe (nvidia-smi, the torch import, or a huge models folder) instead of
  // being guessed from the total duration.
  const timings = {};
  const since = (mark) => Date.now() - mark;

  const release = os.release();
  const win11 = Number(release.split('.')[0]) >= 10 && Number(release.split('.')[2] || 0) >= 22000;
  items.push(
    item(
      'os',
      'system',
      '操作系统',
      process.platform === 'win32' ? 'ok' : 'warn',
      `Windows ${release}${win11 ? ' (11)' : ''} · ${os.arch()}`,
      '本方案面向 Windows 10/11 x64。',
    ),
  );

  const totalRam = os.totalmem();
  items.push(
    item(
      'ram',
      'system',
      '系统内存',
      totalRam >= 30 * 1024 ** 3 ? 'ok' : totalRam >= 16 * 1024 ** 3 ? 'warn' : 'fail',
      formatBytes(totalRam),
      totalRam >= 30 * 1024 ** 3 ? '满足 2K 工作流推荐值。' : '推荐 32 GB；16 GB 建议使用 1K/1.5K 预设。',
    ),
  );

  const nvidiaSmi = findExecutable([
    'C:\\Windows\\System32\\nvidia-smi.exe',
    'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe',
  ]) || 'nvidia-smi';
  const installRoot = config.installRoot || (existsSync('D:\\') ? 'D:\\AI3D' : 'C:\\AI3D');
  // These probes are independent and can take several seconds each. Run them
  // together so a refresh does not block on nvidia-smi, disk, and Git serially.
  // Timings are measured from the start of this parallel phase, i.e. "when did
  // this result become available", which is what a slow-check report needs.
  const parallelStart = Date.now();
  const smiPromise = run(nvidiaSmi, [
    '--query-gpu=name,memory.total,driver_version',
    '--format=csv,noheader,nounits',
  ], { timeout: 12000 });
  const freePromise = diskFree(installRoot);
  const gitPromise = findGit();

  const smi = await smiPromise;
  timings.gpuMs = since(parallelStart);

  let gpu = null;
  if (smi.ok && smi.stdout.trim()) {
    const [name, vramMb, driver] = smi.stdout.trim().split(/\r?\n/)[0].split(',').map((s) => s.trim());
    gpu = { name, vramMb: Number(vramMb), driver };
    const vramGb = Number(vramMb) / 1024;
    items.push(
      item(
        'gpu',
        'system',
        'NVIDIA 显卡',
        vramGb >= 16 ? 'ok' : vramGb >= 8 ? 'warn' : 'fail',
        `${name} · ${vramGb.toFixed(0)} GB`,
        vramGb >= 16
          ? '可使用 2K 预设；建议系统内存 ≥ 32 GB。'
          : vramGb >= 8
            ? '建议使用 1.5K 预设；2K 可能显存不足。'
            : '至少需要 8 GB 显存；6 GB 仅建议 GGUF/1K 方案。',
      ),
    );
    items.push(item('driver', 'system', 'NVIDIA 驱动', 'ok', driver || '未知', '建议升级到最新 Game Ready / Studio 驱动。'));
  } else {
    items.push(
      item('gpu', 'system', 'NVIDIA 显卡', 'fail', '未检测到 nvidia-smi', '本工作流仅支持 NVIDIA RTX 20 系及以上。'),
    );
  }

  const free = await freePromise;
  timings.diskMs = since(parallelStart);
  items.push(
    item(
      'disk',
      'system',
      '安装盘剩余空间',
      free >= 80 * 1024 ** 3 ? 'ok' : free >= 45 * 1024 ** 3 ? 'warn' : 'fail',
      formatBytes(free),
      'ComfyUI + 全部模型约 35–50 GB，建议预留 80 GB。',
    ),
  );

  const git = await gitPromise;
  timings.gitMs = since(parallelStart);
  items.push(
    item(
      'git',
      'system',
      'Git',
      git ? 'ok' : 'warn',
      git ? git.version : '未安装',
      git
        ? `已找到 ${git.path}`
        : 'ComfyUI Easy Install 会自带 Git；手动安装节点时需要。',
    ),
  );

  const blender = locateBlender(config);
  const blenderStart = Date.now();
  const blenderVersionPromise = blender ? run(blender, ['--version'], { timeout: 15000 }) : null;
  const comfy = locateComfy(config);
  if (!comfy) {
    items.push(item('comfy', 'comfy', 'ComfyUI 安装', 'fail', '未找到', '点击「下载并安装 ComfyUI」完成首次部署。'));
  } else {
    items.push(item('comfy', 'comfy', 'ComfyUI 安装', 'ok', comfy.root, '已找到 python_embeded 与 ComfyUI/main.py。', { path: comfy.root }));

    const version = versionFromComfy(comfy.root);
    if (version) items.push(item('comfy.version', 'comfy', 'ComfyUI 版本', 'ok', version, 'TRELLIS.2 需要较新的 ComfyUI，建议保持更新。'));

    const py = join(comfy.root, 'python_embeded', 'python.exe');
    const torchStart = Date.now();
    const portStart = torchStart;
    const torchPromise = run(py, ['-c', "import sys,torch;print(sys.version.split()[0]);print(torch.__version__);print(torch.version.cuda or '')"], { timeout: 30000 });
    const portPromise = fetch(`${config.comfyUrl}/system_stats`, {
      signal: AbortSignal.timeout(1800),
    }).then((r) => r.ok).catch(() => false);
    const torch = await torchPromise;
    timings.torchMs = since(torchStart);
    if (torch.ok) {
      const [pyv, tv, cuda] = torch.stdout.trim().split(/\r?\n/);
      const good = String(pyv).startsWith('3.12') && String(tv).startsWith('2.8') && String(cuda).startsWith('12.8');
      items.push(
        item(
          'comfy.torch',
          'comfy',
          'Python / PyTorch / CUDA',
          good ? 'ok' : 'warn',
          `Python ${pyv} · Torch ${tv} · CUDA ${cuda || 'CPU'}`,
          good ? '与 WTiVo 预编译后端完全匹配。' : 'WTiVo 需要 Python 3.12 + PyTorch 2.8.0 + CUDA 12.8；请用 Easy Install 的 Torch-Pack 切换。',
        ),
      );
    } else {
      items.push(item('comfy.torch', 'comfy', 'Python / PyTorch / CUDA', 'warn', '检测失败', torch.stderr.slice(-200)));
    }

    const nodesRoot = join(comfy.root, 'ComfyUI', 'custom_nodes');
    const lookupNode = createNodeLookup(nodesRoot);
    const trellisNode = lookupNode('trellis2');
    items.push(
      item(
        'trellis.node',
        'comfy',
        'ComfyUI-Trellis2 节点',
        trellisNode ? 'ok' : 'fail',
        trellisNode || '未安装',
        '通过 Easy Install 的 Add-ons → Trellis2 (visualbruno) 安装。',
        { path: trellisNode ? join(nodesRoot, trellisNode) : '' },
      ),
    );

    const lookupModel = createModelLookup(comfy.root);
    for (const spec of MODEL_SPECS) {
      const found = lookupModel(spec);
      const size = found ? fileSize(found) : 0;
      const enough = size > spec.size * 0.75;
      items.push(
        item(
          spec.id,
          'models',
          spec.label,
          found ? (enough ? 'ok' : 'warn') : spec.required ? 'fail' : 'info',
          found ? formatBytes(size) : spec.required ? '缺失' : '未安装（可选）',
          found
            ? enough
              ? spec.file
              : `文件偏小，可能下载不完整：${spec.file}`
            : `应位于 ComfyUI/models/${spec.sub}/`,
          { path: found || '', required: spec.required },
        ),
      );
    }

    for (const [needle, label, required] of PIXEL_NODES) {
      const found = lookupNode(needle);
      items.push(
        item(
          `node.${needle}`,
          'nodes',
          label,
          found ? 'ok' : required ? 'fail' : 'info',
          found ? '已安装' : '未安装',
          found ? found : '运行 PixelArtistry 一键安装器自动安装。',
          { path: found ? join(nodesRoot, found) : '' },
        ),
      );
    }

    const wfDir = join(comfy.root, 'ComfyUI', 'user', 'default', 'workflows', 'PixelArtistry');
    let wfCount = 0;
    try {
      wfCount = readdirSync(wfDir).filter((n) => /\.json$/i.test(n)).length;
    } catch {
      wfCount = 0;
    }
    items.push(
      item(
        'pixel.workflows',
        'nodes',
        'PixelArtistry 工作流',
        wfCount > 0 ? 'ok' : 'fail',
        wfCount > 0 ? `${wfCount} 个文件` : '未安装',
        '运行 vendor/pixelartistry 下的一键安装器，或使用本控制台的「安装工作流」。',
      ),
    );

    const port = await portPromise;
    timings.portMs = since(portStart);
    let comfyEndpoint = '';
    try {
      const url = new URL(config.comfyUrl);
      comfyEndpoint = `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
    } catch {}
    items.push(
      item(
        'comfy.port',
        'comfy',
        'ComfyUI 服务',
        port ? 'ok' : 'info',
        port ? `运行中 · ${comfyEndpoint}` : '未启动',
        port ? '可直接打开 ComfyUI。' : '点击「启动 ComfyUI」。',
      ),
    );
  }

  if (blender) {
    const ver = await blenderVersionPromise;
    timings.blenderMs = since(blenderStart);
    const line = ver.stdout.split(/\r?\n/).find((l) => /^Blender/i.test(l)) || 'Blender';
    items.push(item('blender', 'tools', 'Blender', 'ok', line.trim(), blender, { path: blender }));
  } else {
    items.push(item('blender', 'tools', 'Blender', 'fail', '未安装', '后处理与 STL 导出需要 Blender 4.2+，建议 5.x。'));
  }

  const chitubox = locateChitubox(config);
  items.push(
    item(
      'chitubox',
      'tools',
      'CHITUBOX',
      chitubox ? 'ok' : 'warn',
      chitubox ? '已安装' : '未找到',
      chitubox ? chitubox : '用于加支撑与切片；也可使用其它光固化切片软件。',
      { path: chitubox || '' },
    ),
  );

  const summary = {
    ok: items.filter((i) => i.status === 'ok').length,
    warn: items.filter((i) => i.status === 'warn').length,
    fail: items.filter((i) => i.status === 'fail').length,
  };
  const ready = !!comfy && summary.fail === 0;

  const detected = {};
  if (comfy && config.comfyuiRoot !== comfy.root) detected.comfyuiRoot = comfy.root;
  if (blender && config.blenderPath !== blender) detected.blenderPath = blender;
  if (chitubox && config.chituboxPath !== chitubox) detected.chituboxPath = chitubox;
  if (Object.keys(detected).length) saveConfig(detected);

  const data = {
    checkedAt: new Date().toISOString(),
    ready,
    summary,
    items,
    metrics: {
      gpu,
      ram: formatBytes(totalRam),
      freeDisk: formatBytes(free),
      installRoot,
      comfyRoot: comfy?.root || '',
      blenderPath: blender || '',
      chituboxPath: chitubox || '',
    },
    timings: { ...timings, totalMs: since(startedAt) },
  };
  cache.at = Date.now();
  cache.data = data;
  return data;
}

export function invalidateChecks() {
  cache.at = 0;
  cache.data = null;
}
