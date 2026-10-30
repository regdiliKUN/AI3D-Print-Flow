import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const APP_DIR = join(APP_ROOT, 'app');
export const PUBLIC_DIR = join(APP_DIR, 'public');
export const CONFIG_DIR = join(APP_ROOT, 'config');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
export const DEFAULT_CONFIG_PATH = join(CONFIG_DIR, 'default.json');
export const LOGS_DIR = join(APP_ROOT, 'logs');
export const WORKSPACE_DIR = join(APP_ROOT, 'workspace');
export const VENDOR_DIR = join(APP_ROOT, 'vendor');
export const WORKFLOWS_DIR = join(APP_ROOT, 'workflows');
export const BLENDER_SCRIPT = join(APP_ROOT, 'blender', 'postprocess.py');
export const RUNTIME_NODE = join(APP_ROOT, 'runtime', 'node.exe');
export const PACKAGE_JSON = join(APP_ROOT, 'package.json');

/**
 * package.json is the single source of truth for the version. It used to be
 * hard-coded here as well as in index.html, the footer and the docs, so a
 * release bump easily left the UI reporting a stale number.
 */
function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
    return typeof pkg.version === 'string' && pkg.version.trim() ? pkg.version.trim() : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = readVersion();

export function ensureDirs() {
  for (const dir of [
    CONFIG_DIR,
    LOGS_DIR,
    WORKSPACE_DIR,
    join(WORKSPACE_DIR, 'input'),
    join(WORKSPACE_DIR, 'glb'),
    join(WORKSPACE_DIR, 'stl'),
    join(WORKSPACE_DIR, 'reports'),
    join(WORKSPACE_DIR, 'text'),
    WORKFLOWS_DIR,
  ]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

export function resolveWorkspace(config) {
  if (config?.workspaceDir) return resolve(config.workspaceDir);
  return WORKSPACE_DIR;
}

export function resolveInstallRoot(config) {
  if (config?.installRoot) return resolve(config.installRoot);
  return existsSync('D:\\') ? 'D:\\AI3D' : 'C:\\AI3D';
}

export function resolveComfyRoot(config) {
  if (config?.comfyuiRoot) return resolve(config.comfyuiRoot);
  return join(resolveInstallRoot(config), 'ComfyUI-Easy-Install');
}
