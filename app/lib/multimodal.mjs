/**
 * 多模态输入层。
 *
 * 这条工作流的入口只有两种模态：文字（提示词）和图片（单图转 3D）。本模块
 * 把「输入」当成一等对象来处理，而不是把一堆校验散落在 HTTP 处理函数里：
 *
 * 1. `inspectImageFile()`   —— 直接读文件头解析 PNG / JPEG / WebP 的真实尺寸、
 *    色彩类型与透明通道，再结合显存档位给出「这张图适不适合转网格」的判断。
 *    全程不依赖第三方库，也不上传任何像素到外部服务。
 * 2. `buildPrompt()`        —— 把中文/英文混合的口语描述整理成 Qwen-Image 2.1
 *    能稳定执行的提示词，并检测「多主体 / 文字 / 透明材质」等必然翻车的描述。
 * 3. `vlmStatus()` / `vlmCaption()` —— 可选地接一个本地视觉模型（Ollama、
 *    LM Studio 等 OpenAI 兼容端点），实现「看图写提示词」，让图片→文字→图片
 *    →3D 形成闭环。没有视觉模型时整条链路照常工作，只是少了这一步。
 *
 * 设计约束：所有能力都必须有「没有它也能用」的降级路径。视觉模型不可用不是
 * 错误，只是一种能力缺失，页面据此隐藏按钮而不是弹红框。
 */
import { readFile, open, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { AppError, ERROR_CODES } from './errors.mjs';
import { DEFAULT_VLM_URL, LIMITS, presetInfo } from './presets.mjs';

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const MIME_BY_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const DEFAULT_IMG_HINT = '支持 PNG / JPG / WebP。若文件来自截图工具，请另存为标准 PNG 后重试。';

/* ------------------------------------------------------------------ *
 * 1. 文件头解析
 * ------------------------------------------------------------------ */

/**
 * 只读文件头就能拿到的真实元信息。扩展名可以随便改，文件头不会。
 * 返回 null 表示无法识别（例如把 .webp 改名成 .png）。
 */
export function readImageHeader(buf) {
  if (!buf || buf.length < 16) return null;

  // ---- PNG ----
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (PNG_SIG.every((byte, i) => buf[i] === byte)) {
    if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    if (!width || !height) return null;
    const bitDepth = buf[24] || 8;
    const colorType = buf[25];
    // alpha 只由色彩类型或真正的 tRNS 块决定。旧实现直接在整段字节里搜
    // "tRNS"，压缩数据里恰好出现这四个字符就会误判；这里按块遍历。
    let hasAlpha = colorType === 4 || colorType === 6;
    let offset = 8;
    while (offset + 12 <= buf.length) {
      const length = buf.readUInt32BE(offset);
      const type = buf.toString('ascii', offset + 4, offset + 8);
      if (type === 'tRNS' && (colorType === 0 || colorType === 2 || colorType === 3)) {
        hasAlpha = true;
        break;
      }
      if (type === 'IDAT' || type === 'IEND') break;
      // 块长度异常时停止，避免越界读。
      if (length > buf.length) break;
      offset += 12 + length;
    }
    return { format: 'png', width, height, hasAlpha, bitDepth };
  }

  // ---- JPEG ----
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buf[offset + 1];
      // 填充字节与无长度字段的独立标记
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS 之前没有 SOF
      const length = buf.readUInt16BE(offset + 2);
      if (length < 2) break;
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        const height = buf.readUInt16BE(offset + 5);
        const width = buf.readUInt16BE(offset + 7);
        if (!width || !height) return null;
        return { format: 'jpeg', width, height, hasAlpha: false, bitDepth: 8 };
      }
      offset += 2 + length;
    }
    return null;
  }

  // ---- WebP ----
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16);
    if (kind === 'VP8X') {
      const flags = buf[20];
      const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      if (!width || !height) return null;
      return { format: 'webp', width, height, hasAlpha: (flags & 0x10) !== 0, bitDepth: 8 };
    }
    if (kind === 'VP8 ') {
      if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      if (!width || !height) return null;
      return { format: 'webp', width, height, hasAlpha: false, bitDepth: 8 };
    }
    if (kind === 'VP8L') {
      if (buf[20] !== 0x2f) return null;
      const bits = buf.readUInt32LE(21);
      const width = 1 + (bits & 0x3fff);
      const height = 1 + ((bits >> 14) & 0x3fff);
      if (!width || !height) return null;
      // 无损格式的第 28 位表示是否带 alpha。
      return { format: 'webp', width, height, hasAlpha: ((bits >> 28) & 1) === 1, bitDepth: 8 };
    }
  }
  return null;
}

