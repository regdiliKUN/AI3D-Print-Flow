import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import {
  APP_ROOT,
  CONFIG_DIR,
  CONFIG_PATH,
  DEFAULT_CONFIG_PATH,
  ensureDirs,
  resolveInstallRoot,
} from './paths.mjs';

let cached = null;

const PRESETS = new Set(['1k', '1.5k', '2k']);
const REPAIR_MODES = new Set(['auto', 'voxel', 'fill', 'none']);
const PATH_KEYS = ['installRoot', 'comfyuiRoot', 'blenderPath', 'chituboxPath', 'workspaceDir'];
const LAST_KEYS = ['lastImage', 'lastGlb', 'lastStl', 'lastReport'];
const ALLOWED_KEYS = new Set([
  'version',
  ...PATH_KEYS,
  ...LAST_KEYS,
  'preset',
  'targetHeightMm',
  'repairMode',
  'decimateRatio',
  'port',
  'comfyUrl',
]);

function readJson(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return null;
  }
}

function cleanPath(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/^"|"$/g, '').trim();
  if (!text) return '';
  if (text.length > 4096 || /[\0\r\n]/.test(text)) {
    throw new Error('路径包含非法字符或长度超出限制。');
  }
  return text;
}

function cleanText(value, max = 4096) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text.length > max || /[\0\r\n]/.test(text)) {
    throw new Error('文本包含非法字符或长度超出限制。');
  }
  return text;
}

function cleanComfyUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('ComfyUI 地址不是有效 URL。');
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new Error('ComfyUI 地址必须以 http:// 或 https:// 开头。');
  }
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/$/, '');
}

/**
 * Validate a patch before it reaches config.json. Unknown keys are rejected
 * instead of being merged, which also blocks accidental prototype pollution.
 */
export function validateConfigPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('配置内容必须是对象。');
  }
  const clean = {};
  for (const key of Object.keys(patch)) {
    if (!ALLOWED_KEYS.has(key)) throw new Error(`不支持的配置项：${key}`);
  }

  for (const key of PATH_KEYS) {
    if (Object.hasOwn(patch, key)) {
      let value = cleanPath(patch[key]);
      if (value !== undefined && value && ['installRoot', 'comfyuiRoot', 'workspaceDir'].includes(key) && !isAbsolute(value)) {
        value = resolve(APP_ROOT, value);
      }
      if (value !== undefined) clean[key] = value;
    }
  }
  for (const key of LAST_KEYS) {
    if (Object.hasOwn(patch, key)) {
      const value = cleanText(patch[key]);
      if (value !== undefined) clean[key] = value;
    }
  }
  if (Object.hasOwn(patch, 'preset')) {
    if (!PRESETS.has(patch.preset)) throw new Error('预设只能是 1k、1.5k 或 2k。');
    clean.preset = patch.preset;
  }
  if (Object.hasOwn(patch, 'repairMode')) {
    if (!REPAIR_MODES.has(patch.repairMode)) throw new Error('修复模式只能是 auto、voxel、fill 或 none。');
    clean.repairMode = patch.repairMode;
  }
  if (Object.hasOwn(patch, 'targetHeightMm')) {
    const value = Number(patch.targetHeightMm);
    if (!Number.isFinite(value) || value < 0 || value > 2000) {
      throw new Error('目标高度必须在 0–2000 mm 之间。');
    }
    clean.targetHeightMm = Math.round(value * 10) / 10;
  }
  if (Object.hasOwn(patch, 'decimateRatio')) {
    const value = Number(patch.decimateRatio);
    if (!Number.isFinite(value) || value < 0 || value > 0.95) {
      throw new Error('减面比例必须在 0–0.95 之间。');
    }
    clean.decimateRatio = Math.round(value * 1000) / 1000;
  }
  if (Object.hasOwn(patch, 'port')) {
    const value = Number(patch.port);
    if (!Number.isInteger(value) || value < 1024 || value > 65535) {
      throw new Error('端口必须是 1024–65535 之间的整数。');
    }
    clean.port = value;
  }
  if (Object.hasOwn(patch, 'comfyUrl')) {
    clean.comfyUrl = cleanComfyUrl(patch.comfyUrl);
  }
  if (Object.hasOwn(patch, 'version')) {
    const value = Number(patch.version);
    if (!Number.isInteger(value) || value < 1) throw new Error('配置版本号无效。');
    clean.version = value;
  }
  return clean;
}

