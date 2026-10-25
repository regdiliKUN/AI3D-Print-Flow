#!/usr/bin/env node
/**
 * AI3D Print Flow 命令行伴生工具。
 *
 * 网页控制台是主界面；这个 CLI 用于首次体检、脚本化调用，以及浏览器不可用
 * 时的排错。命令名与参数保持英文（便于脚本引用），输出文案统一为中文，
 * 与网页控制台和文档保持一致。
 */
import { existsSync } from 'node:fs';
import { loadConfig, publicConfig, saveConfig } from './lib/config.mjs';
import { checkEnvironment } from './lib/checks.mjs';
import { jobs } from './lib/jobs.mjs';
import { oneClickDeploy } from './lib/installer.mjs';
import { preparePixelWorkflow, prepareQwenWorkflow, listWorkflowFiles } from './lib/workflows.mjs';
import { runPostprocess } from './lib/postprocess.mjs';
import { createJobReporter } from './lib/report.mjs';
import { APP_ROOT, CONFIG_PATH, LOGS_DIR, VERSION, WORKFLOWS_DIR, resolveComfyRoot, resolveWorkspace } from './lib/paths.mjs';

const argv = process.argv.slice(2);
const command = (argv[0] || 'help').toLowerCase();

function has(flag) {
  return argv.includes(flag);
}

function option(name, fallback = '') {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) return fallback;
  return value;
}

function printHelp() {
  console.log(`
AI3D Print Flow ${VERSION}

用法：
  node app/cli.mjs <命令> [参数]

命令：
  check [--json]                 体检：Windows、NVIDIA 显卡、ComfyUI、模型、Blender、CHITUBOX
  start [--deploy] [--no-open]   启动本地控制台（--deploy 直接跳到部署区）
        [--port 17860]
  deploy [--qwen]                在终端里跑完整的一键部署
  postprocess --input <glb>      无头 Blender 清理并导出水密 STL
        [--height 80] [--repair auto|fill|voxel|none]
        [--decimate 0..0.95] [--keep-largest] [--drop-small] [--json]
  workflow list                  列出 ComfyUI 里已生成的工作流
  workflow pixel --image <png>   生成「图片 → 水密网格」工作流
        [--preset 1k|1.5k|2k] [--blender <blender.exe>]
  workflow qwen --prompt <文本>  生成 Qwen-Image 2.1 文生图工作流
        [--preset 1k|1.5k|2k] [--seed 123]
  config                         打印当前配置
  config get <键>                打印单个配置项
  config set <键>=<值>           保存单个配置项
  paths                          打印包体、工作目录与工具路径
  version                        打印版本号
  help                           显示本帮助

示例：
  node app/cli.mjs check
  node app/cli.mjs start --deploy
  node app/cli.mjs deploy --qwen
  node app/cli.mjs postprocess --input "D:\\AI3D\\dragon.glb" --height 80 --repair auto
  node app/cli.mjs workflow pixel --image "D:\\AI3D\\dragon.png" --preset 1.5k
`);
}

const STATUS_MARK = { ok: '[通过]', warn: '[注意]', fail: '[阻塞]', info: '[信息]' };

function mark(status) {
  return STATUS_MARK[status] || '[未知]';
}

function printChecks(checks) {
  console.log(`AI3D Print Flow ${VERSION}`);
  console.log(`检测时间：${checks.checkedAt}`);
  console.log('');
  for (const item of checks.items || []) {
    console.log(`${mark(item.status)} ${item.label}：${item.value}`);
    if (item.hint && item.status !== 'ok' && item.status !== 'info') {
      console.log(`        ${item.hint}`);
    }
  }
  console.log('');
  const s = checks.summary || { ok: 0, warn: 0, fail: 0 };
  console.log(`汇总：${s.ok} 项通过，${s.warn} 项注意，${s.fail} 项阻塞。`);
  console.log(checks.ready ? '环境已就绪，可以跑完整工作流。' : '环境尚未就绪，请打开控制台的「环境部署」区域。');
}