function finding(level, code, title, detail, fix = '') {
  return { level, code, title, detail, fix };
}

/**
 * 只读文件头，绝不把几十 MB 的图片整个读进内存。
 * 先取 1 MB（覆盖绝大多数 EXIF / ICC / 调色板），仍解析不出再退到 4 MB。
 */
async function readHeaderProbe(path, fileSize) {
  const readAtMost = async (cap) => {
    const handle = await open(path, 'r');
    try {
      const buf = Buffer.alloc(Math.min(cap, fileSize));
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  };
  const first = await readAtMost(1024 * 1024);
  const header = readImageHeader(first);
  if (header) return header;
  if (fileSize > first.length) return readImageHeader(await readAtMost(4 * 1024 * 1024));
  return null;
}

/**
 * 给一张输入图打分（0–100）并列出可执行的建议。
 *
 * 这里刻意不做「看起来像不像可打印模型」的猜测——那需要真正的视觉模型。
 * 只做能确定的判断：像素够不够、画幅会不会裁掉主体、压缩是否过重、有无
 * 透明通道。确定性判断不会误伤用户，也能直接给出改法。
 */
export async function inspectImageFile(path, { preset = '1.5k' } = {}) {
  if (!path || !existsSync(path)) {
    throw new AppError(ERROR_CODES.IMAGE_MISSING, `图片不存在：${path || '(空)'}`, {
      hint: '重新拖入图片后再试一次。',
    });
  }
  if (!IMAGE_EXT.test(path)) {
    throw new AppError(ERROR_CODES.IMAGE_INVALID, `只支持 PNG / JPG / WebP，收到：${extname(path) || '(无扩展名)'}`, {
      hint: DEFAULT_IMG_HINT,
    });
  }
  const info = await stat(path);
  if (info.size === 0) {
    throw new AppError(ERROR_CODES.IMAGE_INVALID, '图片是空文件（0 字节）', { hint: DEFAULT_IMG_HINT });
  }
  if (info.size > LIMITS.uploadImage) {
    throw new AppError(
      ERROR_CODES.IMAGE_TOO_LARGE,
      `图片 ${(info.size / 1024 ** 2).toFixed(1)} MB，超过 ${(LIMITS.uploadImage / 1024 ** 2).toFixed(0)} MB 上限`,
      { hint: '先缩放到 2048 px 以内再导入；转网格用不到这么大的原图。' },
    );
  }
  const header = await readHeaderProbe(path, info.size);
  if (!header) {
    throw new AppError(
      ERROR_CODES.IMAGE_INVALID,
      `无法解析图片头，文件可能不是真正的 ${extname(path).slice(1).toUpperCase()}。`,
      { hint: '用画图 / Photoshop 重新导出一次，或换一张图。' },
    );
  }
  if (header.width > LIMITS.imageMaxSide || header.height > LIMITS.imageMaxSide) {
    throw new AppError(
      ERROR_CODES.IMAGE_TOO_LARGE,
      `图片尺寸异常（${header.width}×${header.height}）`,
      { hint: `单边超过 ${LIMITS.imageMaxSide} px 的图多半是拼接图或损坏文件，请先裁剪。` },
    );
  }
  if (header.width * header.height > LIMITS.imageMaxPixels) {
    throw new AppError(
      ERROR_CODES.IMAGE_TOO_LARGE,
      `图片像素过多（${header.width}×${header.height}）`,
      { hint: `超过 ${(LIMITS.imageMaxPixels / 1e6).toFixed(0)} MP 的图无法有效转网格，请先降低分辨率。` },
    );
  }

  const p = presetInfo(preset);
  const { width, height, format, hasAlpha } = header;
  const bytes = info.size;
  const minSide = Math.min(width, height);
  const maxSide = Math.max(width, height);
  const aspect = width / height;
  const megapixels = (width * height) / 1e6;
  const bytesPerPixel = bytes / (width * height);
  const findings = [];
  let score = 100;

  if (minSide < 256) {
    score -= 45;
    findings.push(
      finding(
        'risk',
        'RESOLUTION_TINY',
        `分辨率过低（${width}×${height}）`,
        '短边不足 256 px 时，纹理细节在转网格前就丢失了，模型只能靠猜。',
        '换一张至少 1024×1024 的图，或先用超分工具放大。',
      ),
    );
  } else if (minSide < p.minSourcePx) {
    score -= 18;
    findings.push(
      finding(
        'warn',
        'RESOLUTION_LOW',
        `分辨率偏低（${width}×${height}）`,
        `${p.label} 档会按 ${p.resolution} px 处理，短边 ${minSide} px 会被放大，细节不会凭空出现。`,
        `短边建议 ≥ ${p.minSourcePx} px；或改选 1K 档减少无效计算。`,
      ),
    );
  } else {
    findings.push(
      finding('ok', 'RESOLUTION_OK', `分辨率合适（${width}×${height}）`, `短边 ${minSide} px，满足 ${p.label} 档处理需要。`),
    );
  }

  if (aspect > 2.2 || aspect < 0.45) {
    score -= 22;
    findings.push(
      finding(
        'warn',
        'ASPECT_EXTREME',
        `画幅过长（${aspect.toFixed(2)}:1）`,
        'TRELLIS.2 按方形画幅重建，过长的图会让细长部分被压扁或截断。',
        '重新生成时把画幅设为 1:1，或在选图前裁掉多余留白。',
      ),
    );
  } else if (aspect > 1.7 || aspect < 0.6) {
    score -= 8;
    findings.push(
      finding('warn', 'ASPECT_OFF', `画幅非方形（${aspect.toFixed(2)}:1）`, '主体可能被居中裁切。', '尽量使用 1:1 出图。'));
  } else {
    findings.push(finding('ok', 'ASPECT_OK', '画幅接近方形', `${aspect.toFixed(2)}:1，符合单图重建的理想输入。`));
  }

  if (bytesPerPixel < 0.1) {
    score -= 10;
    findings.push(
      finding(
        'warn',
        'COMPRESSION',
        '压缩痕迹偏重',
        `平均每像素仅 ${bytesPerPixel.toFixed(2)} 字节，JPEG 块效应会被当成表面细节放大。`,
        '导出 PNG，或把 JPEG 质量提到 90 以上再试。',
      ),
    );
  }

  if (hasAlpha) {
    findings.push(
      finding(
        'info',
        'ALPHA',
        '含透明通道',
        'BiRefNet 会重新抠图，透明背景不会直接变成模型的一部分。',
        '如果主体边缘有半透明阴影，先在导出时铺一层纯白底，抠图会更干净。',
      ),
    );
  }

  if (bytes > 12 * 1024 ** 2) {
    findings.push(
      finding('info', 'BIG_FILE', `文件较大（${(bytes / 1024 ** 2).toFixed(1)} MB）`, '导入会多花一点时间，不影响结果。'),
    );
  }

  if (maxSide < p.px) {
    findings.push(
      finding(
        'info',
        'NO_UPSCALE_DETAIL',
        `会被放大到 ${p.px} px`,
        '上采样只增加像素，不增加真实细节，细纹理仍取决于原图。',
      ),
    );
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const level = findings.some((f) => f.level === 'risk') ? 'risk' : findings.some((f) => f.level === 'warn') ? 'warn' : 'ok';
  const summary = level === 'risk'
    ? '这张图很可能转不出可用的网格，建议换一张。'
    : level === 'warn'
      ? '可以继续，但按下面的建议调整效果会明显更好。'
      : '这张图适合直接转网格。';

  return {
    ok: true,
    path,
    name: path.split(/[\\/]/).pop(),
    bytes,
    format,
    width,
    height,
    minSide,
    maxSide,
    aspect: Math.round(aspect * 1000) / 1000,
    megapixels: Math.round(megapixels * 100) / 100,
    hasAlpha,
    bytesPerPixel: Math.round(bytesPerPixel * 1000) / 1000,
    preset: p.key,
    presetResolution: p.resolution,
    score,
    level,
    summary,
    findings,
  };
}

/* ------------------------------------------------------------------ *
 * 2. 提示词构建
 * ------------------------------------------------------------------ */

/**
 * 每条规则对应一种「模型一定做不好」的描述。命中后不是拦截，而是解释原因
 * 并把对应的规避词并进提示词——用户仍然可以照原样提交。
 */
const PROMPT_RULES = [
  {
    code: 'MULTI_SUBJECT',
    level: 'warn',
    tag: '多主体',
    test: /多个|两个|三个|一群|一组|一排|场景|multiple|several|group of|crowd|scene/i,
    message: '这条工作流只重建一个紧凑主体：多主体会被压成一个整体，或只保留最大的那个。想同时打印多个，建议分开生成。',
    avoid: 'multiple subjects',
  },
  {
    code: 'TEXT_IN_IMAGE',
    level: 'warn',
    tag: '文字/水印',
    test: /文字|标语|字幕|水印|logo|签名|text|watermark|lettering|caption/i,
    message: '文字在网格里会变成模糊的凸起，几乎不可能读出来，已加入规避项。',
    avoid: 'text',
  },
  {
    code: 'NON_PRINTABLE_MATERIAL',
    level: 'warn',
    tag: '透明/发光',
    test: /透明|玻璃|水晶|发光|光效|粒子|烟雾|火焰|玻璃质感|glass|glow|particle|smoke|translucent/i,
    message: '透明与发光在实体打印里没有对应表达，模型通常会把它们填成实心块。',
    avoid: 'transparent, glowing',
  },
  {
    code: 'THIN_FEATURE',
    level: 'warn',
    tag: '细长结构',
    test: /链条|细丝|飘带|头发丝|胡须|蛛丝|薄膜|thin|wire|chain|hair|membrane/i,
    message: '细于 0.4 mm 的结构在树脂打印中容易断，建议加粗或直接去掉。',
    avoid: '',
  },
  {
    code: 'BUSY_BACKGROUND',
    level: 'info',
    tag: '复杂背景',
    test: /背景|场景|环境|街道|森林|background|landscape/i,
    message: '背景会被 BiRefNet 抠掉，但越复杂越容易抠错主体边缘。',
    avoid: 'busy background',
  },
];

const SCAFFOLD_ZH = '单一紧凑主体，居中构图，正面视角，干净的纯色背景，轮廓清晰，细节实心可打印，带一体化底座';
const SCAFFOLD_EN = 'single compact subject, centered, front view, clean solid background, crisp silhouette, solid printable geometry, integrated base';

const BASE_AVOID_ZH = ['多个主体', '文字', '水印', '复杂背景', '半透明材质', '悬空碎片'];
const BASE_AVOID_EN = ['multiple subjects', 'text', 'watermark', 'busy background', 'translucent material', 'floating fragments'];

/** 把「no text, no watermark」这类否定短语摘出去，避免规则自己误伤自己。 */
function stripNegations(text) {
  return text
    .replace(/\b(no|without|not|avoid|free of)\s+[a-z][a-z\s-]*/gi, ' ')
    .replace(/(不要|无需|不含|没有|不出现|无)[^,，。;；、]*/g, ' ');
}

/**
 * 「clean background」「纯色背景」是这张工作流最想要的输入，却会被「背景」
 * 规则误判成「复杂背景」。先把明确的干净背景短语摘掉，再跑规则。
 */
function stripSafePhrases(text) {
  return text.replace(
    /\b(?:neutral|clean|solid(?:\s+color)?|simple|plain|white|transparent)\s+background\b|(?:纯色|干净|简单|白色|透明|单色)背景/gi,
    ' ',
  );
}

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** 中英文逗号、顿号、分号统一成 ", "，再去掉重复短语。 */
function splitPhrases(text) {
  return text
    .replace(/[，、；;]+/g, ',')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function dedupeCaseInsensitive(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = item.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * 构建最终提示词。
 *
 * 注意：Qwen-Image 2.1 的工作流里 CFG=1，负向提示词在这种设置下不生效，
 * 所以这里**不提供**一个看起来能用、实际被忽略的「负向提示词」输入框。
 * 规避项会以自然语言并入正向提示词（`no text, no watermark`），这也是
 * 该工作流模板自带示例的写法。
 */
export function buildPrompt({
  subject = '',
  style = '',
  avoid = '',
  preset = '2k',
  material = 'resin',
  scaffold = true,
} = {}) {
  // 主体不做过早截断：真正的上限由下方 positive.length 判定（PROMPT_TOO_LONG），
  // 否则用户粘进来一段超长描述会被静默截短，而且永远触发不了长度提示。
  const cleanSubject = cleanText(subject, LIMITS.promptChars * 2);
  const cleanStyle = cleanText(style, LIMITS.promptChars * 2);
  const cleanAvoid = cleanText(avoid, LIMITS.avoidChars);

  if (!cleanSubject) {
    throw new AppError(ERROR_CODES.PROMPT_EMPTY, '主体描述是空的', {
      hint: '至少写一句主体，例如「盘踞在圆形底座上的东方龙」。',
    });
  }

  const p = presetInfo(preset);
  const everything = [cleanSubject, cleanStyle, cleanAvoid].filter(Boolean).join(', ');
  const language = /[\u4e00-\u9fff]/.test(everything) ? 'zh' : 'en';
  const probe = stripNegations(stripSafePhrases(everything));

  const warnings = [];
  const tags = [];
  const autoAvoid = [];
  for (const rule of PROMPT_RULES) {
    if (!rule.test.test(probe)) continue;
    tags.push(rule.tag);
    warnings.push({ code: rule.code, level: rule.level, tag: rule.tag, message: rule.message });
    if (rule.avoid) autoAvoid.push(...rule.avoid.split(',').map((s) => s.trim()));
  }

  const userAvoid = splitPhrases(cleanAvoid);
  const baseAvoid = language === 'zh' ? BASE_AVOID_ZH : BASE_AVOID_EN;
  const avoidList = dedupeCaseInsensitive([...userAvoid, ...autoAvoid, ...baseAvoid].filter(Boolean));

  const positiveParts = [...splitPhrases(cleanSubject), ...splitPhrases(cleanStyle)];
  const uniqueParts = dedupeCaseInsensitive(positiveParts);
  if (scaffold) uniqueParts.push(language === 'zh' ? SCAFFOLD_ZH : SCAFFOLD_EN);

  const avoidClause = avoidList.length
    ? language === 'zh'
      ? `不要出现：${avoidList.join('、')}`
      : `no ${avoidList.join(', ')}`
    : '';
  if (avoidClause) uniqueParts.push(avoidClause);

  const positive = dedupeCaseInsensitive(uniqueParts).join(', ');
  if (positive.length > LIMITS.promptChars) {
    throw new AppError(
      ERROR_CODES.PROMPT_TOO_LONG,
      `提示词过长（${positive.length} 字符），上限 ${LIMITS.promptChars} 字符`,
      { hint: '删掉重复的风格形容词；模型对超过 4000 字符的部分会直接截断。' },
    );
  }

  return {
    ok: true,
    positive,
    subject: cleanSubject,
    style: cleanStyle,
    avoid: avoidList,
    avoidClause,
    language,
    preset: p.key,
    presetLabel: p.label,
    material,
    scaffoldApplied: scaffold,
    chars: positive.length,
    tags,
    warnings,
    engineNote: '该工作流 CFG=1，负向提示词不生效；规避项已并入正向提示词。',
  };
}

/* ------------------------------------------------------------------ *
 * 3. 可选视觉模型（看图写提示词）
 * ------------------------------------------------------------------ */

export { DEFAULT_VLM_URL };

function vlmBase(config = {}) {
  const raw = String(config.vlmUrl || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  return /\/v\d+$/.test(raw) ? raw : `${raw}/v1`;
}

function vlmHeaders(config = {}, { json = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (json) headers['Content-Type'] = 'application/json';
  const key = String(config.vlmApiKey || '').trim();
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

function classifyNetError(err) {
  const text = String(err?.message || err || '');
  if (/abort|timeout|超时/i.test(text)) return { code: ERROR_CODES.VLM_OFFLINE, message: '视觉模型响应超时' };
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|EAI_AGAIN/i.test(text)) {
    return { code: ERROR_CODES.VLM_OFFLINE, message: '连接不到视觉模型服务' };
  }
  return { code: ERROR_CODES.VLM_OFFLINE, message: `视觉模型请求失败：${text}` };
}

/**
 * 探测视觉模型能力。1.8 秒内没有响应就当作「没装」——这是可选项，
 * 不应该让页面首屏为它等待。
 */
export async function vlmStatus(config = {}, { timeoutMs = 1800 } = {}) {
  const endpoint = vlmBase(config);
  const startedAt = Date.now();
  if (!endpoint) {
    // 空地址 = 用户明确关闭。返回 disabled 而不是「连接失败」，页面据此
    // 显示「未配置」并隐藏看图写提示词按钮，不把它当成故障。
    return {
      available: false,
      disabled: true,
      endpoint: '',
      models: [],
      model: '',
      ms: 0,
      error: '未配置视觉模型地址',
      code: '',
    };
  }
  try {
    const res = await fetch(`${endpoint}/models`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: vlmHeaders(config),
    });
    if (!res.ok) {
      return {
        available: false,
        endpoint,
        models: [],
        model: '',
        ms: Date.now() - startedAt,
        error: `服务返回 HTTP ${res.status}`,
        code: ERROR_CODES.VLM_OFFLINE,
      };
    }
    const data = await res.json().catch(() => ({}));
    const models = (data.data || data.models || [])
      .map((item) => (typeof item === 'string' ? item : item?.id || item?.name || ''))
      .filter(Boolean);
    const preferred = String(config.vlmModel || '').trim();
    const vision = models.find((m) => /vl|vision|llava|moondream|minicpm|gemma3|qwen2\.5vl|pixtral|internvl/i.test(m));
    // 用户显式填写的模型优先，即使服务端没有在 /models 里列出它；有些
    // 推理服务会隐藏模型列表，强制回退会让「明明能用」变成「没有模型」。
    const model = preferred || vision || models[0] || '';
    return {
      available: true,
      endpoint,
      models: models.slice(0, 40),
      model,
      visionLikely: Boolean(vision || preferred || /vl|vision|llava|minicpm|pixtral|internvl/i.test(model)),
      ms: Date.now() - startedAt,
      error: '',
      auth: Boolean(config.vlmApiKey),
    };
  } catch (err) {
    const net = classifyNetError(err);
    return {
      available: false,
      endpoint,
      models: [],
      model: '',
      ms: Date.now() - startedAt,
      error: net.message,
      code: net.code,
    };
  }
}

const CAPTION_SYSTEM = [
  '你是 3D 打印模型的提示词工程师。用户会给你一张图，你要把它改写成适合「单图转 3D 网格」的文生图提示词。',
  '要求：只描述画面里真实存在的一个主体；不要编造背景故事；不要提文字或水印；使用简体中文。',
  '严格按三行输出，不要多余内容：',
  '主体：<一句话，包含主体形态、姿态、底座>',
  '风格：<材质、表面细节、光照，逗号分隔>',
  '细节：<3–5 个可打印特征，逗号分隔>',
].join('\n');

/** 从视觉模型的自由文本里抽出三段结构；先尝试 JSON，再按行解析，抽不到就把原文当主体。 */
export function parseCaption(text) {
  const raw = String(text || '').trim();
  // 不少 VL 模型即使要求「三行」也会输出 ```json {...}```。先给它们一次机会。
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (unfenced.startsWith('{')) {
    try {
      const data = JSON.parse(unfenced);
      const subject = String(data.subject || data.主体 || data.object || '').trim();
      const style = String(data.style || data.风格 || '').trim();
      const detailRaw = data.detail ?? data.details ?? data.细节 ?? '';
      const detail = Array.isArray(detailRaw) ? detailRaw.join('，') : String(detailRaw).trim();
      if (subject) return { subject: subject.slice(0, 300), style: style.slice(0, 300), detail: detail.slice(0, 400), structured: true };
    } catch {
      // 不是合法 JSON：继续走三行解析。
    }
  }
  const pick = (label) => {
    const m = new RegExp(`${label}\\s*[:：]\\s*(.+)`).exec(raw);
    return m ? m[1].trim().replace(/[。.;；]$/, '') : '';
  };
  const subject = pick('主体') || pick('subject');
  const style = pick('风格') || pick('style');
  const detail = pick('细节') || pick('detail');
  if (!subject) {
    const firstLine = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] || '';
    return { subject: firstLine.slice(0, 300), style: style.slice(0, 300), detail: detail.slice(0, 400), structured: false };
  }
  return { subject: subject.slice(0, 300), style: style.slice(0, 300), detail: detail.slice(0, 400), structured: true };
}

export async function vlmCaption({ path, config = {}, timeoutMs = LIMITS.vlmTimeoutMs, prompt = '' } = {}) {
  if (!path || !existsSync(path)) {
    throw new AppError(ERROR_CODES.IMAGE_MISSING, `图片不存在：${path || '(空)'}`, { hint: '重新导入图片后再试。' });
  }
  const info = await stat(path);
  if (info.size > LIMITS.vlmImage) {
    throw new AppError(
      ERROR_CODES.VLM_TOO_LARGE,
      `图片 ${(info.size / 1024 ** 2).toFixed(1)} MB，超过视觉模型接口上限 ${(LIMITS.vlmImage / 1024 ** 2).toFixed(0)} MB`,
      { hint: '先裁剪或缩放到 2048 px 以内再识别。' },
    );
  }
  const endpoint = vlmBase(config);
  if (!endpoint) {
    throw new AppError(ERROR_CODES.VLM_OFFLINE, '没有配置视觉模型地址', {
      hint: `在设置里填写 OpenAI 兼容地址，例如 ${DEFAULT_VLM_URL}；留空表示关闭这项可选功能。`,
    });
  }
  const status = await vlmStatus(config, { timeoutMs: 2500 });
  if (!status.available) {
    throw new AppError(status.code || ERROR_CODES.VLM_OFFLINE, `视觉模型不可用：${status.error || '未知原因'}`, {
      hint: `确认 ${endpoint} 可以访问（Ollama 需先运行 ollama serve 并已 pull 视觉模型），或在设置里改成本机实际的地址。`,
    });
  }
  const model = status.model;
  if (!model) {
    throw new AppError(ERROR_CODES.VLM_NO_MODEL, '视觉模型服务里没有任何可用模型', {
      hint: '例如执行：ollama pull qwen2.5vl:7b',
    });
  }

  const ext = extname(path).toLowerCase();
  const mime = MIME_BY_EXT[ext] || 'image/png';
  const base64 = (await readFile(path)).toString('base64');
  const startedAt = Date.now();
  let res;
  try {
    res = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: vlmHeaders(config, { json: true }),
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model,
        stream: false,
        temperature: 0.2,
        max_tokens: 320,
        messages: [
          { role: 'system', content: CAPTION_SYSTEM },
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt || '请按格式描述这张图，目标是转成可 3D 打印的单体模型。' },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
            ],
          },
        ],
      }),
    });
  } catch (err) {
    const net = classifyNetError(err);
    throw new AppError(net.code, net.message, { hint: '检查视觉模型进程是否还在运行，或把超时调大。' });
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new AppError(
      ERROR_CODES.VLM_BAD_RESPONSE,
      `视觉模型返回 HTTP ${res.status}${body ? `：${body.slice(0, 200)}` : ''}`,
      { hint: `确认 ${model} 是视觉模型（VL / LLaVA 类）。纯文本模型无法读图。` },
    );
  }

  const data = await res.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => part?.text || '').join('')
      : '';
  if (!text.trim()) {
    throw new AppError(ERROR_CODES.VLM_BAD_RESPONSE, '视觉模型没有返回任何文字', {
      hint: '换一个视觉模型试试，或检查该模型是否需要额外的 --mmproj 参数。',
    });
  }
  const parsed = parseCaption(text);
  return {
    ok: true,
    model,
    endpoint,
    ms: Date.now() - startedAt,
    raw: text.trim().slice(0, 1200),
    ...parsed,
  };
}

/* ------------------------------------------------------------------ *
 * 4. 候选图池
 * ------------------------------------------------------------------ */

/**
 * 最近导入的输入图片，用于刷新页面后重建候选池。只读目录，不做解码，
 * 所以即使 input 目录堆积了几百张图也不会拖慢首屏。
 */
export async function listInputPool(workspaceDir, { limit = LIMITS.poolSize } = {}) {
  const dir = join(workspaceDir, 'input');
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    return { dir, items: [] };
  }
  const items = [];
  for (const name of names) {
    if (!IMAGE_EXT.test(name) || name.startsWith('.')) continue;
    const full = join(dir, name);
    try {
      const info = await stat(full);
      if (!info.isFile() || info.size === 0) continue;
      items.push({ path: full, name, size: info.size, mtime: info.mtimeMs });
    } catch {}
  }
  items.sort((a, b) => b.mtime - a.mtime);
  return { dir, items: items.slice(0, Math.max(1, Math.min(24, Number(limit) || LIMITS.poolSize))) };
}
