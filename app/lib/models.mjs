import { existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { MODEL_SPECS } from './checks.mjs';
import { loadConfig } from './config.mjs';
import { isDir } from './util.mjs';

const SKIP_DIRS = /^(\.git|__pycache__|node_modules|site-packages|\.cache|\.venv|venv|\.incomplete-.*)$/i;

/**
 * Build a filename index once per root. The previous implementation walked the
 * whole model tree for every required file, which is noticeable on a machine
 * with several ComfyUI installs.
 */
function indexModelFiles(root, maxDepth = 7) {
  const index = new Map();
  if (!isDir(root)) return index;
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
        let type = entry.isFile() ? 'file' : entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'link' : '';
        if (type === 'link') {
          try {
            type = statSync(full).isFile() ? 'file' : 'dir';
          } catch {
            continue;
          }
        }
        if (type === 'file') {
          const key = entry.name.toLowerCase();
          if (!index.has(key)) index.set(key, full);
        } else if (type === 'dir' && depth < maxDepth && !SKIP_DIRS.test(entry.name)) {
          next.push({ dir: full, depth: depth + 1 });
        }
      }
    }
    frontier = next;
  }
  return index;
}

function hubRoot() {
  return process.env.HUGGINGFACE_HUB_CACHE
    || (process.env.HF_HOME ? join(process.env.HF_HOME, 'hub') : join(os.homedir(), '.cache', 'huggingface', 'hub'));
}

/**
 * Places where a compatible ComfyUI model tree may already live. This is
 * intentionally a short list: scanning an entire data drive for 25 GB files
 * would make the deploy preflight slower than the deployment itself.
 */
export function modelRoots(config = loadConfig()) {
  const installRoot = config.installRoot || '';
  const comfyRoot = config.comfyuiRoot || (installRoot ? join(installRoot, 'ComfyUI-Easy-Install') : '');
  const candidates = [
    comfyRoot && join(comfyRoot, 'ComfyUI', 'models'),
    installRoot && join(installRoot, 'ComfyUI', 'models'),
    installRoot && join(installRoot, 'ComfyUI-Easy-Install', 'ComfyUI', 'models'),
    'D:\\ComfyUI\\models',
    'C:\\ComfyUI\\models',
    'D:\\ComfyUI-Easy-Install\\ComfyUI\\models',
    'C:\\ComfyUI-Easy-Install\\ComfyUI\\models',
    join(os.homedir(), 'Documents', 'ComfyUI', 'models'),
    hubRoot(),
  ].filter(Boolean);

  const seen = new Set();
  return candidates.filter((root) => {
    const key = resolve(root).toLowerCase();
    if (seen.has(key) || !existsSync(root)) return false;
    seen.add(key);
    return true;
  });
}

function targetModelPath(config, spec) {
  const root = config.comfyuiRoot || (config.installRoot ? join(config.installRoot, 'ComfyUI-Easy-Install') : '');
  return root ? join(root, 'ComfyUI', 'models', spec.sub, spec.file) : '';
}

/**
 * Find exact filenames required by this workflow outside the configured
 * ComfyUI install. Only same-model files are returned; an Ollama/LLM GGUF or
 * a Stable Diffusion checkpoint is deliberately not a candidate.
 */
export function scanCompatibleModels(config = loadConfig(), { minRatio = 0.9 } = {}) {
  const indexes = modelRoots(config).map((root) => ({ root, index: indexModelFiles(root) }));
  const found = [];
  for (const spec of MODEL_SPECS) {
    const name = spec.file.toLowerCase();
    let hit = null;
    for (const { root, index } of indexes) {
      const path = index.get(name);
      if (!path) continue;
      try {
        const size = statSync(path).size;
        if (!hit || size > hit.size) hit = { path, size, sourceRoot: root };
      } catch {}
    }
    if (!hit) continue;
    const target = targetModelPath(config, spec);
    found.push({
      ...spec,
      path: hit.path,
      size: hit.size,
      sourceRoot: hit.sourceRoot,
      target,
      inPlace: !!target && resolve(hit.path).toLowerCase() === resolve(target).toLowerCase(),
      enough: hit.size >= spec.size * minRatio,
    });
  }
  return found;
}

function ollamaModels() {
  const root = process.env.OLLAMA_MODELS || join(os.homedir(), '.ollama', 'models');
  const manifests = join(root, 'manifests');
  if (!isDir(manifests)) return [];
  const models = [];
  let frontier = [{ dir: manifests, depth: 0 }];
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
        if (entry.isDirectory() && depth < 5) next.push({ dir: full, depth: depth + 1 });
        else if (entry.isFile()) {
          const parts = full.slice(manifests.length + 1).split(/[\\/]/);
          if (parts.length >= 2) models.push(`${parts.at(-2)}:${parts.at(-1)}`);
        }
      }
    }
    frontier = next;
  }
  return [...new Set(models)].sort();
}

function huggingFaceRepos() {
  const root = hubRoot();
  if (!isDir(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^models--/i.test(entry.name))
      .map((entry) => entry.name.replace(/^models--/i, '').replaceAll('--', '/'))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Informational inventory used by the post-deploy doctor. These local LLM
 * stacks are listed so the report can explain why they are not reusable as
 * Qwen-Image 2.1 or TRELLIS.2 weights.
 */
export function listLocalModelStacks() {
  const stacks = [];
  const ollama = ollamaModels();
  if (ollama.length) {
    stacks.push({
      kind: 'ollama',
      label: 'Ollama 本地语言/视觉模型',
      path: process.env.OLLAMA_MODELS || join(os.homedir(), '.ollama', 'models'),
      models: ollama,
      reusable: false,
      reason: '这些是 LLM/VLM 权重（GGUF），不是 Qwen-Image 2.1 扩散模型或 TRELLIS.2 三维权重。',
    });
  }
  const hf = huggingFaceRepos();
  if (hf.length) {
    stacks.push({
      kind: 'huggingface',
      label: 'Hugging Face 缓存',
      path: hubRoot(),
      models: hf,
      reusable: false,
      reason: '这些是缓存中的 LLM/视觉模型仓库；只有与目标文件精确同名且大小匹配的权重才会被复用。',
    });
  }
  return stacks;
}

export function reuseSummary(config = loadConfig()) {
  const found = scanCompatibleModels(config);
  const compatible = found.filter((item) => item.enough);
  return {
    compatible,
    placed: compatible.filter((item) => item.inPlace),
    external: compatible.filter((item) => !item.inPlace),
    partial: found.filter((item) => !item.enough),
    stacks: listLocalModelStacks(),
  };
}