function sanitizeLoaded(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const clean = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!ALLOWED_KEYS.has(key)) continue;
    try {
      const validated = validateConfigPatch({ [key]: value });
      if (Object.hasOwn(validated, key)) clean[key] = validated[key];
    } catch {
      // Keep loading when a single stale value is invalid; saveConfig will
      // write the fully sanitized object back on the next change.
    }
  }
  return clean;
}

export function loadConfig() {
  ensureDirs();
  if (cached) return cached;

  const defaults = sanitizeLoaded(readJson(DEFAULT_CONFIG_PATH) || {});
  let saved = {};
  if (existsSync(CONFIG_PATH)) {
    const parsed = readJson(CONFIG_PATH);
    if (parsed) {
      saved = sanitizeLoaded(parsed);
    } else {
      // A truncated config must not silently reset the user's install paths.
      // Keep the damaged file for support and let defaults take over.
      try {
        renameSync(CONFIG_PATH, `${CONFIG_PATH}.corrupt-${Date.now()}`);
      } catch {}
    }
  }

  const config = { ...defaults, ...saved };
  config.version = 1;
  if (!config.installRoot) config.installRoot = resolveInstallRoot(config);
  if (!config.comfyuiRoot) config.comfyuiRoot = join(config.installRoot, 'ComfyUI-Easy-Install');
  if (!PRESETS.has(config.preset)) config.preset = '1.5k';
  if (!REPAIR_MODES.has(config.repairMode)) config.repairMode = 'auto';
  if (!Number.isFinite(Number(config.targetHeightMm))) config.targetHeightMm = 80;
  if (!Number.isFinite(Number(config.decimateRatio))) config.decimateRatio = 0;
  if (!Number.isInteger(Number(config.port))) config.port = 17860;
  if (!config.comfyUrl) config.comfyUrl = 'http://127.0.0.1:8188';
  cached = config;
  return config;
}

export function saveConfig(patch) {
  const current = loadConfig();
  const clean = validateConfigPatch(patch || {});
  const next = { ...current, ...clean };

  if (Object.hasOwn(clean, 'installRoot') && !Object.hasOwn(clean, 'comfyuiRoot')) {
    next.comfyuiRoot = clean.installRoot ? join(clean.installRoot, 'ComfyUI-Easy-Install') : '';
  }
  if (!next.installRoot) next.installRoot = resolveInstallRoot(next);
  if (!next.comfyuiRoot) next.comfyuiRoot = join(next.installRoot, 'ComfyUI-Easy-Install');

  ensureDirs();
  mkdirSync(CONFIG_DIR, { recursive: true });
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  if (existsSync(CONFIG_PATH)) {
    try {
      // Keep one known-good copy next to config.json. This makes a damaged
      // write recoverable without digging through logs.
      copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak`);
    } catch {}
  }
  const temp = `${CONFIG_PATH}.tmp-${process.pid}`;
  try {
    writeFileSync(temp, serialized, 'utf8');
    renameSync(temp, CONFIG_PATH);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {}
    throw new Error(`保存配置失败：${err.message}`);
  }
  cached = next;
  return next;
}

export function publicConfig() {
  const c = loadConfig();
  return {
    version: c.version,
    installRoot: c.installRoot,
    comfyuiRoot: c.comfyuiRoot,
    blenderPath: c.blenderPath,
    chituboxPath: c.chituboxPath,
    workspaceDir: c.workspaceDir,
    preset: c.preset,
    targetHeightMm: c.targetHeightMm,
    repairMode: c.repairMode,
    decimateRatio: c.decimateRatio,
    port: c.port,
    comfyUrl: c.comfyUrl,
    lastImage: c.lastImage,
    lastGlb: c.lastGlb,
    lastStl: c.lastStl,
    lastReport: c.lastReport,
  };
}
