import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.mjs';
import { resolveComfyRoot, VENDOR_DIR, WORKFLOWS_DIR } from './paths.mjs';
import { safeName, timestamp } from './util.mjs';

const PIXEL_SOURCES = {
  '1k': 'PixelArtistry_01_Image_to_Watertight_Mesh.json',
  '1.5k': 'PixelArtistry_01_Image_to_Watertight_Mesh.json',
  '2k': 'PixelArtistry_01b_Image_to_Watertight_Mesh_2K.json',
};

const PRESETS = {
  '1k': { resolution: 1024, proxy: 8_000_000, label: '1K · 低显存' },
  '1.5k': { resolution: 1536, proxy: 12_000_000, label: '1.5K · 推荐' },
  '2k': { resolution: 2048, proxy: 25_000_000, label: '2K · 高细节' },
};

export function presetInfo(preset) {
  return PRESETS[preset] || PRESETS['1.5k'];
}

export function workflowDir(comfyRoot) {
  return join(comfyRoot, 'ComfyUI', 'user', 'default', 'workflows', 'PixelArtistry');
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * `timestamp()` only has second precision, so generating two workflows within
 * the same second would silently overwrite the first file. Append a counter
 * instead of losing a workflow the user may already have open in ComfyUI.
 */
function uniqueWorkflowPath(dir, stem, ext = '.json') {
  let name = `${stem}${ext}`;
  let counter = 1;
  while (existsSync(join(dir, name))) {
    counter += 1;
    name = `${stem}_${counter}${ext}`;
  }
  return { name, path: join(dir, name) };
}

function setWidget(node, index, value, label, changes) {
  if (!node) return false;
  if (!Array.isArray(node.widgets_values)) node.widgets_values = [];
  const before = node.widgets_values[index];
  if (before === value) return false;
  node.widgets_values[index] = value;
  if (changes) changes.push(`${label}：${String(before ?? '(空)')} → ${String(value)}`);
  return true;
}

/**
 * Copy an image into ComfyUI/input without clobbering an unrelated file that
 * happens to share the name. ComfyUI's input folder is shared with the user's
 * own uploads, so silently overwriting `image.png` there could change a
 * different workflow's source image. A same-size file is treated as the same
 * image (the common "re-run the same picture" case) to avoid piling up copies.
 */
function placeInputImage(comfyRoot, sourcePath, desiredName) {
  const inputDir = ensureDir(join(comfyRoot, 'ComfyUI', 'input'));
  const size = statSync(sourcePath).size;
  let name = safeName(desiredName, 'input.png');
  const target = join(inputDir, name);
  if (existsSync(target)) {
    let sameSize = false;
    try {
      sameSize = statSync(target).size === size;
    } catch {}
    if (!sameSize) {
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      name = safeName(`AI3D_${stem}_${timestamp()}${ext}`, 'AI3D_input.png');
    }
  }
  try {
    copyFileSync(sourcePath, join(inputDir, name));
  } catch (err) {
    throw new Error(`无法写入 ComfyUI/input：${err.message}。请确认 ComfyUI 没有占用同名文件。`);
  }
  return name;
}

/**
 * 生成一份已注入图片、Blender 路径、Trellis2 开关和显存档位的工作流。
 * 不修改 vendor 原始文件，输出到 ComfyUI/user/default/workflows/PixelArtistry/。
 */
export function preparePixelWorkflow({ preset = '1.5k', imagePath, imageName, blenderPath }) {
  const config = loadConfig();
  const comfyRoot = resolveComfyRoot(config);
  if (!existsSync(join(comfyRoot, 'ComfyUI', 'main.py'))) {
    throw new Error(`未找到 ComfyUI：${comfyRoot}`);
  }

  const key = PRESETS[preset] ? preset : '1.5k';
  const sourceName = PIXEL_SOURCES[key];
  const sourcePath = join(VENDOR_DIR, 'pixelartistry', 'workflows', sourceName);
  if (!existsSync(sourcePath)) throw new Error(`缺少内置工作流：${sourceName}`);

  const info = presetInfo(key);
  const wf = readJson(sourcePath);
  const changes = [];

  let inputName = '';
  if (imagePath) {
    if (!existsSync(imagePath)) throw new Error(`图片不存在：${imagePath}`);
    inputName = placeInputImage(comfyRoot, imagePath, imageName || imagePath.split(/[\\/]/).pop());
    changes.push(`图片 → ComfyUI/input/${inputName}`);
  }

  const finalBlenderPath = blenderPath || config.blenderPath || 'blender';
  const stamp = timestamp();
  for (const node of wf.nodes || []) {
    if (node.type === 'LoadImage' && inputName) {
      setWidget(node, 0, inputName, `LoadImage #${node.id}`, changes);
      if (node.properties && typeof node.properties === 'object') node.properties.image = inputName;
    }

    if (node.type === 'PrimitiveString' && /blender/i.test(String(node.title || ''))) {
      setWidget(node, 0, finalBlenderPath, `Blender 路径 #${node.id}`, changes);
    }

    if (node.type === 'PrimitiveBoolean' && /trellis/i.test(String(node.title || ''))) {
      setWidget(node, 0, true, `TRELLIS.2 开关 #${node.id}`, changes);
    }

    if (node.type === 'Trellis2UpsampleStage') {
      setWidget(node, 0, String(info.resolution), `TRELLIS.2 上采样 #${node.id}`, changes);
    }

    if (node.type === 'MeshReconstructWithQuad' && key !== '2k') {
      setWidget(node, 1, info.resolution, `Quad Reconstruct 分辨率 #${node.id}`, changes);
    }

    if (node.type === 'WTiVoNativeMeshToMesh') {
      setWidget(node, 0, info.resolution, `WTiVo 输入分辨率 #${node.id}`, changes);
      setWidget(node, 1, info.resolution, `WTiVo 输出分辨率 #${node.id}`, changes);
      setWidget(node, 2, info.proxy, `WTiVo 代理点 #${node.id}`, changes);
    }

    if (node.type === 'LODTailorTheMeshTrimmer') {
      setWidget(node, 0, finalBlenderPath, `LODTailor Blender 路径 #${node.id}`, changes);
    }

    if (node.type === 'Save3DAdvanced') {
      setWidget(node, 0, `3d/AI3D_${key}_${stamp}`, `输出前缀 #${node.id}`, changes);
    }
  }

  const dir = ensureDir(workflowDir(comfyRoot));
  const { name: fileName, path: outPath } = uniqueWorkflowPath(dir, `AI3D_${key}_${stamp}`);
  writeFileSync(outPath, JSON.stringify(wf, null, 2), 'utf8');

  // 同时放一份到本工具 workflows/，便于归档。
  const archiveDir = ensureDir(WORKFLOWS_DIR);
  const archive = uniqueWorkflowPath(archiveDir, fileName.replace(/\.json$/i, '')).path;
  writeFileSync(archive, JSON.stringify(wf, null, 2), 'utf8');

  return {
    ok: true,
    source: sourceName,
    path: outPath,
    archive,
    fileName,
    preset: key,
    presetLabel: info.label,
    changes,
    note: '在 ComfyUI 左侧打开 Workflows → PixelArtistry，选择新生成的 AI3D_*.json，然后点 Run。',
  };
}

/**
 * 生成 Qwen-Image 2.1 文生图工作流，注入提示词、分辨率与随机种子。
 */
export function prepareQwenWorkflow({ prompt = '', preset = '2k', seed } = {}) {
  const config = loadConfig();
  const comfyRoot = resolveComfyRoot(config);
  if (!existsSync(join(comfyRoot, 'ComfyUI', 'main.py'))) {
    throw new Error(`未找到 ComfyUI：${comfyRoot}`);
  }

  const sourcePath = join(VENDOR_DIR, 'comfy', 'qwen-image-2.1-t2i.json');
  if (!existsSync(sourcePath)) throw new Error('缺少内置 Qwen-Image 2.1 工作流模板。');

  const key = preset === '2k' ? '2k' : preset === '1.5k' ? '1.5k' : '1k';
  const mp = key === '2k' ? 4 : key === '1.5k' ? 2.25 : 1;
  const px = key === '2k' ? 2048 : key === '1.5k' ? 1536 : 1024;
  const seedNumber = Number(seed);
  const finalSeed = seed !== undefined && seed !== '' && Number.isFinite(seedNumber)
    ? Math.max(0, Math.floor(seedNumber))
    : Math.floor(Math.random() * 9e14) + 1;

  const wf = readJson(sourcePath);
  const changes = [];

  for (const node of wf.nodes || []) {
    if (node.type === 'ResolutionSelector') {
      setWidget(node, 0, '1:1 (Square)', '画幅', changes);
      setWidget(node, 1, mp, '百万像素', changes);
      setWidget(node, 2, 1, '批量张数', changes);
    }

    // 子图实例：prompt / cfg / steps / width / height / seed
    if (Array.isArray(node.widgets_values) && node.widgets_values.length > 15 && typeof node.widgets_values[0] === 'string') {
      if (prompt) setWidget(node, 0, prompt, '提示词', changes);
      setWidget(node, 5, 1, 'CFG', changes);
      setWidget(node, 6, 25, '采样步数', changes);
      setWidget(node, 7, px, '宽度', changes);
      setWidget(node, 8, px, '高度', changes);
      setWidget(node, 11, finalSeed, '随机种子', changes);
    }

    if (node.type === 'SaveImageAdvanced') {
      setWidget(node, 0, `AI3D/Qwen_${key}`, '图片输出前缀', changes);
    }
  }

  const dir = ensureDir(workflowDir(comfyRoot));
  const { name: fileName, path: outPath } = uniqueWorkflowPath(dir, `AI3D_Qwen_${key}_${timestamp()}`);
  writeFileSync(outPath, JSON.stringify(wf, null, 2), 'utf8');
  const archivePath = uniqueWorkflowPath(ensureDir(WORKFLOWS_DIR), fileName.replace(/\.json$/i, '')).path;
  copyFileSync(outPath, archivePath);

  return {
    ok: true,
    path: outPath,
    archive: archivePath,
    fileName,
    preset: key,
    seed: finalSeed,
    prompt,
    changes,
    note: '在 ComfyUI 打开该工作流，确认提示词与分辨率后点 Run。生成图默认保存到 ComfyUI/output/AI3D/Qwen_*。',
  };
}

export function installVendorWorkflows() {
  const config = loadConfig();
  const comfyRoot = resolveComfyRoot(config);
  if (!existsSync(join(comfyRoot, 'ComfyUI', 'main.py'))) {
    throw new Error(`未找到 ComfyUI：${comfyRoot}`);
  }
  const dir = ensureDir(workflowDir(comfyRoot));
  const src = join(VENDOR_DIR, 'pixelartistry', 'workflows');
  const copied = [];
  for (const name of [
    'PixelArtistry_01_Image_to_Watertight_Mesh.json',
    'PixelArtistry_01b_Image_to_Watertight_Mesh_2K.json',
    'PixelArtistry_02_Image_to_GameReady_Asset.json',
    'PixelArtistry_03_Your_Mesh_to_GameReady_Asset.json',
  ]) {
    const from = join(src, name);
    if (existsSync(from)) {
      copyFileSync(from, join(dir, name));
      copied.push(name);
    }
  }
  return { ok: true, dir, copied };
}

export function listWorkflowFiles() {
  const config = loadConfig();
  const comfyRoot = resolveComfyRoot(config);
  const dir = workflowDir(comfyRoot);
  if (!existsSync(dir)) return { dir, files: [] };
  const files = readdirSync(dir)
    .filter((name) => /\.json$/i.test(name))
    .map((name) => {
      const full = join(dir, name);
      let size = 0;
      let mtime = 0;
      try {
        const st = statSync(full);
        size = st.size;
        mtime = st.mtimeMs;
      } catch {}
      return { name, path: full, size, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return { dir, files };
}
