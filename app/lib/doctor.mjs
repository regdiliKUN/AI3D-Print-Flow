import { join, resolve } from 'node:path';
import { MODEL_SPECS, checkEnvironment } from './checks.mjs';
import { loadConfig } from './config.mjs';
import { inspectComfyInstall } from './installer.mjs';
import { listLocalModelStacks, scanCompatibleModels } from './models.mjs';
import { formatBytes } from './util.mjs';

function issue(level, code, title, detail, fix) {
  return { level, code, title, detail, fix };
}

function samePath(a, b) {
  if (!a || !b) return false;
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

function modelDest(comfyRoot, spec) {
  return join(comfyRoot, 'ComfyUI', 'models', spec.sub, spec.file);
}

/**
 * Post-deploy doctor. It deliberately reuses the normal environment check (so
 * the dashboard and the doctor never disagree) and adds the two things that a
 * generic check cannot express:
 *
 * 1. an incomplete ComfyUI folder is a specific, actionable failure (missing
 *    main.py OR python_embeded/python.exe), not just "not found";
 * 2. local LLM / Stable Diffusion weights are inventoried and explained, so a
 *    user does not expect Ollama or an HF chat model to power TRELLIS.2.
 */
export async function runDeployDoctor({ refresh = true } = {}) {
  const checks = await checkEnvironment({ refresh });
  // checkEnvironment may auto-detect a complete ComfyUI install and save it.
  // Reload so model target paths use the same root as the status checks.
  const config = loadConfig();
  const items = Array.isArray(checks.items) ? checks.items : [];
  const metrics = checks.metrics || {};
  const installRoot = metrics.installRoot || config.installRoot || '';
  const comfyRoot =
    metrics.comfyRoot ||
    config.comfyuiRoot ||
    (installRoot ? join(installRoot, 'ComfyUI-Easy-Install') : '');
  const comfy = inspectComfyInstall(comfyRoot);

  let found = [];
  let stacks = [];
  try {
    found = scanCompatibleModels(config);
  } catch {
    found = [];
  }
  try {
    stacks = listLocalModelStacks();
  } catch {
    stacks = [];
  }

  const issues = [];
  const byId = new Map(items.map((item) => [item.id, item]));

  // ---- ComfyUI installation ------------------------------------------
  if (!comfy.exists) {
    issues.push(
      issue(
        'fail',
        'COMFY_MISSING',
        '没有找到 ComfyUI 安装目录',
        `检查位置：${comfyRoot || '（配置为空）'}`,
        '点「一键部署」自动安装，或按「手动分步」第 01 步下载并运行 ComfyUI Easy Install。',
      ),
    );
  } else if (!comfy.complete) {
    issues.push(
      issue(
        'fail',
        'COMFY_INCOMPLETE',
        `ComfyUI 安装不完整：缺少 ${comfy.missing.join('、')}`,
        `目录：${comfy.root}`,
        '先关闭 ComfyUI / python.exe 和打开该目录的资源管理器窗口，并检查火绒 / Windows Defender 的隔离区。' +
          '然后重新点「一键部署」；控制台会先把不完整目录改名为 .incomplete-<时间>，再运行官方安装器。',
      ),
    );
  }

  // ---- System checks --------------------------------------------------
  const systemIds = new Set(['gpu', 'disk', 'ram']);
  for (const item of items) {
    if (!systemIds.has(item.id) || item.status === 'ok' || item.status === 'info') continue;
    issues.push(
      issue(
        item.status === 'fail' ? 'fail' : 'warn',
        `CHECK_${item.id.toUpperCase()}`,
        `${item.label}：${item.value}`,
        item.hint || '',
        item.id === 'disk'
          ? '清理安装盘或换到空间更大的目录；断点续传文件会保留。'
          : item.id === 'gpu'
            ? '本工作流需要 NVIDIA RTX 20 系及以上并安装最新驱动。'
            : '关闭占用内存的程序；2K 工作流建议 32 GB 内存。',
      ),
    );
  }

  // ---- Torch / nodes / workflows --------------------------------------
  const torch = byId.get('comfy.torch');
  if (comfy.complete && torch && torch.status !== 'ok' && torch.status !== 'info') {
    issues.push(
      issue(
        'fail',
        'TORCH_MISMATCH',
        'Python / PyTorch / CUDA 版本不符合要求',
        `${torch.value}。${torch.hint || ''}`.trim(),
        '关闭 ComfyUI，运行 ComfyUI-Easy-Install\\Add-ons 里的 Torch 2.8.0 切换脚本；必须是 Python 3.12 + PyTorch 2.8.0 + CUDA 12.8。',
      ),
    );
  }

  const nodeItems = items.filter((item) => item.id === 'trellis.node' || item.id.startsWith('node.'));
  const missingNodes = nodeItems.filter((item) => item.status === 'fail');
  if (comfy.complete && missingNodes.length) {
    issues.push(
      issue(
        'fail',
        'NODES_MISSING',
        `缺少 ${missingNodes.length} 个必需节点`,
        missingNodes.map((item) => item.label).join('、'),
        '关闭 ComfyUI 后重跑 Add-ons 里的 TRELLIS.2 安装脚本和 PixelArtistry 水密节点安装器。',
      ),
    );
  }

  const workflows = byId.get('pixel.workflows');
  if (comfy.complete && workflows && workflows.status === 'fail') {
    issues.push(
      issue(
        'fail',
        'WORKFLOWS_MISSING',
        'PixelArtistry 工作流缺失',
        workflows.value,
        '点「仅写入工作流」，或重跑 PixelArtistry 安装器。',
      ),
    );
  }

  // ---- Required / optional models ------------------------------------
  const candidates = found.filter((item) => item.enough);
  for (const spec of MODEL_SPECS) {
    const item = byId.get(spec.id);
    if (!item || item.status === 'ok' || item.status === 'info') continue;
    const dest = comfyRoot ? modelDest(comfyRoot, spec) : '';
    const external = candidates.find((candidate) => candidate.file === spec.file && !samePath(candidate.path, dest));
    if (external) {
      issues.push(
        issue(
          'fail',
          'MODEL_REUSE_AVAILABLE',
          `${spec.label} 未就位，但本机已有同名文件`,
          `${external.file} · ${formatBytes(external.size)} · ${external.path}`,
          `重新运行「一键部署」并勾选「自动复用本机同名模型」，控制台会硬链接到 ${dest}；也可手动复制。`,
        ),
      );
      continue;
    }
    const partial = spec.required ? 'fail' : 'warn';
    issues.push(
      issue(
        item.status === 'warn' ? 'warn' : partial,
        item.status === 'warn' ? 'MODEL_INCOMPLETE' : 'MODEL_MISSING',
        item.status === 'warn' ? `${spec.label} 文件偏小` : `${spec.label} 缺失`,
        item.status === 'warn' ? `${item.value}。${item.hint || ''}`.trim() : `应位于 ${dest || `ComfyUI/models/${spec.sub}/`}`,
        spec.required
          ? '关闭 ComfyUI 后重跑 PixelArtistry 水密安装器（AUTO_DL=Y），或按日志里的文件名手动下载到对应 models 子目录。'
          : '这是可选模型；需要该功能时再通过 ComfyUI Manager 或安装器补齐。',
      ),
    );
  }

  // ---- Tools ----------------------------------------------------------
  const blender = byId.get('blender');
  if (blender && blender.status === 'fail') {
    issues.push(
      issue(
        'warn',
        'BLENDER_MISSING',
        '未找到 Blender',
        blender.hint || 'Blender 后处理与 STL 导出需要 Blender 4.2+。',
        '点「winget 安装」或在设置里填写 blender.exe 完整路径（不要带引号）。生成 3D 网格本身不依赖 Blender，但导出 STL 依赖它。',
      ),
    );
  }
  const chitubox = byId.get('chitubox');
  if (chitubox && chitubox.status === 'warn') {
    issues.push(
      issue(
        'info',
        'CHITUBOX_MISSING',
        '未找到 CHITUBOX',
        chitubox.hint || '用于加支撑和切片，也可以用其它光固化切片器。',
        '需要光固化打印时安装 CHITUBOX；FDM 用户可忽略。',
      ),
    );
  }

  // ---- ComfyUI service ------------------------------------------------
  const port = byId.get('comfy.port');
  if (comfy.complete && port && port.status !== 'ok') {
    issues.push(
      issue(
        'info',
        'COMFY_STOPPED',
        'ComfyUI 当前未启动',
        port.value,
        '点「启动 ComfyUI」，等待 8188 端口就绪后再运行工作流。',
      ),
    );
  }

  // ---- Local model inventory -----------------------------------------
  const externalReuse = comfy.complete
    ? candidates.filter((candidate) => {
        const spec = MODEL_SPECS.find((entry) => entry.file === candidate.file);
        return spec && !samePath(candidate.path, modelDest(comfyRoot, spec));
      })
    : [];
  if (stacks.length) {
    const inventory = stacks
      .map((stack) => {
        const shown = stack.models.slice(0, 6).join('、');
        const more = stack.models.length > 6 ? ` 等 ${stack.models.length} 个` : '';
        return `${stack.label}：${shown}${more}`;
      })
      .join('；');
    issues.push(
      issue(
        'info',
        'LOCAL_STACKS',
        '本机其它 AI 模型不能直接用于这条工作流',
        `${inventory}。${stacks.map((stack) => stack.reason).join(' ')}`,
        '本流程只复用精确同名的 Qwen-Image 2.1 / TRELLIS.2 权重；Ollama、Hugging Face 聊天模型和 Stable Diffusion 检查点都需要单独下载对应模型。',
      ),
    );
  }

  const summary = {
    ok: checks.summary?.ok || 0,
    warn: issues.filter((item) => item.level === 'warn').length,
    fail: issues.filter((item) => item.level === 'fail').length,
    info: issues.filter((item) => item.level === 'info').length,
    checks: checks.summary || null,
    reuse: {
      compatible: candidates.length,
      partial: found.length - candidates.length,
      external: externalReuse.length,
      stacks: stacks.length,
    },
  };

  const next = [];
  if (!comfy.exists || !comfy.complete) {
    next.push('关闭 ComfyUI / 占用安装目录的程序，检查杀毒软件隔离区，然后重新点「一键部署」。');
  }
  if (comfy.complete && torch && torch.status !== 'ok' && torch.status !== 'info') {
    next.push('运行 Add-ons 里的 Torch 2.8.0 切换脚本，确认 Python 3.12 / Torch 2.8.0 / CUDA 12.8。');
  }
  if (externalReuse.length) {
    next.push('重新运行「一键部署」并勾选「自动复用本机同名模型」，避免重复下载。');
  }
  if (comfy.complete && missingNodes.length) {
    next.push('关闭 ComfyUI 后重跑 TRELLIS.2 与 PixelArtistry 安装器。');
  }
  if (comfy.complete && port && port.status !== 'ok') {
    next.push('点「启动 ComfyUI」，等待 8188 端口就绪。');
  }
  if (!next.length) {
    next.push('自检未发现阻塞项：打开 ComfyUI → Workflows → PixelArtistry，生成第一条模型。');
  }

  return {
    ok: summary.fail === 0,
    summary,
    generatedAt: new Date().toISOString(),
    issues,
    checks,
    comfy,
    reuse: {
      compatible: candidates,
      placed: candidates.filter((item) => {
        const spec = MODEL_SPECS.find((entry) => entry.file === item.file);
        return spec && samePath(item.path, modelDest(comfyRoot, spec));
      }),
      external: externalReuse,
      partial: found.filter((item) => !item.enough),
      stacks,
    },
    next,
  };
}
