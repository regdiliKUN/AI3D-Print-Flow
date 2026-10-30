#!/usr/bin/env node
/**
 * 多模态输入层回归测试。
 *
 * 覆盖三块：
 *   1. 文件头解析（PNG / JPEG / WebP）—— 只看字节，不依赖第三方库；
 *   2. 提示词构建规则 —— 去重、规避项、冲突检测、错误码；
 *   3. 真实 HTTP 接口 —— /api/state 下发的档位、image.inspect、prompt.build、
 *      文本上传、client-log，以及「工作目录之外的文件必须拒绝」这条安全边界。
 */
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { inspectImageFile, readImageHeader } from '../app/lib/multimodal.mjs';
import { buildPrompt, parseCaption } from '../app/lib/multimodal.mjs';

let failed = 0;
let passed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${name}：${err.message.split('\n')[0]}`);
  }
}

/* ---------------------------------------------------------------- *
 * 1. 文件头解析
 * ---------------------------------------------------------------- */

// PNG：签名 + IHDR，宽度/高度为大端 32 位，第 25 字节是色彩类型。
function pngHeader(width, height, colorType = 6) {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8;
  buf[25] = colorType;
  return buf;
}

// JPEG：SOI + APP0 + SOF0（含高宽），足以让解析器定位尺寸。
function jpegHeader(width, height) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

// WebP：RIFF 容器 + VP8X 扩展块，含 alpha 标志位。
function webpHeader(width, height, alpha = true) {
  const buf = Buffer.alloc(40);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(32, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8X', 12, 'ascii');
  buf.writeUInt32LE(10, 16);
  buf[20] = alpha ? 0x10 : 0x00;
  buf.writeUIntLE(width - 1, 24, 3);
  buf.writeUIntLE(height - 1, 27, 3);
  return buf;
}

await check('PNG 头解析出尺寸与透明通道', () => {
  const info = readImageHeader(pngHeader(1536, 1024, 6));
  assert.equal(info.format, 'png');
  assert.equal(info.width, 1536);
  assert.equal(info.height, 1024);
  assert.equal(info.hasAlpha, true);
});

await check('PNG 不透色彩类型不带 alpha', () => {
  const info = readImageHeader(pngHeader(800, 800, 2));
  assert.equal(info.hasAlpha, false);
});

await check('JPEG 头解析出尺寸且无 alpha', () => {
  const info = readImageHeader(jpegHeader(2048, 1152));
  assert.equal(info.format, 'jpeg');
  assert.equal(info.width, 2048);
  assert.equal(info.height, 1152);
  assert.equal(info.hasAlpha, false);
});

await check('WebP VP8X 解析尺寸与 alpha 标志', () => {
  const info = readImageHeader(webpHeader(900, 675, true));
  assert.equal(info.format, 'webp');
  assert.equal(info.width, 900);
  assert.equal(info.height, 675);
  assert.equal(info.hasAlpha, true);
  const solid = readImageHeader(webpHeader(900, 675, false));
  assert.equal(solid.hasAlpha, false);
});

await check('无法识别的字节返回 null 而不是抛错', () => {
  assert.equal(readImageHeader(Buffer.from('this is not an image at all')), null);
  assert.equal(readImageHeader(Buffer.alloc(4)), null);
});

// 构造一张只有头的 PNG：IHDR + 任意块 + IEND。用于验证 tRNS 只在真正的
// tRNS 块里生效，而不是在压缩数据里搜字符串。
function pngWithChunks(width, height, colorType, chunks = [], idat = Buffer.from([0])) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    ...chunks,
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

await check('PNG 的 tRNS 只在真正的 tRNS 块里生效', () => {
  // 压缩数据里刚好出现 "tRNS" 四个字节，不能被当成透明通道。
  const fake = pngWithChunks(800, 800, 2, [], Buffer.from('xxxtRNSxxx'));
  assert.equal(readImageHeader(fake).hasAlpha, false, 'IDAT 里的 tRNS 是误判');
  const real = pngWithChunks(800, 800, 2, [pngChunk('tRNS', Buffer.from([0, 0, 0, 0, 0, 0]))]);
  assert.equal(readImageHeader(real).hasAlpha, true, '真正的 tRNS 应该被识别');
  // 带原生 alpha 的色彩类型不依赖 tRNS。
  assert.equal(readImageHeader(pngWithChunks(800, 800, 6)).hasAlpha, true);
});

await check('超大尺寸图片在解码前就被拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai3d-huge-'));
  try {
    const tooWide = join(dir, 'wide.png');
    writeFileSync(tooWide, pngWithChunks(20_001, 100, 2));
    await assert.rejects(() => inspectImageFile(tooWide), (err) => err.code === 'E_IMAGE_TOO_LARGE');
    const tooMany = join(dir, 'many.png');
    writeFileSync(tooMany, pngWithChunks(12_000, 12_000, 2));
    await assert.rejects(() => inspectImageFile(tooMany), (err) => err.code === 'E_IMAGE_TOO_LARGE');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------- *
 * 2. 提示词构建
 * ---------------------------------------------------------------- */

await check('中文提示词会补上结构化收尾与规避项', () => {
  const out = buildPrompt({ subject: '盘踞在圆形底座上的东方龙', style: '鳞片清晰' });
  assert.equal(out.language, 'zh');
  assert.match(out.positive, /东方龙/);
  assert.match(out.positive, /单一紧凑主体/);
  assert.match(out.positive, /不要出现/);
  assert.ok(out.chars > 20);
});

await check('英文提示词使用英文收尾', () => {
  const out = buildPrompt({ subject: 'a crouching gargoyle', style: 'chunky anatomy' });
  assert.equal(out.language, 'en');
  assert.match(out.positive, /single compact subject/);
  assert.match(out.positive, /, no multiple subjects/);
});

await check('重复短语只保留一次', () => {
  const out = buildPrompt({ subject: 'a dragon, a dragon, stone base', style: 'stone base' });
  const count = (out.positive.match(/stone base/g) || []).length;
  assert.equal(count, 1, `期望 1 次，实际 ${count} 次`);
});

await check('多主体描述会被标记为风险', () => {
  const out = buildPrompt({ subject: '三个骑士站成一排' });
  assert.ok(out.warnings.some((w) => w.code === 'MULTI_SUBJECT'));
  assert.ok(out.tags.includes('多主体'));
});

await check('否定短语不会误触发文字规则', () => {
  const out = buildPrompt({ subject: 'a dragon', style: 'no text, no watermark, neutral background' });
  assert.ok(!out.warnings.some((w) => w.code === 'TEXT_IN_IMAGE'), 'no text 不应被当成要生成文字');
});

await check('「干净背景」不会被误判为复杂背景', () => {
  const out = buildPrompt({
    subject: 'a dragon',
    style: 'clean solid background, no text, no watermark',
  });
  assert.ok(
    !out.warnings.some((w) => w.code === 'BUSY_BACKGROUND'),
    `干净背景不应触发复杂背景提醒：${JSON.stringify(out.warnings)}`,
  );
  const zh = buildPrompt({ subject: '一条龙', style: '纯色背景，干净背景' });
  assert.ok(!zh.warnings.some((w) => w.code === 'BUSY_BACKGROUND'), '中文的干净背景也不应触发');
  const busy = buildPrompt({ subject: '一条龙', style: '背景是热闹的街道' });
  assert.ok(busy.warnings.some((w) => w.code === 'BUSY_BACKGROUND'), '真实复杂背景仍应提醒');
});

await check('透明材质描述会被提醒', () => {
  const out = buildPrompt({ subject: 'a glass potion bottle with glowing liquid' });
  assert.ok(out.warnings.some((w) => w.code === 'NON_PRINTABLE_MATERIAL'));
});

await check('空主体抛出 E_PROMPT_EMPTY', () => {
  assert.throws(() => buildPrompt({ subject: '   ' }), (err) => err.code === 'E_PROMPT_EMPTY');
});

await check('超长提示词抛出 E_PROMPT_TOO_LONG', () => {
  const long = '龙'.repeat(4200);
  assert.throws(() => buildPrompt({ subject: long }), (err) => err.code === 'E_PROMPT_TOO_LONG');
});

await check('parseCaption 能拆出三段结构', () => {
  const parsed = parseCaption('主体：一只石像鬼\n风格：粗糙石质，顶光\n细节：双翼、尾巴、底座');
  assert.equal(parsed.structured, true);
  assert.match(parsed.subject, /石像鬼/);
  assert.match(parsed.style, /石质/);
  assert.match(parsed.detail, /双翼/);
});

await check('parseCaption 遇到自由文本时退化为整行主体', () => {
  const parsed = parseCaption('一只蹲伏的石像鬼，双翼半展。');
  assert.equal(parsed.structured, false);
  assert.match(parsed.subject, /石像鬼/);
});

await check('parseCaption 支持 JSON 与 Markdown 代码块', () => {
  const fenced = parseCaption('```json\n{"subject":"石像鬼","style":"粗糙石质","details":["双翼","尾巴"]}\n```');
  assert.equal(fenced.structured, true);
  assert.equal(fenced.subject, '石像鬼');
  assert.equal(fenced.style, '粗糙石质');
  assert.equal(fenced.detail, '双翼，尾巴');
  const english = parseCaption('{"object":"a gargoyle","style":"stone","detail":"wings, tail"}');
  assert.equal(english.subject, 'a gargoyle');
  assert.match(english.detail, /wings/);
});

await check('parseCaption 对 JSON 和自由文本都限制长度', () => {
  const long = parseCaption(JSON.stringify({ subject: '龙'.repeat(500), style: '石'.repeat(500), detail: '鳞'.repeat(900) }));
  assert.equal(long.subject.length, 300);
  assert.equal(long.style.length, 300);
  assert.equal(long.detail.length, 400);
});

/* ---------------------------------------------------------------- *
 * 3. 真实接口
 * ---------------------------------------------------------------- */

const PKG_ROOT = resolve(import.meta.dirname, '..');
const root = join(tmpdir(), `ai3d-test-multimodal-${process.pid}-${Date.now()}`);

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** 生成一张真实可解码的 PNG，避免用假文件头糊弄解析器。 */
function makePng(width, height, { alpha = true } = {}) {
  const channels = alpha ? 4 : 3;
  const stride = width * channels + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const p = row + 1 + x * channels;
      // 中间画一个圆，四角留白 —— 让主体占比 / 背景统计有真实输入。
      const dx = x - width / 2;
      const dy = y - height / 2;
      const inside = dx * dx + dy * dy < (Math.min(width, height) / 3) ** 2;
      raw[p] = inside ? 210 : 245;
      raw[p + 1] = inside ? 120 : 245;
      raw[p + 2] = inside ? 60 : 245;
      if (alpha) raw[p + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function makeSandbox() {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  for (const dir of ['app', 'blender', 'vendor', 'docs']) {
    cpSync(join(PKG_ROOT, dir), join(root, dir), { recursive: true });
  }
  cpSync(join(PKG_ROOT, 'package.json'), join(root, 'package.json'));
  const installRoot = join(root, 'AI3D');
  mkdirSync(installRoot, { recursive: true });
  mkdirSync(join(root, 'config'), { recursive: true });
  cpSync(join(PKG_ROOT, 'config', 'default.json'), join(root, 'config', 'default.json'));
  writeFileSync(
    join(root, 'config', 'config.json'),
    JSON.stringify({ version: 1, installRoot, comfyuiRoot: join(installRoot, 'ComfyUI-Easy-Install') }, null, 2),
  );
  for (const dir of ['workspace/input', 'workspace/glb', 'workspace/stl', 'workspace/reports', 'workspace/text', 'workflows', 'logs']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
}

function startServer(port) {
  const child = spawn(process.execPath, ['app/server.mjs', '--no-open'], {
    cwd: root,
    env: { ...process.env, AI3D_NO_OPEN: '1', AI3D_NO_SAVE_PORT: '1', AI3D_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const ready = new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`服务未启动：\n${output}`)), 20000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const match = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(output);
      if (match) {
        clearTimeout(timer);
        resolveReady(`http://127.0.0.1:${match[1]}`);
      }
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
  });
  return { child, ready };
}