async function cmdCheck() {
  const checks = await checkEnvironment({ refresh: true });
  if (has('--json')) console.log(JSON.stringify(checks, null, 2));
  else printChecks(checks);
  if (checks.summary?.fail > 0) process.exitCode = 2;
}

async function cmdDeploy() {
  const includeQwen = has('--qwen');
  const job = jobs.create('install.oneclick', '一键部署', { includeQwen });
  const report = createJobReporter();
  const onUpdate = (publicJob) => {
    if (publicJob.id !== job.id) return;
    report(publicJob);
  };
  jobs.on('update', onUpdate);
  const onSignal = () => {
    console.log('\n正在取消部署…');
    jobs.cancel(job.id, '已在终端取消');
  };
  process.once('SIGINT', onSignal);
  try {
    const result = await oneClickDeploy(jobs, job.id, { includeQwen });
    jobs.done(job.id, result, '部署完成');
    console.log(`\n部署完成。ComfyUI 位于：${result.comfyuiRoot}`);
    if (result.skipped?.length) console.log(`已跳过：${result.skipped.join('；')}`);
  } catch (error) {
    jobs.fail(job.id, error, '部署失败');
    throw error;
  } finally {
    jobs.off('update', onUpdate);
    process.off('SIGINT', onSignal);
  }
}

async function cmdStart() {
  const port = option('--port', '');
  if (port) process.env.AI3D_PORT = port;
  if (has('--no-open')) process.env.AI3D_NO_OPEN = '1';
  await import('./server.mjs');
}

function printPostprocessResult(result) {
  const dims = result.analysis?.dimensionsMm || [];
  const final = result.blenderReport?.final || {};
  console.log('');
  console.log(`STL：${result.stl}`);
  console.log(`报告：${result.report}`);
  console.log(
    `水密：${result.watertight === true ? '是' : result.watertight === false ? '否' : '未做逐边检查'}`,
  );
  if (dims.length) console.log(`尺寸：${dims.map((n) => Number(n).toFixed(2)).join(' × ')} mm`);
  if (result.analysis?.triangles != null) console.log(`三角面：${Number(result.analysis.triangles).toLocaleString()}`);
  if (result.analysis?.volumeMm3 != null) console.log(`体积：${(result.analysis.volumeMm3 / 1000).toFixed(2)} cm³`);
  if (final.boundaryEdges != null) console.log(`边界边：${final.boundaryEdges}`);
  if (final.nonManifoldEdges != null) console.log(`非流形边：${final.nonManifoldEdges}`);
  for (const warning of result.warnings || []) console.log(`提示：${warning}`);
}

async function cmdPostprocess() {
  const config = loadConfig();
  const input = option('--input', config.lastGlb || '');
  if (!input) throw new Error('缺少 --input <文件.glb>。');
  if (!existsSync(input)) throw new Error(`文件不存在：${input}`);

  const job = jobs.create('postprocess', 'Blender 清理并导出 STL');
  const report = createJobReporter();
  const onUpdate = (publicJob) => {
    if (publicJob.id !== job.id) return;
    report(publicJob);
  };
  jobs.on('update', onUpdate);

  try {
    const heightArg = option('--height', '');
    const decimateArg = option('--decimate', '');
    const result = await runPostprocess(jobs, job.id, {
      input,
      // 未显式传参时交给 runPostprocess 使用配置默认值，避免把 0 当成「不缩放」。
      targetHeightMm: heightArg === '' ? undefined : Number(heightArg),
      repairMode: option('--repair', '') || undefined,
      decimateRatio: decimateArg === '' ? undefined : Number(decimateArg),
      keepLargest: !has('--drop-small'),
    });
    jobs.done(job.id, result, result.watertight === false ? '完成，但网格未完全水密' : 'STL 已生成');
    if (has('--json')) console.log(JSON.stringify(result, null, 2));
    else printPostprocessResult(result);
    if (result.watertight === false) process.exitCode = 2;
  } catch (error) {
    jobs.fail(job.id, error, 'Blender 后处理失败');
    throw error;
  } finally {
    jobs.off('update', onUpdate);
  }
}

