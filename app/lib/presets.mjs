/**
 * 显存档位与各种容量上限的唯一来源。
 *
 * 之前这些数字分散在四处：`config.mjs` 的 PRESETS 集合、`workflows.mjs`
 * 的 PRESETS 对象、`server.mjs` 的 PRESET_KEYS、以及前端 app.js 里的
 * PRESET_HINTS。改一个数字要动四个文件，任何一处漏改都会让页面显示
 * 的代理点数与真正写进工作流的值不一致。现在只在这里定义，其余模块
 * 全部引用，并通过 `/api/state` 把同一份数据下发给页面。
 */

export const PRESET_KEYS = ['1k', '1.5k', '2k'];

/**
 * 本机 Ollama 的 OpenAI 兼容端点。这里是「默认值」而不是「隐式回退」：
 * 配置为空字符串表示用户明确关闭视觉模型，不会再偷偷去探测本机端口。
 */
export const DEFAULT_VLM_URL = 'http://127.0.0.1:11434/v1';

/**
 * resolution: 传给 TRELLIS.2 / WTiVo 的像素分辨率
 * proxy:      WTiVo 稀疏体素代理点数量
 * mp:         Qwen 文生图使用的百万像素
 * vram:       面向用户的显存建议（只用于提示，不参与校验）
 * minSourcePx: 输入图片短边低于此值时给出「可能不够清晰」的提醒
 */
export const PRESETS = {
  '1k': {
    key: '1k',
    resolution: 1024,
    proxy: 8_000_000,
    mp: 1,
    px: 1024,
    label: '1K · 低显存',
    vram: '6–8 GB',
    minSourcePx: 640,
    detail: '最快，适合轮廓简单的单体模型',
  },
  '1.5k': {
    key: '1.5k',
    resolution: 1536,
    proxy: 12_000_000,
    mp: 2.25,
    px: 1536,
    label: '1.5K · 推荐',
    vram: '8–16 GB',
    minSourcePx: 900,
    detail: '速度与细节最平衡，视频作者的默认选择',
  },
  '2k': {
    key: '2k',
    resolution: 2048,
    proxy: 25_000_000,
    mp: 4,
    px: 2048,
    label: '2K · 高细节',
    vram: '16 GB+ / 32 GB 内存',
    minSourcePx: 1200,
    detail: '最细，但跳过 Quad Reconstruct，网格可达 4300 万面',
  },
};

export function presetInfo(key) {
  return PRESETS[key] || PRESETS['1.5k'];
}

export function isPresetKey(value) {
  return typeof value === 'string' && Object.hasOwn(PRESETS, value);
}

/** 与 server.mjs 原先的 assertPreset 行为一致：未知档位直接报错，不静默回退。 */
export function assertPreset(value, fallback = '1.5k') {
  if (value === undefined || value === null || value === '') return fallback;
  const preset = String(value).toLowerCase();
  if (!isPresetKey(preset)) {
    throw new Error(`显存档位只能是 ${PRESET_KEYS.join(' / ')}，收到：${String(value)}`);
  }
  return preset;
}

const MB = 1024 ** 2;

/** 上传与解析的硬上限。前端通过 /api/state 读取同一份数据做预校验。 */
export const LIMITS = {
  /** 输入图片单文件上限 */
  uploadImage: 40 * MB,
  /** GLB 单文件上限（分块上传，允许大模型） */
  uploadGlb: 4 * 1024 * MB,
  /** 文本 / Markdown 提示词文件上限 */
  uploadText: 512 * 1024,
  /** 一次最多保留几张候选图 */
  poolSize: 8,
  /** 提示词正文字符上限（Qwen 侧为 4000） */
  promptChars: 4000,
  /** 规避项字符上限（会被并入正向提示词） */
  avoidChars: 600,
  /** 送给视觉模型的图片上限，超过时提示先压缩 */
  vlmImage: 6 * MB,
  /** 单次视觉模型请求超时 */
  vlmTimeoutMs: 90_000,
};

export function presetsPublic() {
  const out = {};
  for (const key of PRESET_KEYS) {
    const p = PRESETS[key];
    out[key] = {
      key,
      resolution: p.resolution,
      proxy: p.proxy,
      mp: p.mp,
      px: p.px,
      label: p.label,
      vram: p.vram,
      minSourcePx: p.minSourcePx,
      detail: p.detail,
    };
  }
  return out;
}
