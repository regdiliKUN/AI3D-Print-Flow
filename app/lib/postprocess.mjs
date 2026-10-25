import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { loadConfig, saveConfig } from './config.mjs';
import { BLENDER_SCRIPT, resolveWorkspace } from './paths.mjs';
import { locateBlender, invalidateChecks } from './checks.mjs';
import { analyzeStl } from './stl.mjs';
import { clamp, safeName, timestamp } from './util.mjs';

export function postprocessPaths(config, inputPath) {
  const ws = resolveWorkspace(config);
  const stem = safeName(basename(inputPath, extname(inputPath)), 'model').replace(/\s+/g, '_');
  const stamp = timestamp();
  return {
    ws,
    stl: join(ws, 'stl', `${stem}_${stamp}.stl`),
    report: join(ws, 'reports', `${stem}_${stamp}.json`),
  };
}

const REPAIR_MODES = ['auto', 'voxel', 'fill', 'none'];

/**
 * Parse a numeric option strictly. The old `Number(x) || 0` form turned an
 * empty string or a typo into `0`, which silently disabled scaling and
 * produced an STL that looks microscopic in CHITUBOX. Explicit input is now
 * validated; only a genuinely absent value falls back to the config default.
 */
function numberOption(value, fallback, { min, max, label }) {
  if (value === undefined || value === null || value === '') return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num < min || num > max) {
    throw new Error(`${label}必须在 ${min}–${max} 之间，收到：${String(value)}`);
  }
  return num;
}

export async function runPostprocess(jobs, jobId, payload = {}) {
  const config = loadConfig();
  const input = String(payload.input || config.lastGlb || '').replace(/^"|"$/g, '');
  if (!input || !existsSync(input)) throw new Error(`GLB 不存在：${input || '(未选择)'}`);
  if (!/\.(glb|gltf)$/i.test(input)) throw new Error('请选择 .glb 或 .gltf 文件');

  const blender = String(payload.blenderPath || locateBlender(config) || '').replace(/^"|"$/g, '');
  if (!blender) throw new Error('未找到 Blender。请先安装 Blender 5.x，或在设置中填写 blender.exe 路径。');

  const targetHeight = numberOption(
    payload.targetHeightMm,
    clamp(Number(config.targetHeightMm) || 80, 0, 2000),
    { min: 0, max: 2000, label: '目标高度 (mm)' },
  );
  if (payload.repairMode !== undefined && payload.repairMode !== '' && !REPAIR_MODES.includes(payload.repairMode)) {
    throw new Error(`修复模式只能是 ${REPAIR_MODES.join(' / ')}，收到：${String(payload.repairMode)}`);
  }
  const repair = REPAIR_MODES.includes(payload.repairMode) ? payload.repairMode : config.repairMode || 'auto';
  const decimate = numberOption(
    payload.decimateRatio,
    clamp(Number(config.decimateRatio) || 0, 0, 0.95),
    { min: 0, max: 0.95, label: '减面比例' },
  );
  const keepLargest = payload.keepLargest !== false;
  const { stl, report } = postprocessPaths(config, input);
  for (const dir of [join(resolveWorkspace(config), 'stl'), join(resolveWorkspace(config), 'reports')]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  jobs.progress(jobId, 5, '启动 Blender 无头模式…');
  const args = [
    '--background',
    '--factory-startup',
    '--python-exit-code',
    '2',
    '--python',
    BLENDER_SCRIPT,
    '--',
    '--input',
    input,
    '--output',
    stl,
    '--report',
    report,
    '--target-height',
    String(targetHeight),
    '--repair',
    repair,
    '--decimate',
    String(decimate),
    '--keep-largest',
    keepLargest ? '1' : '0',
  ];

  const result = await jobs.runProcess(jobId, blender, args, {
    timeout: 45 * 60 * 1000,
    onLine: (line) => {
      // Structured marker emitted by blender/postprocess.py. Progress is no
      // longer inferred from Chinese substrings, so wording changes or a new
      // stage cannot silently freeze the progress bar.
      const marker = /^\[AI3D\]\s*PROGRESS\s+(\d{1,3})\s+(.+)$/.exec(line.trim());
      if (marker) {
        const pct = Math.min(100, Math.max(0, Number(marker[1])));
        jobs.progress(jobId, pct, marker[2].trim());
      }
    },
  });

  // Parse the report before the exit-code check: blender/postprocess.py now
  // writes a failure report too, which carries the real reason (for example a
  // GLB with zero polygons) instead of a truncated stderr tail.
  let blenderReport = null;
  if (existsSync(report)) {
    try {
      blenderReport = JSON.parse(readFileSync(report, 'utf8'));
    } catch {}
  }

  if (!result.ok && !existsSync(stl)) {
    const detail = blenderReport?.error || (result.stderr || result.stdout).slice(-700);
    throw new Error(`Blender 处理失败（退出码 ${result.code}）：${detail}\n报告：${report}`);
  }
  if (!existsSync(stl)) throw new Error('Blender 未产出 STL 文件');

  jobs.progress(jobId, 96, '校验 STL 网格…');
  let analysis = null;
  try {
    analysis = await analyzeStl(stl);
  } catch (err) {
    jobs.log(jobId, `STL 分析失败：${err.message}`, 'warn');
  }

  const final = blenderReport?.final || null;
  const watertight = final?.watertight ?? analysis?.watertight ?? null;
  const warnings = [];
  if (targetHeight <= 0) {
    warnings.push('未设置目标高度：STL 保持 Blender 原始单位，在切片软件里通常显得极小。建议填 80 mm 后重跑。');
  }
  if (watertight === false) {
    warnings.push('网格仍有边界边或非流形边，建议在 CHITUBOX 中检查，或把修复模式改为「体素重建」重跑。');
  }
  if (analysis?.dimensionsMm && targetHeight > 0) {
    const maxDim = Math.max(...analysis.dimensionsMm);
    if (Math.abs(maxDim - targetHeight) > Math.max(2, targetHeight * 0.08)) {
      warnings.push(`实际最大尺寸 ${maxDim.toFixed(1)} mm 与目标 ${targetHeight} mm 偏差较大，请在切片软件中复核比例。`);
    }
  }
  if (analysis?.triangles > 4_000_000) {
    warnings.push('三角面超过 400 万，部分切片软件可能较慢；可在设置中启用减面。');
  }
  if (analysis?.unitSuspicion) {
    warnings.push('STL 最大尺寸不足 1 mm，导出时可能没有按毫米缩放。请在 CHITUBOX 里把比例 100 改成 10000，或把目标高度设为 80 mm 重跑。');
  }
  if (blenderReport?.voxelShellWarning) {
    warnings.push('体素重建后的体积接近 0，可能生成了薄壳。请在 CHITUBOX 中用截面检查壁厚，或改回「仅补小洞」。');
  }

  saveConfig({
    lastGlb: input,
    lastStl: stl,
    lastReport: report,
    targetHeightMm: targetHeight,
    repairMode: repair,
  });
  invalidateChecks();

  jobs.progress(jobId, 100, watertight === false ? '完成，但网格未完全水密' : 'STL 已生成');
  return {
    input,
    stl,
    report,
    blender,
    blenderReport,
    analysis,
    targetHeightMm: targetHeight,
    repairMode: repair,
    watertight,
    warnings,
  };
}

export async function verifyStlFile(path) {
  if (!existsSync(path)) throw new Error(`STL 不存在：${path}`);
  return analyzeStl(path);
}