async function cmdWorkflow() {
  const sub = (argv[1] || '').toLowerCase();
  if (sub === 'list' || sub === 'ls') {
    const result = listWorkflowFiles();
    console.log(`目录：${result.dir}`);
    if (!result.files.length) {
      console.log('还没有生成过工作流。');
      return;
    }
    for (const file of result.files) {
      console.log(`${file.name}  ${(file.size / 1024).toFixed(1)} KB`);
    }
    return;
  }

  if (sub === 'pixel') {
    const image = option('--image', loadConfig().lastImage || '');
    if (!image) throw new Error('缺少 --image <文件.png>。');
    const result = preparePixelWorkflow({
      imagePath: image,
      imageName: image.split(/[\\/]/).pop(),
      preset: option('--preset', '1.5k'),
      blenderPath: option('--blender', loadConfig().blenderPath || ''),
    });
    console.log(`工作流：${result.path}`);
    console.log(`显存档位：${result.presetLabel}`);
    for (const change of result.changes) console.log(`  ${change}`);
    console.log(result.note);
    return;
  }

  if (sub === 'qwen') {
    const prompt = option('--prompt', '');
    if (!prompt) throw new Error('缺少 --prompt <文本>。');
    const seedText = option('--seed', '');
    const result = prepareQwenWorkflow({
      prompt,
      preset: option('--preset', '2k'),
      seed: seedText === '' ? undefined : Number(seedText),
    });
    console.log(`工作流：${result.path}`);
    console.log(`随机种子：${result.seed}`);
    for (const change of result.changes) console.log(`  ${change}`);
    console.log(result.note);
    return;
  }

  throw new Error('用法：node app/cli.mjs workflow list|pixel|qwen');
}

function cmdConfig() {
  const sub = (argv[1] || '').toLowerCase();
  const config = loadConfig();
  if (!sub) {
    console.log(JSON.stringify(publicConfig(), null, 2));
    return;
  }
  if (sub === 'get') {
    const key = argv[2];
    if (!key) throw new Error('用法：node app/cli.mjs config get <键>');
    console.log(config[key] ?? '');
    return;
  }
  if (sub === 'set') {
    const pair = argv[2] || '';
    const index = pair.indexOf('=');
    if (index < 1) throw new Error('用法：node app/cli.mjs config set <键>=<值>');
    const key = pair.slice(0, index);
    const raw = pair.slice(index + 1);
    let value = raw;
    if (raw === 'true') value = true;
    else if (raw === 'false') value = false;
    else if (/^-?\d+(\.\d+)?$/.test(raw)) value = Number(raw);
    saveConfig({ [key]: value });
    console.log(`${key}=${value}`);
    return;
  }
  throw new Error('用法：node app/cli.mjs config [get|set]');
}

function cmdPaths() {
  const config = loadConfig();
  console.log(`包体：     ${APP_ROOT}`);
  console.log(`配置：     ${CONFIG_PATH}`);
  console.log(`工作目录： ${resolveWorkspace(config)}`);
  console.log(`ComfyUI：  ${resolveComfyRoot(config)}`);
  console.log(`工作流：   ${WORKFLOWS_DIR}`);
  console.log(`日志：     ${LOGS_DIR}`);
  console.log(`Blender：  ${config.blenderPath || '（未配置）'}`);
  console.log(`CHITUBOX： ${config.chituboxPath || '（未配置）'}`);
}

async function main() {
  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    case 'version':
    case '--version':
    case '-v':
      console.log(VERSION);
      break;
    case 'check':
    case 'doctor':
      await cmdCheck();
      break;
    case 'start':
    case 'serve':
      await cmdStart();
      break;
    case 'deploy':
      await cmdDeploy();
      break;
    case 'postprocess':
      await cmdPostprocess();
      break;
    case 'workflow':
      await cmdWorkflow();
      break;
    case 'config':
      cmdConfig();
      break;
    case 'paths':
      cmdPaths();
      break;
    default:
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`错误：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