const port = 18800 + (process.pid % 300);
makeSandbox();
// 工作目录外的文件：用来验证越界读取会被拒绝。
writeFileSync(join(root, 'outside.png'), makePng(64, 64));
const goodPng = makePng(1200, 900);
const tinyPng = makePng(180, 180);
const { child, ready } = startServer(port);

try {
  const base = await ready;
  const post = (action, payload = {}) =>
    fetch(`${base}/api/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, payload }),
    }).then(async (res) => ({ status: res.status, body: await res.json() }));

  const upload = async (kind, name, buffer) => {
    const res = await fetch(`${base}/api/upload?kind=${kind}&name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buffer,
    });
    return { status: res.status, body: await res.json() };
  };

  await check('GET /api/state 下发档位与上限', async () => {
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.ok, true);
    assert.deepEqual(Object.keys(state.presets).sort(), ['1.5k', '1k', '2k']);
    assert.equal(state.presets['1.5k'].proxy, 12_000_000);
    assert.equal(state.limits.poolSize, 8);
    assert.equal(state.features.multimodal, true);
  });

  const good = await upload('input', 'good.png', goodPng);
  const tiny = await upload('input', 'tiny.png', tinyPng);

  await check('上传返回 workspace 内的绝对路径', async () => {
    assert.equal(good.status, 200);
    assert.match(good.body.path, /workspace[\\/]input[\\/]good\.png$/);
    assert.equal(tiny.status, 200);
  });

  await check('image.inspect 读出真实尺寸与结论', async () => {
    const res = await post('image.inspect', { path: good.body.path, preset: '1.5k' });
    assert.equal(res.status, 200);
    const img = res.body.image;
    assert.equal(img.width, 1200);
    assert.equal(img.height, 900);
    assert.equal(img.format, 'png');
    assert.equal(img.hasAlpha, true);
    assert.ok(img.score > 0 && img.score <= 100);
    assert.ok(Array.isArray(img.findings) && img.findings.length > 0);
  });

  await check('GET /api/file 支持 ETag 条件请求', async () => {
    const url = `${base}/api/file?path=${encodeURIComponent(good.body.path)}`;
    const first = await fetch(url);
    assert.equal(first.status, 200);
    const etag = first.headers.get('etag');
    assert.ok(etag, '缺少 ETag');
    assert.match(first.headers.get('cache-control') || '', /no-cache/);
    assert.ok((await first.arrayBuffer()).byteLength > 0);
    const second = await fetch(url, { headers: { 'If-None-Match': etag } });
    assert.equal(second.status, 304);
    assert.equal((await second.arrayBuffer()).byteLength, 0);
  });

  await check('分辨率过低的图片被判为 risk', async () => {
    const res = await post('image.inspect', { path: tiny.body.path, preset: '1.5k' });
    assert.equal(res.status, 200);
    assert.equal(res.body.image.level, 'risk');
    assert.ok(res.body.image.findings.some((f) => f.code === 'RESOLUTION_TINY'));
  });

  await check('image.inspect 拒绝工作目录之外的路径', async () => {
    const res = await post('image.inspect', { path: join(root, 'outside.png') });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'E_PATH_OUTSIDE');
    assert.match(res.body.hint, /workspace/);
  });

  await check('image.pool 列出刚上传的图片', async () => {
    const res = await post('image.pool', {});
    assert.equal(res.status, 200);
    const names = res.body.pool.items.map((item) => item.name);
    assert.ok(names.includes('good.png'));
  });

  await check('prompt.build 通过接口返回规范化提示词', async () => {
    const res = await post('prompt.build', { subject: '盘踞在底座上的龙', style: '细节清晰', preset: '2k' });
    assert.equal(res.status, 200);
    assert.match(res.body.prompt.positive, /龙/);
    assert.ok(res.body.prompt.chars > 0);
  });

  await check('prompt.build 空主体返回 400 + E_PROMPT_EMPTY', async () => {
    const res = await post('prompt.build', { subject: '' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'E_PROMPT_EMPTY');
  });

  await check('未知档位被拒绝而不是静默回退', async () => {
    const res = await post('prompt.build', { subject: 'a dragon', preset: '4k' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /显存档位/);
  });

  await check('文本提示词可作为上传模态', async () => {
    const res = await upload('text', 'prompt.txt', Buffer.from('一只石像鬼\n粗糙石质，顶光\n', 'utf8'));
    assert.equal(res.status, 200);
    assert.match(res.body.text, /石像鬼/);
    assert.equal(res.body.kind, 'text');
  });

  await check('二进制内容伪装成 .txt 会被拒绝', async () => {
    const res = await upload('text', 'bad.txt', Buffer.from([0x00, 0x01, 0x02, 0x00, 0x41]));
    assert.equal(res.status, 400);
  });

  await check('vlm.status 在没装视觉模型时给出可用的降级信息', async () => {
    // 指向一个几乎不可能有服务在听的端口，避免本机真的跑着 Ollama 时测试结果抖动。
    await post('config.save', { patch: { vlmUrl: 'http://127.0.0.1:1/v1', vlmModel: '' } });
    const res = await post('vlm.status', { timeoutMs: 800 });
    assert.equal(res.status, 200);
    assert.equal(res.body.vlm.available, false, `不应连上：${JSON.stringify(res.body.vlm)}`);
    assert.ok(res.body.vlm.endpoint.startsWith('http'));
    assert.ok(res.body.vlm.error.length > 0);
  });

  await check('vlm.status 在地址留空时明确标记 disabled，而不是假装连接失败', async () => {
    await post('config.save', { patch: { vlmUrl: '', vlmModel: '' } });
    const res = await post('vlm.status', { timeoutMs: 800 });
    assert.equal(res.status, 200);
    assert.equal(res.body.vlm.available, false);
    assert.equal(res.body.vlm.disabled, true);
    assert.equal(res.body.vlm.endpoint, '');
    assert.match(res.body.vlm.error, /未配置/);
  });

  await check('vlm.status 携带 Bearer Key，且显式模型不要求在列表中', async () => {
    let authorization = '';
    const fake = createServer((req, res) => {
      authorization = String(req.headers.authorization || '');
      if (req.url !== '/v1/models') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      if (authorization !== 'Bearer sk-test-key') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":"unauthorized"}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'qwen3:8b' }] }));
    });
    await new Promise((resolveReady, reject) => {
      fake.once('error', reject);
      fake.listen(0, '127.0.0.1', resolveReady);
    });
    try {
      const { port: fakePort } = fake.address();
      const endpoint = `http://127.0.0.1:${fakePort}/v1`;
      await post('config.save', { patch: { vlmUrl: endpoint, vlmModel: 'my-vision-model', vlmApiKey: 'sk-test-key' } });
      const res = await post('vlm.status', { timeoutMs: 2000 });
      assert.equal(res.status, 200);
      assert.equal(res.body.vlm.available, true, JSON.stringify(res.body.vlm));
      assert.equal(res.body.vlm.model, 'my-vision-model');
      assert.equal(res.body.vlm.auth, true);
      assert.equal(authorization, 'Bearer sk-test-key');

      // 密钥只写不读：state / config.save 的响应里都不能出现明文。
      const state = await (await fetch(`${base}/api/state`)).json();
      assert.equal(state.config.vlmHasKey, true);
      assert.equal(state.features.vlm.hasKey, true);
      assert.ok(!Object.hasOwn(state.config, 'vlmApiKey'));
      assert.ok(!JSON.stringify(state).includes('sk-test-key'));

      const saved = await post('config.save', { patch: { vlmModel: 'my-vision-model' } });
      assert.equal(saved.status, 200);
      assert.ok(!JSON.stringify(saved.body).includes('sk-test-key'));
      assert.ok(!Object.hasOwn(saved.body, 'saved'), 'config.save 不应回显完整配置');
    } finally {
      await new Promise((resolveClose) => fake.close(resolveClose));
    }
  });

  await check('清除 vlmApiKey 后页面状态立即变为无密钥', async () => {
    const saved = await post('config.save', { patch: { vlmApiKey: '', vlmUrl: '' } });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.config.vlmHasKey, false);
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.config.vlmHasKey, false);
    assert.equal(state.features.vlm.hasKey, false);
    assert.ok(!JSON.stringify(state).includes('sk-test-key'));
  });

  await check('client-log 接收页面错误且不报错', async () => {
    const res = await fetch(`${base}/api/client-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ where: 'test', message: 'boom', stack: 'Error: boom' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  });

  await check('client-log 对非 JSON 请求体保持宽容（不制造新的报错）', async () => {
    const res = await fetch(`${base}/api/client-log`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  });

  await check('image.forget 删除 input 目录内的图片', async () => {
    const res = await post('image.forget', { path: tiny.body.path });
    assert.equal(res.status, 200);
    const pool = await post('image.pool', {});
    assert.ok(!pool.body.pool.items.some((item) => item.name === 'tiny.png'));
  });
} finally {
  child.kill();
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
}

console.log('');
console.log(failed === 0 ? `多模态测试 OK（${passed} 项）` : `多模态测试失败 ${failed} 项，通过 ${passed} 项`);
process.exit(failed === 0 ? 0 : 1);
