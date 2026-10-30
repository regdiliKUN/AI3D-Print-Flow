/**
 * AI3D Print Flow · 页面逻辑
 *
 * 单文件、无构建、无静态 import：`scripts/test-image-flow.mjs` 会用 vm 直接
 * 执行这个文件来跑真实的上传 / 工作流交互，任何顶层 import 都会让它失效。
 * 因此新增能力（图片分析、提示词工作台、错误映射）都写在这里，用清晰的分节
 * 保持可读性，而不是拆成需要打包的模块。
 *
 * 分节：
 *   01 基础工具   02 状态   03 网络与错误   04 渲染
 *   05 引导（下一步）  06 任务   07 多模态（图片 / 视觉模型）
 *   08 提示词工作台   09 动作与事件   10 启动
 */

/* ------------------------------------------------------------------ *
 * 01 基础工具
 * ------------------------------------------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function basename(p) {
  if (!p) return '';
  return String(p).split(/[\\/]/).pop() || p;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setCallout(id, text, kind = '') {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = `callout ${kind}`.trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatStamp(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m} 分 ${rest} 秒` : `${m} 分`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  // Fallback for browsers/automation contexts that deny the async clipboard
  // permission. This still requires a user click, which every caller has.
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.left = '-9999px';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {}
  area.remove();
  return ok;
}

function downloadText(text, filename) {
  try {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return true;
  } catch {
    return false;
  }
}

/**
 * 轻提示。第三个参数兼容原来的数字写法（超时毫秒），也支持对象写法：
 * `{ timeout, action: { label, onClick }, hint }`。
 * - 同样的消息在 1.2 秒内只出现一次，避免轮询失败时刷屏。
 * - 同时最多保留 4 条，超出的从最旧的开始移除。
 */
const toastSeen = new Map();

function toast(message, kind = 'info', options = 4200) {
  const wrap = $('#toastWrap');
  if (!wrap) return null;
  const opts = typeof options === 'number' ? { timeout: options } : (options || {});
  const timeout = opts.timeout ?? 4200;
  const key = `${kind}:${message}`;
  const now = Date.now();
  if (toastSeen.has(key) && now - toastSeen.get(key) < 1200) return null;
  toastSeen.set(key, now);

  // 测试用的极简 DOM 没有 children 集合，这里保持防御式写法。
  const existing = wrap.children ? [...wrap.children] : [];
  if (existing.length >= 4) existing[0].remove();

  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.setAttribute('role', kind === 'error' ? 'alert' : 'status');

  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = message;
  node.append(text);

  if (opts.hint) {
    const hint = document.createElement('small');
    hint.className = 'toast-hint';
    hint.textContent = opts.hint;
    node.append(hint);
  }
  if (opts.action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = opts.action.label;
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      remove();
      try {
        opts.action.onClick?.();
      } catch {}
    });
    node.append(btn);
  }

  wrap.append(node);
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 200);
  };
  if (timeout > 0) setTimeout(remove, timeout);
  node.addEventListener('click', remove);
  return node;
}

/* ------------------------------------------------------------------ *
 * 02 状态
 * ------------------------------------------------------------------ */

const state = {
  config: {},
  checks: null,
  presets: null,
  limits: null,
  vlm: null,
  selectedImage: '',
  selectedGlb: '',
  imageUploading: false,
  uploadQueue: 0,
  meshPreparing: false,
  preparedMesh: null,
  meshPreset: '1.5k',
  lastResult: null,
  jobId: null,
  jobTimer: null,
  jobTick: null,
  jobLogOpen: false,
  oneClickJobId: null,
  oneClickJob: null,
  oneClickLogOpen: false,
  deployMode: 'oneclick',
  doctor: null,
  reuse: null,
  rechecking: false,
  lastError: '',
  // 多模态
  pool: [],
  analysis: null,
  inspectedPath: '',
  inspectedPreset: '',
  pixelStats: null,
  // 提示词
  promptBuilt: null,
  promptSignature: '',
  userPresetTouched: false,
  // 任务重试
  lastJobAction: null,
  jobError: null,
  // 引导
  nextStepHidden: false,
  nextStage: 'env',
};

// 服务端 /api/state 会下发同一份档位表；这里的兜底值只在首屏渲染前使用。
const PRESET_FALLBACK = {
  '1k': { proxy: 8_000_000, resolution: 1024, label: '1K · 低显存', vram: '6–8 GB', minSourcePx: 640 },
  '1.5k': { proxy: 12_000_000, resolution: 1536, label: '1.5K · 推荐', vram: '8–16 GB', minSourcePx: 900 },
  '2k': { proxy: 25_000_000, resolution: 2048, label: '2K · 高细节', vram: '16 GB+ / 32 GB 内存', minSourcePx: 1200 },
};

const CHECK_MAP = {
  gpu: ['gpu'],
  comfy: ['comfy'],
  trellis: ['trellis.node', 'comfy.torch'],
  blender: ['blender'],
  chitubox: ['chitubox'],
};

const PROMPT_TEMPLATES = {
  statue: {
    label: '微缩雕像',
    subject: '一位身披长袍的东方修行者，双手合十，立于圆形石质基座',
    style: 'miniature statue, flowing robe folds, serene expression, compact single figure, integrated circular base, clean silhouette, neutral grey background, no text, no watermark, designed for 3D printing',
  },
  creature: {
    label: '生物 / 怪物',
    subject: '一只蹲伏的幼年石像鬼，双翼半展，尾巴盘绕在脚边',
    style: 'tabletop monster miniature, chunky anatomy, layered scales, dynamic crouch, single subject, integrated rock base, crisp silhouette, neutral background, no text, no watermark, printable solid geometry',
  },
  mech: {
    label: '机械 / 机甲',
    subject: '一台四足侦察机甲，正视前方，炮塔位于背部中央',
    style: 'tabletop mech miniature, hard surface panels, visible joints, symmetrical stance, single subject, hexagonal base, clean silhouette, neutral background, no text, no watermark, printable solid geometry',
  },
  prop: {
    label: '道具 / 摆件',
    subject: '一盏缠绕藤蔓的青铜古董提灯，玻璃罩内有一簇小火焰的轮廓',
    style: 'decorative prop miniature, aged bronze surface, thick vine details, single object, integrated flat base, clean silhouette, neutral background, no text, no watermark, printable solid geometry',
  },
  terrain: {
    label: '建筑 / 场景件',
    subject: '一座带拱门与石阶的小型废墟哨塔，墙体有爬藤',
    style: 'tabletop terrain piece, chipped stone walls, layered masonry, single compact building, integrated square base, clean silhouette, neutral background, no text, no watermark, printable solid geometry',
  },
};

/* ------------------------------------------------------------------ *
 * 03 网络与错误
 * ------------------------------------------------------------------ */

/** 错误码 → 用户能看懂的一句话。没有命中时退回通用文案。 */
const ERROR_UI = {
  E_BUSY: { title: '有任务正在运行', hint: '等它结束，或先在任务栏点「取消」。' },
  E_DISK_FULL: { title: '磁盘空间不足', hint: '清理安装盘，或到设置里换一个更大的目录。' },
  E_TOO_LARGE: { title: '文件超过大小上限', hint: '压缩或裁剪后再上传。' },
  E_IMAGE_INVALID: { title: '这张图无法解析', hint: '用画图 / Photoshop 重新导出为标准 PNG。' },
  E_IMAGE_TOO_SMALL: { title: '图片分辨率太低', hint: '换一张短边 1024 px 以上的图。' },
  E_IMAGE_TOO_LARGE: { title: '图片过大', hint: '先裁剪或缩放到 2048 px 以内再导入。' },
  E_IMAGE_MISSING: { title: '找不到这张图', hint: '文件可能被移动或删除，重新导入一次。' },
  E_PROMPT_EMPTY: { title: '还没有写主体描述', hint: '至少写一句主体，例如「盘踞在圆底座上的东方龙」。' },
  E_PROMPT_TOO_LONG: { title: '提示词太长', hint: '删掉重复的风格形容词，保留最关键的 3–5 个。' },
  E_PATH_OUTSIDE: { title: '路径不在工作目录内', hint: '请在页面上重新导入文件。' },
  E_GLB_INVALID: { title: 'GLB 文件不完整', hint: '等 ComfyUI 完全保存后再点「导入最新 GLB」。' },
  E_VLM_OFFLINE: { title: '视觉模型连不上', hint: '确认 Ollama / LM Studio 正在运行，或在设置里改地址。' },
  E_VLM_NO_MODEL: { title: '视觉模型服务里没有模型', hint: '例如先执行：ollama pull qwen2.5vl:7b' },
  E_VLM_TOO_LARGE: { title: '图片对视觉模型来说太大', hint: '先缩到 2048 px 以内再识别。' },
  E_VLM_BAD_RESPONSE: { title: '视觉模型没有返回可用内容', hint: '换一个 VL 模型，或确认它不是纯文本模型。' },
  E_INTERNAL: { title: '本地服务出错了', hint: '详情已写入 logs/server.log，可点「复制诊断信息」发给维护者。' },
  E_FORBIDDEN: { title: '操作被拒绝', hint: '只允许从本机页面操作这个服务。' },
  E_NOT_FOUND: { title: '文件或任务不存在', hint: '可能已被移动或清理，刷新后再试。' },
  E_UNKNOWN_ACTION: { title: '页面与服务版本不一致', hint: '刷新页面；如果刚更新过程序，请重启启动窗口。' },
};

/**
 * 把任意异常整理成「标题 / 细节 / 建议」。页面所有错误展示都走这里，
 * 保证同一类失败在任何位置措辞一致。
 */
function humanizeError(err) {
  const code = err?.code || '';
  const known = ERROR_UI[code];
  const raw = String(err?.message || err || '未知错误');
  if (err?.network) {
    return {
      title: '连不上本地服务',
      detail: raw,
      hint: '确认启动窗口还在运行；如果已关闭，重新双击启动程序后刷新页面。',
      code: 'NETWORK',
    };
  }
  if (known) {
    // 服务端消息通常比通用提示更具体，两者拼接，但去掉重复。
    const detail = raw && !raw.includes(known.title) ? raw : '';
    return { title: known.title, detail, hint: known.hint, code };
  }
  if (err?.status === 409) return { title: '有任务正在运行', detail: raw, hint: ERROR_UI.E_BUSY.hint, code: 'E_BUSY' };
  return { title: '操作没有完成', detail: raw, hint: '', code: code || 'UNKNOWN' };
}

function errorToText(err) {
  const info = humanizeError(err);
  return [info.title, info.detail, info.hint ? `建议：${info.hint}` : '']
    .filter(Boolean)
    .join('\n');
}

/**
 * 页面端未捕获异常上报。写进 server.log 之后，用户点「复制诊断信息」就能
 * 带上前端现场，不用再复现一次。
 */
function reportClientError(where, err) {
  try {
    const payload = JSON.stringify({
      where,
      message: String(err?.message || err || '').slice(0, 500),
      stack: String(err?.stack || '').slice(0, 4000),
      url: typeof location !== 'undefined' ? String(location.href) : '',
      at: new Date().toISOString(),
    });
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    if (nav && typeof nav.sendBeacon === 'function' && typeof Blob !== 'undefined') {
      nav.sendBeacon('/api/client-log', new Blob([payload], { type: 'application/json' }));
      return;
    }
    fetch('/api/client-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(() => {});
  } catch {}
}

function setConnection(ok, message = '') {
  const banner = $('#connectionBanner');
  if (!banner) return;
  banner.hidden = ok;
  if (!ok) {
    state.lastError = message || '无法连接本地服务。请确认启动窗口还在运行。';
    setText('connectionText', state.lastError);
  }
}

async function copyDiagnostics() {
  let diagnostics = null;
  let requestError = '';
  try {
    diagnostics = await fetchJson('/api/diagnostics', {}, { timeout: 6000, retries: 0, label: '读取诊断信息' });
  } catch (err) {
    requestError = err.message;
  }
  const header = [
    'AI3D Print Flow 诊断信息',
    `时间: ${new Date().toISOString()}`,
    `页面: ${window.location.href}`,
    `浏览器在线: ${navigator.onLine ? '是' : '否'}`,
    `浏览器: ${navigator.userAgent}`,
    `最近错误: ${state.lastError || requestError || '（无）'}`,
  ];
  const body = diagnostics
    ? JSON.stringify(diagnostics, null, 2)
    : `无法读取 /api/diagnostics：${requestError || '未知错误'}\n\n请复制本段，并附上启动窗口和 logs/server.log 的最后 50 行。`;
  try {
    const full = `${header.join('\n')}\n\n${body}`;
    const copied = await copyText(full);
    if (copied) toast('诊断信息已复制，可直接粘贴到排错记录中', 'ok', 6000);
    else if (downloadText(full, `ai3d-diagnostics-${Date.now()}.txt`)) {
      toast('剪贴板不可用，已下载诊断信息文件', 'warn', 8000);
    } else {
      toast('无法写入剪贴板或下载诊断文件，请打开 logs/server.log 手动复制', 'warn', 9000);
    }
  } catch {
    toast('浏览器拒绝了剪贴板权限，请打开 logs/server.log 手动复制', 'warn', 8000);
  }
}

async function fetchJson(url, options = {}, { timeout = 15000, retries = 0, retryDelay = 700, label = '请求' } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, { cache: 'no-store', ...options, signal: controller.signal });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        const gateway = [502, 503, 504].includes(res.status) && !data.error;
        const message = data.error || `${label}失败（HTTP ${res.status}）`;
        const err = new Error(data.hint ? `${message} ${data.hint}` : message);
        err.fromServer = !gateway;
        err.gateway = gateway;
        err.status = res.status;
        // Stable API code (E_BUSY / E_DISK_FULL / ...) so callers can branch on
        // the cause instead of matching message text.
        err.code = data.code || '';
        err.hint = data.hint || '';
        throw err;
      }
      setConnection(true);
      return data;
    } catch (err) {
      lastError = err;
      if (err.fromServer) break;
      const network =
        err.gateway ||
        err.name === 'AbortError' ||
        err instanceof TypeError ||
        /fetch|network|aborted|failed|load/i.test(String(err.message || ''));
      if (!network) break;
      if (attempt < retries) {
        setConnection(false, `${label}连接中断，正在自动重试（${attempt + 1}/${retries}）…`);
        await sleep(retryDelay * (attempt + 1));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  if (lastError?.fromServer) throw lastError;
  const timedOut = lastError?.name === 'AbortError';
  const err = new Error(
    timedOut
      ? `${label}超时。本地服务可能正忙；如果启动窗口已经关闭，请重新双击「启动 AI3D 打印工作流.cmd」后刷新页面。`
      : `无法连接本地服务（Failed to fetch）。请确认启动窗口仍在运行；如果它已关闭，双击「启动 AI3D 打印工作流.cmd」后刷新页面。`,
  );
  err.network = true;
  setConnection(false, err.message);
  throw err;
}

/** 每个动作自己的合理等待时间：文件对话框显然要比读状态等得久。 */
const ACTION_TIMEOUTS = {
  'file.pick': 180000,
  'shortcut.create': 120000,
  'install.workflows': 90000,
  'workflow.preparePixel': 90000,
  'workflow.prepareQwen': 90000,
  'stl.verify': 120000,
  'comfy.latestGlb': 120000,
  'deploy.doctor': 180000,
  'models.scan': 120000,
  'image.inspect': 30000,
  'image.pool': 30000,
  'image.forget': 30000,
  'prompt.build': 30000,
  'vlm.status': 20000,
  'vlm.caption': 120000,
};

async function api(action, payload = {}) {
  return fetchJson(
    '/api/action',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, payload }),
    },
    { timeout: ACTION_TIMEOUTS[action] || 45000, retries: 0, label: '启动任务' },
  );
}

async function apiGet(url, options = {}) {
  return fetchJson(url, {}, { timeout: 20000, retries: 2, label: '读取数据', ...options });
}

/* ------------------------------------------------------------------ *
 * 04 渲染：状态条 / 部署区 / 设置
 * ------------------------------------------------------------------ */

function aggregateStatus(items) {
  const ranks = { fail: 4, warn: 3, ok: 2, info: 1 };
  let best = null;
  let bestRank = 0;
  for (const item of items) {
    const rank = ranks[item.status] || 0;
    if (rank > bestRank) {
      bestRank = rank;
      best = item.status;
    }
  }
  return best || 'info';
}

function statusLabel(status) {
  return { ok: '已就绪', warn: '需注意', fail: '待处理', info: '可选' }[status] || '检测中';
}

function renderStatusStrip() {
  if (!state.checks) return;
  const items = state.checks.items || [];
  for (const [key, ids] of Object.entries(CHECK_MAP)) {
    const related = ids.map((id) => items.find((i) => i.id === id)).filter(Boolean);
    const status = related.length
      ? aggregateStatus(related)
      : (items.find((i) => i.id === 'comfy')?.status === 'fail' ? 'fail' : 'info');
    const el = document.querySelector(`.status-chip[data-status="${key}"]`);
    if (!el) continue;
    el.dataset.state = status;
    const label = el.querySelector('b');
    if (label) {
      const short = related[0]?.value || (status === 'fail' ? '未安装' : statusLabel(status));
      label.textContent = short.length > 26 ? `${short.slice(0, 25)}…` : short;
      label.title = related.map((i) => `${i.label}: ${i.value}`).join('\n');
    }
  }
  renderVlmChip();
}

function renderVlmChip() {
  const chip = document.querySelector('.status-chip[data-status="vlm"]');
  const pill = $('#vlmPill');
  const vlm = state.vlm;
  let text = '未配置';
  let status = 'info';
  let title = '可选的本地视觉模型：把图片反推成提示词。未配置时其它功能不受影响。';
  if (vlm) {
    if (vlm.available) {
      status = vlm.visionLikely ? 'ok' : 'warn';
      text = vlm.model ? vlm.model.replace(/:latest$/, '') : '已连接';
      title = `${vlm.endpoint}\n可用模型：${(vlm.models || []).join('、') || '（未返回列表）'}`;
      if (!vlm.visionLikely) title += '\n注意：没有识别出视觉模型，纯文本模型无法读图。';
    } else if (vlm.disabled) {
      status = 'info';
      text = '未配置';
      title = '视觉模型是可选功能：在设置里填写 Ollama / LM Studio 的 OpenAI 兼容地址即可启用。';
    } else {
      status = 'fail';
      text = '连不上';
      title = `${vlm.endpoint}\n${vlm.error || '无法连接'}`;
    }
  }
  if (chip) {
    chip.dataset.state = status;
    const label = chip.querySelector('b');
    if (label) {
      label.textContent = text;
      label.title = title;
    }
    chip.title = title;
  }
  if (pill) {
    pill.className = `pill ${status === 'ok' ? 'ok' : status === 'warn' ? 'warn' : status === 'fail' ? 'fail' : ''}`.trim();
    pill.textContent = `视觉模型：${text}`;
    pill.title = title;
  }
  const btn = $('#btnVlmCaption');
  if (btn) btn.hidden = !(vlm && vlm.available && vlm.model);
}

function renderDeploy() {
  if (!state.checks) return;
  const items = state.checks.items || [];
  const groups = {
    comfy: items.filter((i) => i.id === 'comfy' || i.id === 'comfy.torch' || i.id === 'comfy.port'),
    trellis: items.filter((i) => i.id === 'trellis.node' || i.id === 'comfy.torch'),
    nodes: items.filter((i) => i.group === 'nodes' || i.id.startsWith('node.') || i.id === 'pixel.workflows'),
    blender: items.filter((i) => i.id === 'blender'),
    chitubox: items.filter((i) => i.id === 'chitubox'),
  };

  for (const [group, related] of Object.entries(groups)) {
    const status = related.length
      ? aggregateStatus(related)
      : (state.checks.ready ? 'info' : 'fail');
    const badge = document.querySelector(`[data-badge="${group}"]`);
    if (badge) {
      badge.className = `badge ${status}`;
      badge.textContent = statusLabel(status);
    }
    const meta = document.querySelector(`[data-meta="${group}"]`);
    if (meta) {
      meta.className = `deploy-meta ${status}`;
      const main = related.find((i) => i.status === status) || related[0];
      const details = related
        .filter((i) => i !== main)
        .slice(0, 2)
        .map((i) => `${i.label}: ${i.value}`);
      meta.textContent = main
        ? [main.label + ': ' + main.value, ...details].filter(Boolean).join(' · ')
        : (group === 'blender' || group === 'chitubox' ? '等待检测' : '先安装 ComfyUI，再继续这一步');
    }
  }

  const pills = $('#summaryPills');
  if (pills) {
    const s = state.checks.summary || { ok: 0, warn: 0, fail: 0 };
    pills.innerHTML = [
      `<span class="pill ok">${s.ok} 项就绪</span>`,
      s.warn ? `<span class="pill warn">${s.warn} 项注意</span>` : '',
      s.fail ? `<span class="pill fail">${s.fail} 项阻塞</span>` : '',
      `<span class="pill">${state.checks.ready ? 'READY' : 'NOT READY'}</span>`,
    ].join('');
  }

  const blender = items.find((i) => i.id === 'blender');
  setText('blenderPill', blender ? `Blender：${blender.value}` : 'Blender 检测中');

  const hero = $('#heroStatus');
  if (hero) {
    if (state.checks.ready) {
      hero.textContent = '环境已就绪：可以写提示词，或直接给一张图。';
    } else {
      const s = state.checks.summary || {};
      hero.textContent = `还有 ${s.fail || 0} 项阻塞、${s.warn || 0} 项注意。按「环境部署」顺序完成即可。`;
    }
  }
  renderNextStep();
}

function renderSettings() {
  const c = state.config || {};
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.value = value;
  };
  set('cfgInstallRoot', c.installRoot || '');
  set('cfgComfyRoot', c.comfyuiRoot || '');
  set('cfgBlender', c.blenderPath || '');
  set('cfgChitubox', c.chituboxPath || '');
  set('cfgHeight', c.targetHeightMm ?? 80);
  set('cfgRepair', c.repairMode || 'auto');
  set('cfgVlmUrl', c.vlmUrl || '');
  set('cfgVlmModel', c.vlmModel || '');
  const apiKey = $('#cfgVlmApiKey');
  if (apiKey) {
    // 密钥只在服务端保存。页面永远不拿到明文，只显示「已保存」。
    apiKey.value = '';
    apiKey.placeholder = c.vlmHasKey ? '已保存（留空保持不变）' : '留空表示不需要鉴权';
  }
  const probe = $('#vlmProbeResult');
  if (probe) probe.textContent = state.vlm ? (state.vlm.available ? '已连接' : '连不上') : '未检测';
}

// Fields the user has edited by hand. A background state refresh (after an
// upload, a finished job or a re-check) must never overwrite them, otherwise a
// typed target height silently reverts to the stored default mid-workflow.
const touched = new Set();

function markTouched(id) {
  touched.add(id);
}

function clearTouched() {
  touched.clear();
}

/**
 * Restore a <select> value that may not exist as an <option> (for example a
 * decimate ratio written by `cli.mjs config set`). Without this the select
 * would silently fall back to its first option and misreport the setting.
 */
function setSelectValue(select, value) {
  if (!select) return;
  const text = String(value ?? '');
  if (text === '') return;
  const has = [...select.options].some((option) => option.value === text);
  if (!has) {
    const custom = document.createElement('option');
    custom.value = text;
    custom.textContent = `自定义（${text}）`;
    select.append(custom);
  }
  select.value = text;
}

function activeImage() {
  return state.selectedImage || state.config.lastImage || '';
}

function renderSelections() {
  const image = activeImage();
  const glb = state.selectedGlb || state.config.lastGlb || '';
  const imageLine = $('#imageFileLine');
  if (imageLine) {
    imageLine.textContent = image ? basename(image) : '尚未选择图片';
    imageLine.classList.toggle('has-file', !!image);
    imageLine.title = image;
  }
  const preview = $('#imagePreview');
  if (preview && preview.dataset.path !== image) {
    preview.dataset.path = image;
    preview.hidden = !image;
    setText('imagePreviewError', '');
    if (image) {
      preview.alt = `已选择图片：${basename(image)}`;
      preview.src = `/api/file?path=${encodeURIComponent(image)}`;
    } else preview.removeAttribute('src');
  }
  setText('imageDropTitle', image ? '点击更换图片，或拖入另一张' : '拖入生成图，或点击选择');
  renderMeshFlow();
  renderPool();
  switchPromptSource(image);

  const glbLine = $('#glbFileLine');
  if (glbLine) {
    glbLine.textContent = glb ? basename(glb) : '尚未选择 GLB';
    glbLine.classList.toggle('has-file', !!glb);
    glbLine.title = glb;
  }
  if (glb && !touched.has('glbPath')) $('#glbPath').value = glb;
  if (state.config.targetHeightMm != null && !touched.has('targetHeight')) {
    $('#targetHeight').value = state.config.targetHeightMm;
  }
  if (state.config.repairMode && !touched.has('repairMode')) {
    $('#repairMode').value = state.config.repairMode;
  }
  if (state.config.decimateRatio != null && !touched.has('decimateRatio')) {
    setSelectValue($('#decimateRatio'), state.config.decimateRatio);
  }
  renderNextStep();
}

/**
 * 图片变化时自动重新分析。用 setTimeout 做 250 ms 防抖：连续拖入多张时
 * 只分析最后停留的那一张，也不会在 vm 单测里产生额外请求。
 */
function switchPromptSource(image) {
  if (!image) return;
  if (state.inspectedPath === image && state.inspectedPreset === state.meshPreset) return;
  state.inspectedPath = image;
  state.inspectedPreset = state.meshPreset;
  setTimeout(() => inspectActiveImage({ silent: true }), 250);
}

function renderMeshFlow() {
  const image = activeImage();
  if (state.preparedMesh && (state.preparedMesh.image !== image || state.preparedMesh.preset !== state.meshPreset)) {
    state.preparedMesh = null;
  }
  const button = $('#btnPrepareMesh');
  if (button) {
    button.disabled = !image || state.imageUploading || state.meshPreparing;
    button.textContent = state.imageUploading ? '正在导入图片…'
      : state.meshPreparing ? '正在创建工作流…' : '② 创建水密工作流';
    // 禁用时给出原因，而不是让用户点一个没反应的按钮。
    button.title = !image ? '先选择或拖入一张图片'
      : state.imageUploading ? '图片正在导入，稍等片刻'
        : state.meshPreparing ? '正在写入工作流'
          : '把图片与显存档位写进 ComfyUI 工作流';
  }
  const ready = $('#meshWorkflowReady');
  if (ready) ready.hidden = !state.preparedMesh || state.imageUploading || state.meshPreparing;
  setText('meshNext', state.imageUploading ? '正在导入图片，请等导入完成后继续。'
    : state.meshPreparing ? '正在注入图片与参数，请稍候…'
    : state.preparedMesh ? '工作流已准备好。下一步：打开 ComfyUI，加载下方文件，再点击 Run（运行）开始生成网格。'
    : image ? '图片已就绪。下一步：选择显存档位，点击「② 创建水密工作流」。'
    : '① 先选择图片；导入成功后，这里会显示预览和文件名。');
}

function renderLastResultHint() {
  if (state.lastResult) return;
  const stl = state.config.lastStl;
  if (!stl) return;
  const href = `/api/download?path=${encodeURIComponent(stl)}`;
  const link = $('#btnDownloadStl');
  if (link) {
    link.href = href;
    link.classList.remove('disabled');
  }
  setText('resultLabel', `上次生成：${basename(stl)}`);
  setText('resultBig', '—');
  setText('reportNote', stl);
}

/* ------------------------------------------------------------------ *
 * 05 引导：任何时刻只给一个「下一步」
 * ------------------------------------------------------------------ */

const STAGE_ORDER = ['env', 'input', 'mesh', 'post', 'print'];

function computeNextStep() {
  const ready = state.checks?.ready === true;
  const image = activeImage();
  const glb = state.selectedGlb || state.config.lastGlb || '';
  const stl = state.config.lastStl || '';

  if (state.jobId) {
    return {
      stage: 'mesh',
      title: '有任务正在运行',
      text: '进度与日志在底部任务栏，可以继续操作页面。',
      cta: '查看进度',
      action: 'job.show',
    };
  }
  if (!state.checks) {
    return { stage: 'env', title: '正在检测本机环境…', text: '首次启动需要几秒钟。', cta: '', action: '' };
  }
  if (!ready) {
    const s = state.checks.summary || {};
    return {
      stage: 'env',
      title: `先补齐环境（${s.fail || 0} 项阻塞）`,
      text: 'ComfyUI、TRELLIS.2、水密节点与模型就位后，才能生成网格。',
      cta: '去部署',
      action: 'scroll.deploy',
    };
  }
  if (!image) {
    return {
      stage: 'input',
      title: '选一张图，或先用文字生成一张',
      text: '左侧写主体描述生成新图，右侧可以直接拖入已有图片；也可以 Ctrl+V 粘贴截图。',
      cta: '选择图片',
      action: 'pick.image',
    };
  }
  if (!state.preparedMesh) {
    const a = state.analysis;
    const warn = a && a.level !== 'ok' ? `（适配度 ${a.score}，建议先看分析）` : '';
    return {
      stage: 'input',
      title: '图片已就绪，创建水密工作流',
      text: `当前档位 ${state.meshPreset.toUpperCase()}${warn}。这一步只写参数，不会立刻开始计算。`,
      cta: '创建工作流',
      action: 'prepare.mesh',
    };
  }
  if (!glb) {
    return {
      stage: 'mesh',
      title: '到 ComfyUI 点击 Run',
      text: `在 Workflows → PixelArtistry 打开 ${state.preparedMesh.fileName || '刚生成的工作流'}，跑完后回来导入 GLB。`,
      cta: '打开 ComfyUI',
      action: 'open.comfy',
    };
  }
  if (!stl) {
    return {
      stage: 'post',
      title: '把 GLB 清理成可打印 STL',
      text: 'Blender 会删碎屑、补洞、按目标毫米缩放并导出 STL。',
      cta: '运行后处理',
      action: 'prepare.post',
    };
  }
  return {
    stage: 'print',
    title: 'STL 已就绪，可以去切片了',
    text: `${basename(stl)} · 在 CHITUBOX 里加支撑、检查每层岛后切片。`,
    cta: '启动 CHITUBOX',
    action: 'open.chitubox',
  };
}

function renderNextStep() {
  const bar = $('#nextStep');
  if (!bar) return;
  if (state.nextStepHidden) {
    bar.hidden = true;
    return;
  }
  const step = computeNextStep();
  state.nextStage = step.stage;
  bar.hidden = false;
  setText('nextStepTitle', step.title);
  setText('nextStepText', step.text || '');
  const btn = $('#nextStepBtn');
  if (btn) {
    btn.hidden = !step.cta;
    btn.textContent = step.cta || '继续';
    btn.dataset.nextAction = step.action || '';
  }
  const current = STAGE_ORDER.indexOf(step.stage);
  $$('#nextStepTrack .ns-chip').forEach((chip) => {
    const index = STAGE_ORDER.indexOf(chip.dataset.stage);
    chip.classList.toggle('done', index < current);
    chip.classList.toggle('active', index === current);
  });
}

async function runNextStep() {
  const action = $('#nextStepBtn')?.dataset.nextAction || '';
  switch (action) {
    case 'scroll.deploy':
      document.querySelector('#deploy')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    case 'pick.image':
      $('#imageInput')?.click();
      return;
    case 'prepare.mesh':
      await prepareMesh($('#btnPrepareMesh'));
      return;
    case 'open.comfy':
      await handleAction({ dataset: { action: 'comfy.open' } });
      return;
    case 'prepare.post':
      $('#btnPostprocess')?.click();
      return;
    case 'open.chitubox':
      await handleAction({ dataset: { action: 'chitubox.open' } });
      return;
    case 'job.show':
      showJobbar();
      return;
    default:
      document.querySelector('#create')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

/* ------------------------------------------------------------------ *
 * 06 任务：进度、错误、重试
 * ------------------------------------------------------------------ */

function jobDetailText(job) {
  if (job.detail) return job.detail;
  if (job.bytes != null && job.bytes > 0) {
    const total = job.totalBytes ? ` / ${formatBytes(job.totalBytes)}` : '';
    return `${formatBytes(job.bytes)}${total}`;
  }
  return '';
}

function renderJobError(job) {
  const box = $('#jobError');
  if (!box) return;
  const failed = job.status === 'error';
  if (!failed) {
    box.hidden = true;
    state.jobError = null;
    return;
  }
  box.hidden = false;
  const info = humanizeError({ message: job.error || job.message, code: job.errorCode || '' });
  state.jobError = info;
  setText('jobErrorTitle', info.title);
  const parts = [info.detail, info.hint].filter(Boolean);
  setText('jobErrorText', parts.join(' · ') || job.message || '任务失败');
  const retry = $('#btnJobRetry');
  if (retry) retry.hidden = !state.lastJobAction;
}

function renderJob(job) {
  if (!job) return;
  const bar = $('#jobbar');
  if (bar) bar.classList.add('show');
  setText('jobTitle', job.title || '任务');
  setText('jobMessage', job.message || '');
  setText('jobPercent', `${Math.round(job.progress || 0)}%`);
  const spinner = $('#jobSpinner');
  if (spinner) spinner.className = `spinner ${job.status === 'running' ? '' : job.status}`.trim();
  const progress = $('#jobProgress');
  if (progress) progress.style.width = `${Math.max(0, Math.min(100, job.progress || 0))}%`;
  const track = progress?.parentElement;
  track?.classList.toggle('indeterminate', !!job.indeterminate && job.status === 'running');
  track?.classList.toggle('error', job.status === 'error');
  track?.classList.toggle('done', job.status === 'done');

  // 速度与剩余时间：只在服务端给了字节信息时显示，避免编造。
  const bits = [jobDetailText(job)];
  if (job.speed) bits.push(`${formatBytes(job.speed)}/s`);
  if (job.eta && job.status === 'running') bits.push(`剩余约 ${formatDuration(job.eta)}`);
  setText('jobDetail', bits.filter(Boolean).join(' · '));

  const progressBar = $('#jobProgressBar');
  if (progressBar) {
    progressBar.setAttribute('aria-valuenow', String(Math.round(job.progress || 0)));
    progressBar.setAttribute('aria-valuetext', `${job.message || '任务'}，${Math.round(job.progress || 0)}%`);
    progressBar.classList.toggle('indeterminate', !!job.indeterminate && job.status === 'running');
    progressBar.classList.toggle('error', job.status === 'error');
    progressBar.classList.toggle('done', job.status === 'done');
  }
  const log = $('#jobLog');
  if (log) {
    if (state.jobLogOpen) {
      log.hidden = false;
      const lines = (job.logs || []).slice(-120).map((entry) => `[${new Date(entry.t).toLocaleTimeString()}] ${entry.text}`);
      log.textContent = lines.join('\n') || '暂无日志';
      log.scrollTop = log.scrollHeight;
    } else {
      log.hidden = true;
    }
  }
  const toggle = $('#btnToggleLog');
  if (toggle) {
    toggle.textContent = state.jobLogOpen ? '收起日志' : '展开日志';
    toggle.setAttribute('aria-expanded', String(state.jobLogOpen));
  }
  const cancel = $('#btnCancelJob');
  if (cancel) cancel.hidden = job.status !== 'running';
  renderJobError(job);
  if (job.type === 'install.oneclick') renderOneClick(job);
}

const ONECLICK_STAGES = ['comfy', 'torch', 'trellis', 'pixel', 'qwen', 'done'];
const ONECLICK_STAGE_INDEX = {
  preflight: -1,
  comfy: 0,
  torch: 1,
  trellis: 2,
  pixel: 3,
  workflows: 3,
  qwen: 4,
  done: 5,
};

function renderOneClick(job) {
  state.oneClickJob = job;
  // Optimistic placeholder objects have no id; keep the previously known id
  // instead of overwriting it with undefined.
  state.oneClickJobId = job.status === 'running' ? job.id || state.oneClickJobId || null : null;
  const panel = $('#oneClickProgress');
  if (!panel) return;
  panel.hidden = false;
  const pct = Math.max(0, Math.min(100, Math.round(job.progress || 0)));
  const bar = $('#oneClickBar');
  if (bar) bar.style.width = `${pct}%`;
  const progressBar = $('#oneClickProgressBar');
  if (progressBar) {
    progressBar.setAttribute('aria-valuenow', String(pct));
    progressBar.setAttribute('aria-valuetext', `${job.message || '一键部署'}，${pct}%`);
    progressBar.classList.toggle('indeterminate', !!job.indeterminate && job.status === 'running');
    progressBar.classList.toggle('error', job.status === 'error');
    progressBar.classList.toggle('done', job.status === 'done');
  }
  setText('oneClickPct', `${pct}%`);
  setText('oneClickMsg', job.message || '准备中…');
  setText('oneClickDetail', jobDetailText(job));
  const track = bar?.parentElement;
  track?.classList.toggle('indeterminate', !!job.indeterminate && job.status === 'running');
  track?.classList.toggle('error', job.status === 'error');
  track?.classList.toggle('done', job.status === 'done');

  const current = ONECLICK_STAGE_INDEX[job.stage] ?? (job.status === 'done' ? 5 : -1);
  $$('#oneClickStages .stage-chip').forEach((chip, index) => {
    chip.classList.toggle('done', job.status === 'done' || index < current);
    chip.classList.toggle('active', job.status === 'running' && index === current);
    chip.classList.toggle('error', job.status === 'error' && index === current);
    if (job.status === 'running' && index === current) chip.setAttribute('aria-current', 'step');
    else chip.removeAttribute('aria-current');
  });

  const errorBox = $('#oneClickError');
  if (errorBox) {
    const show = job.status === 'error' && job.error;
    errorBox.hidden = !show;
    errorBox.textContent = show ? errorToText({ message: job.error }) : '';
  }

  const log = $('#oneClickLog');
  if (log) {
    if (state.oneClickLogOpen) {
      log.hidden = false;
      const lines = (job.logs || []).slice(-120).map((entry) => `[${new Date(entry.t).toLocaleTimeString()}] ${entry.text}`);
      log.textContent = lines.join('\n') || '暂无日志';
      log.scrollTop = log.scrollHeight;
    } else {
      log.hidden = true;
    }
  }
  const logBtn = $('#btnOneClickLog');
  if (logBtn) {
    logBtn.textContent = state.oneClickLogOpen ? '收起日志' : '展开日志';
    logBtn.setAttribute('aria-expanded', String(state.oneClickLogOpen));
    logBtn.setAttribute('aria-controls', 'oneClickLog');
  }
  const cancel = $('#btnOneClickCancel');
  if (cancel) cancel.hidden = job.status !== 'running';

  const start = $('#btnOneClick');
  if (start) {
    if (job.status === 'running') {
      start.disabled = true;
      start.textContent = '部署进行中…';
    } else if (job.status === 'error' || job.status === 'cancelled') {
      start.disabled = false;
      start.textContent = '继续部署（断点续跑）';
    } else if (job.status === 'done') {
      start.disabled = false;
      start.textContent = '重新部署';
    }
  }
}

const DEPLOY_MODE_KEY = 'ai3d.deployMode';
const NEXT_STEP_KEY = 'ai3d.nextStepHidden';

function setDeployMode(mode, { persist = true } = {}) {
  const next = mode === 'manual' ? 'manual' : 'oneclick';
  if (next === 'manual' && state.oneClickJobId) {
    toast('一键部署正在进行，完成或取消后才能切换到手动分步。', 'warn');
    return;
  }
  state.deployMode = next;
  $$('[data-deploy-mode]').forEach((button) => {
    const active = button.dataset.deployMode === next;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const oneClick = $('#oneClick');
  const manual = $('#manualDeploy');
  if (oneClick) oneClick.hidden = next !== 'oneclick';
  if (manual) manual.hidden = next !== 'manual';
  if (persist) {
    try {
      localStorage.setItem(DEPLOY_MODE_KEY, next);
    } catch {}
  }
}

function renderReuseHint() {
  const hint = $('#oneClickReuseHint');
  if (!hint) return;
  if ($('#oneClickReuse')?.checked === false) {
    hint.className = 'reuse-hint';
    hint.textContent = '已关闭自动复用；所需权重会由官方安装器重新下载。';
    hint.title = '';
    return;
  }
  const reuse = state.reuse || {};
  const compatible = reuse.compatible || [];
  const external = reuse.external || [];
  const placed = reuse.placed || [];
  const partial = reuse.partial || [];
  const stacks = reuse.stacks || [];
  hint.className = 'reuse-hint';
  if (external.length) {
    const names = external.slice(0, 3).map((item) => basename(item.file)).join('、');
    hint.textContent = `发现 ${external.length} 个可复用的同名模型：${names}${external.length > 3 ? ' 等' : ''}。一键部署会硬链接，不重复下载。`;
    hint.classList.add('ok');
    hint.title = external.map((item) => `${item.file}\n${item.path}`).join('\n\n');
  } else if (compatible.length || placed.length) {
    hint.textContent = `目标目录已有 ${compatible.length || placed.length} 个所需模型，无需重复复用或下载。`;
    hint.classList.add('ok');
    hint.title = '';
  } else {
    hint.textContent = partial.length
      ? `发现 ${partial.length} 个同名但偏小的文件，已忽略（不会复用不完整权重）。`
      : '未发现可复用的同名模型；所需权重会由官方安装器下载。';
    if (partial.length) hint.classList.add('warn');
    hint.title = '';
  }
  if (stacks.length) {
    hint.textContent += ' 本机另有 Ollama / Hugging Face 等模型，但架构不同，不能用于本工作流。';
  }
}

async function scanModels({ silent = true } = {}) {
  const hint = $('#oneClickReuseHint');
  if (hint) {
    hint.className = 'reuse-hint';
    hint.textContent = '正在扫描本机模型…';
    hint.title = '';
  }
  try {
    const data = await api('models.scan');
    state.reuse = data.reuse || {};
    renderReuseHint();
    return state.reuse;
  } catch (err) {
    if (hint) {
      hint.className = 'reuse-hint warn';
      hint.textContent = `本机模型扫描失败：${humanizeError(err).title}`;
    }
    if (!silent) toast(`模型扫描失败：${humanizeError(err).title}`, 'warn', 8000);
    return null;
  }
}

const DOCTOR_LEVEL_LABEL = { fail: '阻塞', warn: '注意', info: '提示', ok: '通过' };

function doctorToText(doctor) {
  if (!doctor) return '尚未运行部署自检。';
  const s = doctor.summary || {};
  const lines = [
    'AI3D Print Flow 部署自检',
    `时间: ${doctor.generatedAt || new Date().toISOString()}`,
    `结论: ${doctor.ok ? '通过（无阻塞项）' : '存在阻塞项'}`,
    `阻塞 ${s.fail || 0} · 注意 ${s.warn || 0} · 提示 ${s.info || 0}`,
    '',
  ];
  for (const item of doctor.issues || []) {
    lines.push(`[${DOCTOR_LEVEL_LABEL[item.level] || item.level}] ${item.code || ''} ${item.title || ''}`.trim());
    if (item.detail) lines.push(`  ${item.detail}`);
    if (item.fix) lines.push(`  处理: ${item.fix}`);
  }
  const compatible = doctor.reuse?.compatible || [];
  const external = doctor.reuse?.external || [];
  const placed = doctor.reuse?.placed || [];
  if (external.length) {
    lines.push('', '可硬链接复用的同名模型:');
    for (const item of external) lines.push(`  - ${item.file} (${formatBytes(item.size)}) ${item.path}`);
  }
  if (placed.length) {
    lines.push('', '已在 ComfyUI/models 就位的模型:');
    for (const item of placed) lines.push(`  - ${item.file} (${formatBytes(item.size)})`);
  } else if (!compatible.length) {
    lines.push('', '未发现可用于本流程的精确同名权重。');
  }
  const stacks = doctor.reuse?.stacks || [];
  if (stacks.length) {
    lines.push('', '本机其它模型（不可直接复用）:');
    for (const stack of stacks) lines.push(`  - ${stack.label}: ${stack.models.join('、')}`);
  }
  if (doctor.next?.length) {
    lines.push('', '建议下一步:');
    for (const item of doctor.next) lines.push(`  - ${item}`);
  }
  return lines.join('\n');
}

function renderDoctor(doctor) {
  const box = $('#doctorResult');
  if (!box || !doctor) return;
  const s = doctor.summary || {};
  const issues = doctor.issues || [];
  const pills = [
    s.fail ? `<span class="pill fail">${s.fail} 阻塞</span>` : '',
    s.warn ? `<span class="pill warn">${s.warn} 注意</span>` : '',
    s.info ? `<span class="pill">${s.info} 提示</span>` : '',
    `<span class="pill ${doctor.ok ? 'ok' : 'fail'}">${doctor.ok ? 'PASS' : 'BLOCKED'}</span>`,
  ].join('');
  const issueHtml = issues.length
    ? issues
        .map(
          (item) => `<div class="doctor-issue ${escapeHtml(item.level)}">
            <div class="doctor-issue-head"><span class="doctor-code">${escapeHtml(item.code)}</span><b>${escapeHtml(item.title)}</b></div>
            ${item.detail ? `<p>${escapeHtml(item.detail)}</p>` : ''}
            ${item.fix ? `<div class="doctor-fix"><span>FIX</span>${escapeHtml(item.fix)}</div>` : ''}
          </div>`,
        )
        .join('')
    : '<div class="doctor-issue ok"><div class="doctor-issue-head"><span class="doctor-code">OK</span><b>未发现阻塞项</b></div><p>安装、节点、模型与工具链均已就绪。</p></div>';

  const compatible = doctor.reuse?.compatible || [];
  const external = doctor.reuse?.external || [];
  const placed = doctor.reuse?.placed || [];
  const stacks = doctor.reuse?.stacks || [];
  const reuseLines = [];
  if (external.length) {
    reuseLines.push(
      `<p>发现 ${external.length} 个精确同名、可硬链接复用的权重：</p><ul>${external
        .slice(0, 8)
        .map((item) => `<li><code>${escapeHtml(item.file)}</code> · ${escapeHtml(formatBytes(item.size))} · ${escapeHtml(item.path)}</li>`)
        .join('')}</ul>`,
    );
  }
  if (placed.length) {
    reuseLines.push(`<p>目标目录已有 ${placed.length} 个所需模型，无需重复下载。</p>`);
  }
  if (!compatible.length) {
    reuseLines.push('<p>未发现可用于本流程的精确同名权重。</p>');
  }
  if (stacks.length) {
    reuseLines.push(
      `<ul>${stacks
        .map((stack) => `<li>${escapeHtml(stack.label)}：${escapeHtml(stack.models.slice(0, 6).join('、'))}${stack.models.length > 6 ? ` 等 ${stack.models.length} 个` : ''}；${escapeHtml(stack.reason)}</li>`)
        .join('')}</ul>`,
    );
  }

  box.innerHTML = `
    <div class="doctor-summary">${pills}<span class="doctor-time">${escapeHtml(formatStamp(Date.parse(doctor.generatedAt)))}</span></div>
    <div class="doctor-issues">${issueHtml}</div>
    <div class="doctor-reuse"><h4>本机模型复用检查</h4>${reuseLines.join('')}</div>
    <div class="doctor-next"><b>建议下一步</b>${(doctor.next || []).map((item) => escapeHtml(item)).join('<br />')}</div>
  `;
  box.hidden = false;
  const copy = $('#btnDoctorCopy');
  if (copy) copy.hidden = false;
}

async function runDeployDoctor({ auto = false } = {}) {
  const button = $('#btnDeployDoctor');
  const box = $('#doctorResult');
  if (button) {
    button.disabled = true;
    button.textContent = '自检中…';
  }
  if (box && auto) {
    box.hidden = false;
    box.innerHTML = '<div class="doctor-time">正在重新检测环境，请稍候…</div>';
  }
  try {
    const data = await api('deploy.doctor', {});
    const doctor = data.doctor;
    state.doctor = doctor;
    renderDoctor(doctor);
    if (doctor.reuse) {
      state.reuse = doctor.reuse;
      renderReuseHint();
    }
    if (doctor.checks) {
      state.checks = doctor.checks;
      renderStatusStrip();
      renderDeploy();
    }
    if (!auto) {
      toast(
        doctor.ok ? '部署自检通过，未发现阻塞项。' : `自检发现 ${doctor.summary?.fail || 0} 个阻塞项，请按提示处理。`,
        doctor.ok ? 'ok' : 'warn',
        7000,
      );
    }
    return doctor;
  } catch (err) {
    toast(`部署自检失败：${humanizeError(err).title}`, 'error', 9000);
    if (box && auto) {
      box.hidden = false;
      box.innerHTML = `<div class="doctor-issue fail"><div class="doctor-issue-head"><span class="doctor-code">ERROR</span><b>自检没有完成</b></div><p>${escapeHtml(err.message)}</p></div>`;
    }
    throw err;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = '重新自检';
    }
  }
}

function showJobbar() {
  const bar = $('#jobbar');
  if (bar) bar.classList.add('show');
}

function hideJobbarLater(delay = 5200) {
  setTimeout(() => {
    if (state.jobTimer) return;
    const bar = $('#jobbar');
    if (bar) bar.classList.remove('show');
  }, delay);
}

async function cancelCurrentJob(jobId) {
  if (!jobId) {
    toast('当前没有正在运行的任务', 'warn');
    return;
  }
  try {
    const data = await api('jobs.cancel', { jobId });
    if (data.cancelled) toast('已请求取消，正在停止子进程…', 'warn', 6000);
    else toast('任务已经结束，无需取消', 'warn');
  } catch (err) {
    toast(humanizeError(err).title, 'error', 8000);
  }
}

async function watchJob(jobId) {
  if (state.jobTimer) {
    clearTimeout(state.jobTimer);
    state.jobTimer = null;
  }
  state.jobId = jobId;
  state.jobTimer = null;
  state.jobLogOpen = false;
  showJobbar();
  renderNextStep();
  let failures = 0;
  const schedule = (ms) => {
    state.jobTimer = setTimeout(tick, ms);
  };

  const tick = async () => {
    state.jobTimer = null;
    try {
      const data = await apiGet(`/api/job?id=${encodeURIComponent(jobId)}`, {
        timeout: 10000,
        retries: 0,
        label: '读取任务进度',
      });
      failures = 0;
      const job = data.job;
      if (!job) throw new Error('任务不存在或已被清理');
      renderJob(job);
      if (job.status === 'running') {
        // Poll less often while the tab is in the background. The install
        // continues on the server; this only saves CPU and battery.
        schedule(document.hidden ? 3000 : 900);
        return;
      }
      state.jobTimer = null;
      state.jobTick = null;
      state.jobId = null;
      if (job.type === 'postprocess' && job.status === 'done' && job.result) {
        renderResult(job.result);
        loadArtifacts();
        toast(job.result.watertight === false ? 'STL 已生成，但网格未完全水密。' : 'STL 已生成并通过检查。', job.result.watertight === false ? 'warn' : 'ok', 6000);
      } else if (job.status === 'error') {
        const info = humanizeError({ message: job.error || job.message });
        toast(info.title, 'error', { timeout: 9000, action: state.lastJobAction ? { label: '重试', onClick: retryLastJob } : null });
      } else if (job.status === 'cancelled') {
        toast('任务已取消', 'warn');
      } else if (job.type === 'install.oneclick') {
        toast('一键部署完成。正在运行部署后自检…', 'ok', 9000);
      } else {
        toast(job.message || '任务完成', 'ok');
      }
      await refreshState({ silent: true });
      renderNextStep();
      if (job.type === 'install.oneclick' && (job.status === 'done' || job.status === 'error')) {
        await runDeployDoctor({ auto: true }).catch(() => {});
      }
      hideJobbarLater(job.type === 'install.oneclick' ? 9000 : 5200);
    } catch (err) {
      // A long install can briefly make the local server busy. Keep polling
      // instead of declaring the whole deployment failed.
      if (err.network && failures < 20) {
        failures += 1;
        const wait = Math.min(10000, 1500 * 2 ** Math.min(failures - 1, 3));
        state.jobTimer = setTimeout(tick, wait);
        setText('jobMessage', `本地服务连接中断，正在自动重试（${failures}/20）…`);
        setText('jobDetail', err.message);
        if (failures === 1) toast('任务进度连接中断，后台可能仍在运行，正在自动重试…', 'warn', 6500);
        return;
      }
      state.jobTimer = null;
      state.jobTick = null;
      state.jobId = null;
      toast(`${humanizeError(err).title} 任务可能仍在后台运行，请稍后点「重新检查」。`, 'error', 9000);
      hideJobbarLater(3000);
    }
  };

  state.jobTick = tick;
  schedule(150);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden || !state.jobId || !state.jobTick) return;
  if (state.jobTimer) clearTimeout(state.jobTimer);
  state.jobTimer = setTimeout(state.jobTick, 50);
});

const JOB_ACTIONS = new Set([
  'install.oneclick',
  'install.qwenModels',
  'install.comfy.download',
  'install.blender',
  'comfy.start',
  'postprocess.run',
]);

async function runAction(action, payload = {}, button = null) {
  if (button) button.disabled = true;
  const optimistic = JOB_ACTIONS.has(action);
  if (optimistic) {
    state.jobLogOpen = false;
    showJobbar();
    const title = button?.textContent?.trim() || '任务';
    renderJob({
      type: action === 'install.oneclick' ? 'install.oneclick' : '',
      title,
      status: 'running',
      progress: 0,
      message: '正在连接本地服务…',
      detail: '',
      indeterminate: true,
      logs: [],
    });
    if (action === 'install.oneclick') {
      const panel = $('#oneClickProgress');
      if (panel) panel.hidden = false;
      renderOneClick({
        type: 'install.oneclick',
        title,
        status: 'running',
        stage: 'preflight',
        progress: 0,
        message: '正在连接本地服务…',
        detail: '',
        logs: [],
      });
    }
  }
  try {
    const data = await api(action, payload);
    if (data.jobId) {
      // 记住这次调用，任务失败时可以一键重试同样的参数。
      state.lastJobAction = { action, payload, label: button?.textContent?.trim() || action };
      if (action === 'install.oneclick') {
        state.oneClickJobId = data.jobId;
        const panel = $('#oneClickProgress');
        if (panel) panel.hidden = false;
        await watchJob(data.jobId);
      } else {
        // Show progress immediately; the server rejects duplicate heavy jobs,
        // so the button can be re-enabled as soon as the job is accepted.
        watchJob(data.jobId);
      }
      return data;
    }
    if (optimistic) hideJobbarLater(1400);
    return data;
  } catch (err) {
    const info = humanizeError(err);
    toast(info.title, 'error', { timeout: 8500, hint: info.hint });
    if (optimistic) hideJobbarLater(3000);
    throw err;
  } finally {
    if (button) button.disabled = false;
  }
}

async function retryLastJob() {
  const last = state.lastJobAction;
  if (!last) {
    toast('没有可重试的任务', 'warn');
    return;
  }
  const box = $('#jobError');
  if (box) box.hidden = true;
  try {
    await runAction(last.action, last.payload, null);
  } catch {}
}

/** 顶部重试按钮所用的「上一次失败的动作」。 */
let lastFailedAction = null;

async function refreshState({ silent = false } = {}) {
  try {
    const data = await apiGet('/api/state', {
      timeout: 30000,
      retries: 2,
      retryDelay: 700,
      label: '读取环境状态',
    });
    state.config = data.config || {};
    state.checks = data.checks || null;
    state.presets = data.presets || null;
    state.limits = data.limits || null;
    state.jobs = data.jobs || [];
    if (data.version) {
      const versionEl = $('#appVersion');
      if (versionEl) versionEl.textContent = `v${data.version}`;
    }
    renderStatusStrip();
    renderDeploy();
    renderSelections();
    // The settings drawer is populated on open only. Re-filling it here would
    // discard half-typed paths while the user is still editing.
    renderLastResultHint();
    if (!silent) setText('heroStatus', state.checks?.ready ? '环境已就绪：可以写提示词，或直接给一张图。' : '环境尚未就绪，请先完成部署。');
    return data;
  } catch (err) {
    setConnection(false, err.message);
    if (!silent) toast(humanizeError(err).title, 'error', 9000);
    return null;
  }
}

async function recheck() {
  if (state.rechecking) return;
  const button = $('#btnRecheck');
  state.rechecking = true;
  if (button) {
    button.disabled = true;
    button.textContent = '检测中…';
  }
  setText('heroStatus', '正在重新检测环境，请稍候…');
  try {
    const data = await apiGet('/api/checks?refresh=1', {
      timeout: 180000,
      retries: 1,
      retryDelay: 1000,
      label: '环境检测',
    });
    state.checks = data.checks;
    renderStatusStrip();
    renderDeploy();
    renderSelections();
    toast('环境检测已刷新', 'ok');
  } catch (err) {
    const info = humanizeError(err);
    toast(info.title, 'error', 10000);
    setText('heroStatus', err.network ? '本地服务连接中断：请确认启动窗口还在运行。' : `检测失败：${info.title}`);
  } finally {
    state.rechecking = false;
    if (button) {
      button.disabled = false;
      button.textContent = '重新检查';
    }
  }
}

async function startOneClick() {
  const button = $('#btnOneClick');
  if (state.oneClickJobId) {
    toast('部署已经在运行，请查看上方进度。', 'warn');
    return;
  }
  setDeployMode('oneclick');
  const includeQwen = $('#oneClickQwen')?.checked === true;
  const reuseModels = $('#oneClickReuse')?.checked !== false;
  try {
    await runAction('install.oneclick', { includeQwen, reuseModels }, button);
  } catch {}
}

/* ------------------------------------------------------------------ *
 * 07 多模态：候选池 / 图片分析 / 视觉模型
 * ------------------------------------------------------------------ */

function presetTable() {
  return state.presets || PRESET_FALLBACK;
}

function updatePreset(preset) {
  state.meshPreset = preset;
  $$('#meshPreset button').forEach((b) => b.classList.toggle('active', b.dataset.preset === preset));
  const hint = presetTable()[preset] || PRESET_FALLBACK['1.5k'];
  setText('proxyHint', Number(hint.proxy || 0).toLocaleString());
  setText('resHint', String(hint.resolution));
  // 档位变了，之前的「适配度」是按旧档位算的，需要重算。
  state.inspectedPreset = '';
  renderMeshFlow();
  if (activeImage()) setTimeout(() => inspectActiveImage({ silent: true }), 120);
  renderNextStep();
}

/**
 * 浏览器端像素统计。服务端只能看文件头，这里用 canvas 抽样 128×128，
 * 得到背景均匀度、主体占比、对比度与锐度——都是「图能不能转成网格」的
 * 直接指标，且完全本地。
 */
function analyzePixels(objectUrl) {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined' || typeof document === 'undefined') {
      resolve(null);
      return;
    }
    let img;
    try {
      img = new Image();
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 4000);
    img.onerror = () => {
      clearTimeout(timer);
      finish(null);
    };
    img.onload = () => {
      clearTimeout(timer);
      try {
        const canvas = document.createElement('canvas');
        if (!canvas || typeof canvas.getContext !== 'function') return finish(null);
        const size = 128;
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return finish(null);
        ctx.drawImage(img, 0, 0, size, size);
        const { data } = ctx.getImageData(0, 0, size, size);
        const lum = new Float32Array(size * size);
        let alphaPixels = 0;
        let sum = 0;
        for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const a = data[i + 3];
          if (a < 16) alphaPixels += 1;
          const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          lum[p] = l;
          sum += l;
        }
        const mean = sum / lum.length;
        let variance = 0;
        for (let i = 0; i < lum.length; i += 1) variance += (lum[i] - mean) ** 2;
        const contrast = Math.sqrt(variance / lum.length);

        // 背景取四角 12×12 的均值，再算主体占比（与背景色差明显的像素）。
        const patch = 12;
        let bgR = 0; let bgG = 0; let bgB = 0; let bgN = 0;
        const corners = [[0, 0], [size - patch, 0], [0, size - patch], [size - patch, size - patch]];
        for (const [ox, oy] of corners) {
          for (let y = oy; y < oy + patch; y += 1) {
            for (let x = ox; x < ox + patch; x += 1) {
              const i = (y * size + x) * 4;
              bgR += data[i]; bgG += data[i + 1]; bgB += data[i + 2];
              bgN += 1;
            }
          }
        }
        bgR /= bgN; bgG /= bgN; bgB /= bgN;

        let subject = 0;
        let borderTouch = 0;
        let borderCount = 0;
        for (let y = 0; y < size; y += 1) {
          for (let x = 0; x < size; x += 1) {
            const i = (y * size + x) * 4;
            const dr = data[i] - bgR;
            const dg = data[i + 1] - bgG;
            const db = data[i + 2] - bgB;
            const dist = Math.sqrt(dr * dr + dg * dg + db * db);
            const isSubject = data[i + 3] < 16 ? false : dist > 42;
            if (isSubject) subject += 1;
            const onBorder = x < 3 || y < 3 || x >= size - 3 || y >= size - 3;
            if (onBorder) {
              borderCount += 1;
              if (isSubject) borderTouch += 1;
            }
          }
        }

        // 锐度：拉普拉斯响应的平均绝对值，越大越锐。
        let edge = 0;
        let edgeN = 0;
        for (let y = 1; y < size - 1; y += 1) {
          for (let x = 1; x < size - 1; x += 1) {
            const i = y * size + x;
            const v = 4 * lum[i] - lum[i - 1] - lum[i + 1] - lum[i - size] - lum[i + size];
            edge += Math.abs(v);
            edgeN += 1;
          }
        }

        finish({
          contrast: Math.round(contrast * 10) / 10,
          subjectCoverage: Math.round((subject / (size * size)) * 1000) / 10,
          borderTouch: Math.round((borderTouch / Math.max(1, borderCount)) * 1000) / 10,
          sharpness: Math.round((edge / Math.max(1, edgeN)) * 10) / 10,
          meanLuma: Math.round(mean),
          transparentShare: Math.round((alphaPixels / (size * size)) * 1000) / 10,
        });
      } catch {
        finish(null);
      }
    };
    img.src = objectUrl;
  });
}

/** 把服务端结构分析与浏览器像素统计合成一份给用户看的结论。 */
function mergeAnalysis(server, pixels) {
  if (!server) return null;
  const findings = [...(server.findings || [])];
  let score = server.score;
  if (pixels) {
    if (pixels.subjectCoverage < 6) {
      score -= 12;
      findings.push({
        level: 'warn',
        title: `主体占比偏小（${pixels.subjectCoverage}%）`,
        detail: '主体在画面里太小，转网格后细节分辨率不足。',
        fix: '裁剪掉多余留白，让主体占到画面 40%–80%。',
      });
    } else if (pixels.subjectCoverage > 88) {
      score -= 8;
      findings.push({
        level: 'warn',
        title: `主体几乎铺满画面（${pixels.subjectCoverage}%）`,
        detail: '边缘可能被裁掉，转网格时容易出现断面。',
        fix: '在出图时留一圈背景，或换用 1:1 画幅。',
      });
    }
    if (pixels.borderTouch > 25) {
      score -= 10;
      findings.push({
        level: 'warn',
        title: `主体触边（边缘 ${pixels.borderTouch}% 有内容）`,
        detail: '贴边的部分会被截断，底座或翅膀常常因此丢失。',
        fix: '重新生成时把主体缩小一点，或先裁剪再补边。',
      });
    }
    if (pixels.sharpness < 3) {
      score -= 8;
      findings.push({
        level: 'warn',
        title: `细节偏软（锐度 ${pixels.sharpness}）`,
        detail: '图像像是轻微模糊或经过强降噪，表面细节会转不出来。',
        fix: '换一张原始尺寸的图，避免二次压缩或放大。',
      });
    }
    if (pixels.contrast < 14) {
      score -= 6;
      findings.push({
        level: 'info',
        title: `对比度偏低（${pixels.contrast}）`,
        detail: '低对比度会让抠图边界不稳，但通常仍可处理。',
        fix: '导出前稍微提高对比度会有帮助。',
      });
    }
    if (pixels.transparentShare > 60) {
      findings.push({
        level: 'info',
        title: `大面积透明（${pixels.transparentShare}%）`,
        detail: 'BiRefNet 会自动抠图，透明区域不会变成模型。',
        fix: '',
      });
    }
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  const level = findings.some((f) => f.level === 'risk') ? 'risk' : findings.some((f) => f.level === 'warn') ? 'warn' : 'ok';
  // 像素统计可能把服务端的 ok 降成 warn。此时必须同步换掉 summary，
  // 否则会出现「标题说可改进、正文说适合直接转网格」的自相矛盾。
  const summary = level === server.level
    ? server.summary
    : level === 'risk'
      ? '这张图很可能转不出可用的网格，建议换一张。'
      : level === 'warn'
        ? '可以继续，但按下面的建议调整效果会明显更好。'
        : '这张图适合直接转网格。';
  return { ...server, summary, findings, score, level, pixels: pixels || null };
}

async function inspectActiveImage({ silent = true } = {}) {
  const image = activeImage();
  if (!image) {
    state.analysis = null;
    renderAnalysis();
    return null;
  }
  state.inspectedPath = image;
  state.inspectedPreset = state.meshPreset;
  try {
    const data = await api('image.inspect', { path: image, preset: state.meshPreset });
    const server = data.image;
    if (!server) return null;
    // 像素统计是增强项：拿不到（无 canvas / 跨域）就只用服务端结论。
    let pixels = null;
    if (state.pixelStats && state.pixelStats.path === image) {
      pixels = state.pixelStats.stats;
    } else {
      pixels = await analyzePixels(`/api/file?path=${encodeURIComponent(image)}`).catch(() => null);
      state.pixelStats = { path: image, stats: pixels };
    }
    state.analysis = mergeAnalysis(server, pixels);
    renderAnalysis();
    updatePoolAnalysis(image, state.analysis);
    renderNextStep();
    return state.analysis;
  } catch (err) {
    state.analysis = null;
    renderAnalysis();
    if (!silent) toast(humanizeError(err).title, 'error', 8000);
    return null;
  }
}

const LEVEL_TEXT = { ok: '合适', warn: '可改进', risk: '不建议', info: '提示' };

function renderAnalysis() {
  const box = $('#imageAnalysis');
  if (!box) return;
  const a = state.analysis;
  if (!a) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const score = $('#analysisScore');
  if (score) {
    score.dataset.level = a.level;
    score.style.setProperty('--score', `${a.score}%`);
    const num = score.querySelector('b');
    if (num) num.textContent = String(a.score);
  }
  setText('analysisTitle', `这张图：${LEVEL_TEXT[a.level] || '待评估'}`);
  setText(
    'analysisText',
    `${a.width}×${a.height} · ${a.aspect}:1 · ${a.format.toUpperCase()}${a.hasAlpha ? ' · 含透明' : ''} · ${a.summary}`,
  );
  const chips = $('#analysisChips');
  if (chips) {
    const items = [
      `${a.megapixels} MP`,
      `短边 ${a.minSide} px`,
      a.pixels ? `主体 ${a.pixels.subjectCoverage}%` : '',
      a.pixels ? `锐度 ${a.pixels.sharpness}` : '',
      a.level === 'ok' ? '可直接使用' : '',
    ].filter(Boolean);
    chips.innerHTML = items.map((t) => `<span class="a-chip">${escapeHtml(t)}</span>`).join('');
  }
  const list = $('#findingList');
  if (list) {
    list.innerHTML = (a.findings || [])
      .map(
        (f) => `<li class="finding ${escapeHtml(f.level)}">
          <span class="finding-dot"></span>
          <div>
            <b>${escapeHtml(f.title)}</b>
            ${f.detail ? `<p>${escapeHtml(f.detail)}</p>` : ''}
            ${f.fix ? `<small>${escapeHtml(f.fix)}</small>` : ''}
          </div>
        </li>`,
      )
      .join('');
  }
  renderVlmChip();
}

function renderPool() {
  const box = $('#imagePool');
  const grid = $('#poolGrid');
  if (!box || !grid) return;
  if (!state.pool.length) {
    box.hidden = true;
    grid.innerHTML = '';
    return;
  }
  box.hidden = false;
  setText('poolCount', String(state.pool.length));
  const current = activeImage();
  grid.innerHTML = state.pool
    .map((item) => {
      const active = item.path === current;
      const score = item.analysis ? item.analysis.score : null;
      const level = item.analysis ? item.analysis.level : '';
      return `<button type="button" class="pool-item${active ? ' active' : ''}" role="option" aria-selected="${active}" data-pool="${escapeHtml(item.path)}" title="${escapeHtml(`${item.name}\n${item.path}`)}">
        <img src="/api/file?path=${encodeURIComponent(item.path)}" alt="${escapeHtml(item.name)}" loading="lazy" />
        ${score != null ? `<span class="pool-score ${escapeHtml(level)}">${score}</span>` : ''}
        <span class="pool-remove" data-pool-remove="${escapeHtml(item.path)}" role="button" tabindex="-1" title="从列表中移除">×</span>
      </button>`;
    })
    .join('');
}

function updatePoolAnalysis(path, analysis) {
  const item = state.pool.find((entry) => entry.path === path);
  if (!item) return;
  item.analysis = analysis;
  renderPool();
}

function addToPool(entry) {
  if (!entry || !entry.path) return;
  const limit = state.limits?.poolSize || 8;
  state.pool = [entry, ...state.pool.filter((item) => item.path !== entry.path)].slice(0, limit);
  renderPool();
}

async function loadPool() {
  try {
    const data = await api('image.pool', { limit: state.limits?.poolSize || 8 });
    const items = (data.pool?.items || []).map((item) => ({ ...item }));
    if (!items.length) return;
    // 保留已有分析结果（按路径合并），避免刷新页面后角标全部消失。
    const known = new Map(state.pool.map((item) => [item.path, item]));
    state.pool = items.map((item) => ({ ...item, analysis: known.get(item.path)?.analysis || null }));
    renderPool();
    const current = activeImage();
    if (current && !state.pool.some((item) => item.path === current)) {
      addToPool({ path: current, name: basename(current), size: 0, mtime: Date.now() });
    }
  } catch {
    // 候选池只是便利功能，加载失败不影响主流程。
  }
}

function selectPoolImage(path) {
  if (!path) return;
  state.selectedImage = path;
  state.config = { ...state.config, lastImage: path };
  state.pixelStats = null;
  state.preparedMesh = null;
  state.analysis = null;
  renderSelections();
  setCallout('meshResult', `当前使用：${basename(path)}。确认档位后点击「② 创建水密工作流」。`, 'ok');
}

async function removeFromPool(path) {
  state.pool = state.pool.filter((item) => item.path !== path);
  renderPool();
  try {
    await api('image.forget', { path });
    if (activeImage() === path) {
      state.selectedImage = '';
      state.config = { ...state.config, lastImage: state.pool[0]?.path || '' };
      renderSelections();
    }
    toast('已从候选池和 input 目录移除', 'ok', 3000);
  } catch (err) {
    toast(`移除失败：${humanizeError(err).title}`, 'warn', 6000);
  }
}

async function probeVlm({ announce = false } = {}) {
  const chip = document.querySelector('.status-chip[data-status="vlm"]');
  if (chip) {
    chip.dataset.state = 'info';
    const label = chip.querySelector('b');
    if (label) label.textContent = '检测中';
  }
  try {
    const data = await api('vlm.status', {});
    state.vlm = data.vlm || null;
  } catch (err) {
    state.vlm = { available: false, endpoint: state.config.vlmUrl || '', error: humanizeError(err).title, models: [], model: '' };
  }
  renderVlmChip();
  const probe = $('#vlmProbeResult');
  if (probe) {
    probe.textContent = state.vlm?.available
      ? `已连接${state.vlm.model ? ` · ${state.vlm.model}` : ''}`
      : state.vlm?.disabled
        ? '未配置（留空即关闭）'
        : `连不上${state.vlm?.error ? ` · ${state.vlm.error}` : ''}`;
    probe.className = state.vlm?.available ? 'vlm-ok' : state.vlm?.disabled ? '' : 'vlm-bad';
  }
  if (announce) {
    toast(
      state.vlm?.available
        ? `视觉模型可用：${state.vlm.model || '已连接'}`
        : state.vlm?.disabled
          ? '视觉模型地址为空，这项可选功能已关闭'
          : `视觉模型不可用：${state.vlm?.error || '未知原因'}`,
      state.vlm?.available ? 'ok' : 'warn',
      6000,
    );
  }
  return state.vlm;
}

async function captionWithVlm() {
  const image = activeImage();
  if (!image) {
    toast('先选一张图，再让视觉模型识别', 'warn');
    return;
  }
  const button = $('#btnVlmCaption');
  if (button) {
    button.disabled = true;
    button.textContent = '识别中…';
  }
  try {
    const data = await api('vlm.caption', { path: image });
    const c = data.caption || {};
    const subjectEl = $('#subject');
    const styleEl = $('#stylePrompt');
    if (subjectEl && c.subject) subjectEl.value = c.subject;
    if (styleEl && (c.style || c.detail)) {
      styleEl.value = [c.style, c.detail].filter(Boolean).join(', ');
    }
    updatePromptCount();
    state.promptSignature = '';
    setCallout(
      'qwenResult',
      `视觉模型（${c.model}，${formatDuration(c.ms)}）已把这张图改写成提示词。可以直接写入工作流，或先改几个词再生成。`,
      'ok',
    );
    toast('已从图片生成提示词', 'ok');
    document.querySelector('#promptCard')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // 顺手把最终提示词规范化一次，让用户看到模型真正收到的文本。
    buildPromptPreview({ silent: true });
  } catch (err) {
    const info = humanizeError(err);
    setCallout('qwenResult', `看图写提示词失败：${info.title}${info.hint ? ` · ${info.hint}` : ''}`, 'error');
    toast(info.title, 'error', 8000);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = '用视觉模型写提示词';
    }
  }
}

/* ------------------------------------------------------------------ *
 * 08 提示词工作台
 * ------------------------------------------------------------------ */

function composePrompt() {
  const subject = $('#subject')?.value?.trim() || '';
  const style = $('#stylePrompt')?.value?.trim() || '';
  return [subject, style].filter(Boolean).join(', ');
}

function promptSignature() {
  return [
    $('#subject')?.value || '',
    $('#stylePrompt')?.value || '',
    $('#avoidPrompt')?.value || '',
    $('#qwenPreset')?.value || '',
  ].join('\u0001');
}

function updatePromptCount() {
  const limit = state.limits?.promptChars || 4000;
  const len = composePrompt().length;
  const el = $('#promptCount');
  if (!el) return;
  el.textContent = `${len} / ${limit}`;
  el.className = len > limit * 0.95 ? 'mono warn' : 'mono';
}

function renderPromptPreview(built) {
  const box = $('#promptPreview');
  if (!box) return;
  if (!built) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  const tags = (built.tags || []).map((t) => `<span class="a-chip warn">${escapeHtml(t)}</span>`).join('');
  const warnings = (built.warnings || [])
    .map((w) => `<li class="finding ${escapeHtml(w.level)}"><span class="finding-dot"></span><div><b>${escapeHtml(w.tag || w.code)}</b><p>${escapeHtml(w.message)}</p></div></li>`)
    .join('');
  box.hidden = false;
  box.innerHTML = `
    <div class="pp-head"><span>模型实际收到的提示词</span><span class="mono">${built.chars} 字符 · ${built.language === 'zh' ? '中文' : '英文'}</span></div>
    <p class="pp-text">${escapeHtml(built.positive)}</p>
    ${tags ? `<div class="analysis-chips">${tags}</div>` : ''}
    ${warnings ? `<ul class="finding-list">${warnings}</ul>` : ''}
    <p class="hint-line">${escapeHtml(built.engineNote || '')}</p>
  `;
}

async function buildPromptPreview({ silent = false } = {}) {
  const subject = $('#subject')?.value?.trim() || '';
  if (!subject) {
    if (!silent) {
      toast('先写一句主体描述', 'warn');
      $('#subject')?.focus();
    }
    return null;
  }
  const button = $('#btnPromptPreview');
  if (button) button.disabled = true;
  try {
    const data = await api('prompt.build', {
      subject,
      style: $('#stylePrompt')?.value || '',
      avoid: $('#avoidPrompt')?.value || '',
      preset: $('#qwenPreset')?.value || '2k',
    });
    state.promptBuilt = data.prompt || null;
    state.promptSignature = promptSignature();
    renderPromptPreview(state.promptBuilt);
    return state.promptBuilt;
  } catch (err) {
    if (!silent) toast(humanizeError(err).title, 'error', 7000);
    return null;
  } finally {
    if (button) button.disabled = false;
  }
}

function applyTemplate(key) {
  const tpl = PROMPT_TEMPLATES[key];
  if (!tpl) return;
  const subjectEl = $('#subject');
  const styleEl = $('#stylePrompt');
  if (subjectEl && !subjectEl.value.trim()) subjectEl.value = tpl.subject;
  if (styleEl) styleEl.value = tpl.style;
  updatePromptCount();
  state.promptSignature = '';
  toast(`已套用模板：${tpl.label}`, 'ok', 3000);
  if (subjectEl && !subjectEl.value.trim()) subjectEl.focus();
}

async function prepareQwen(button) {
  const subject = $('#subject')?.value?.trim() || '';
  if (!subject) {
    toast('先写一句主体描述', 'warn');
    $('#subject')?.focus();
    return;
  }
  // 先做一次规范化：拿到真正会写进工作流的文本，并把风险描述告诉用户。
  let built = null;
  try {
    built = await buildPromptPreview({ silent: true });
  } catch {}
  const prompt = built?.positive || composePrompt();
  const seedRaw = $('#qwenSeed')?.value?.trim() || '';
  const payload = { prompt, preset: $('#qwenPreset')?.value || '2k' };
  if (seedRaw) payload.seed = seedRaw;
  try {
    const data = await runAction('workflow.prepareQwen', payload, button);
    const result = data.result || {};
    const changes = (result.changes || []).slice(0, 4).join('；');
    const warnCount = built?.warnings?.length || 0;
    setCallout(
      'qwenResult',
      `已写入 ${result.fileName}，种子 ${result.seed}。${changes ? ` ${changes}。` : ''}${warnCount ? ` 有 ${warnCount} 条提醒见上方提示词预览。` : ''} 打开 ComfyUI → Workflows → PixelArtistry 运行。`,
      'ok',
    );
    toast('Qwen 工作流已生成', 'ok');
  } catch {}
}

async function prepareMesh(button) {
  if (state.imageUploading || state.meshPreparing) return;
  const image = activeImage();
  if (!image) {
    setCallout('meshResult', '请先在上方选择一张图片，看到预览和文件名后再继续。', 'warn');
    toast('先上传一张生成图', 'warn');
    return;
  }
  const preset = state.meshPreset;
  state.meshPreparing = true;
  state.preparedMesh = null;
  renderMeshFlow();
  setCallout('meshResult', '正在创建水密工作流…');
  try {
    const data = await runAction('workflow.preparePixel', {
      preset,
      imagePath: image,
      imageName: basename(image),
    }, button);
    const result = data.result || {};
    state.preparedMesh = { image, preset, fileName: result.fileName };
    setText('meshWorkflowName', result.fileName);
    const a = state.analysis;
    const note = a && a.level !== 'ok' ? ` 提示：这张图的适配度 ${a.score}，若结果不理想先按分析建议换图。` : '';
    setCallout('meshResult', `工作流创建成功，网格尚未开始生成。请按下方步骤在 ComfyUI 中运行。${note}`, 'ok');
    toast('工作流已准备好，下一步到 ComfyUI 点击 Run', 'ok');
  } catch (err) {
    const info = humanizeError(err);
    setCallout('meshResult', `创建失败：${err.message}`, 'error');
    lastFailedAction = { action: 'workflow.preparePixel', payload: { preset, imagePath: image, imageName: basename(image) }, label: '重试创建工作流' };
    if (info.hint) setText('meshNext', `创建失败后可重试：${info.hint}`);
  } finally {
    state.meshPreparing = false;
    renderMeshFlow();
    renderNextStep();
  }
}

/* ------------------------------------------------------------------ *
 * 09 上传 / 结果 / 事件
 * ------------------------------------------------------------------ */

async function uploadFile(file, kind, { silent = false } = {}) {
  if (!file) return null;
  const isImage = kind === 'input';
  if (isImage && (state.imageUploading || state.meshPreparing)) return null;
  const showError = (message) => {
    if (isImage) setCallout('meshResult', message, 'error');
    if (!silent) toast(message, 'error', 8000);
  };
  const maxMb = kind === 'glb'
    ? Math.floor((state.limits?.uploadGlb || 4 * 1024 ** 3) / 1024 ** 2)
    : kind === 'text'
      ? 1
      : Math.floor((state.limits?.uploadImage || 40 * 1024 ** 2) / 1024 ** 2);
  const valid = kind === 'glb'
    ? /\.(glb|gltf)$/i.test(file.name)
    : kind === 'text'
      ? /\.(txt|md|markdown)$/i.test(file.name)
      : /\.(png|jpe?g|webp)$/i.test(file.name);
  if (!valid) {
    showError(kind === 'glb'
      ? '只接受 .glb / .gltf 文件'
      : kind === 'text'
        ? '只接受 .txt / .md 文本文件'
        : '只接受 png / jpg / webp 图片');
    return null;
  }
  if (file.size > maxMb * 1024 * 1024) {
    showError(`文件过大，限制 ${maxMb} MB`);
    return null;
  }
  if (file.size === 0) {
    showError('文件为空，无法上传');
    return null;
  }
  const url = `/api/upload?kind=${kind}&name=${encodeURIComponent(file.name)}`;
  if (isImage) {
    state.imageUploading = true;
    state.uploadQueue += 1;
    $('#imageDrop')?.setAttribute('aria-busy', 'true');
    if (!silent) setCallout('meshResult', `正在导入 ${file.name} · 0%`);
    renderMeshFlow();
  }
  const progress = silent ? null : toast(`正在上传 ${file.name} · 0%`, 'info', 10 * 60 * 1000);
  try {
    const data = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.timeout = 10 * 60 * 1000;
      xhr.upload.addEventListener('progress', (event) => {
        if (!event.lengthComputable || !progress) return;
        const pct = Math.round((event.loaded / event.total) * 100);
        progress.textContent = `正在上传 ${file.name} · ${pct}%`;
        if (isImage) setCallout('meshResult', `正在导入 ${file.name} · ${pct}%`);
      });
      xhr.addEventListener('load', () => {
        let payload = {};
        try {
          payload = JSON.parse(xhr.responseText || '{}');
        } catch {}
        if (xhr.status < 200 || xhr.status >= 300 || payload.ok === false) {
          const err = new Error(payload.error || `上传失败（HTTP ${xhr.status}）`);
          err.code = payload.code || '';
          err.hint = payload.hint || '';
          reject(err);
          return;
        }
        resolve(payload);
      });
      xhr.addEventListener('error', () => reject(new Error('上传连接中断，请确认本地服务仍在运行。')));
      xhr.addEventListener('timeout', () => reject(new Error('上传超时，请检查磁盘空间或文件大小。')));
      xhr.send(file);
    });
    if (isImage) {
      state.selectedImage = data.path;
      state.preparedMesh = null;
      state.pixelStats = null;
      addToPool({ path: data.path, name: data.name || basename(data.path), size: data.size, mtime: Date.now() });
      setCallout('meshResult', `图片已导入：${basename(data.path)}。已加入候选池，请选择档位后点击「② 创建水密工作流」。`, 'ok');
    } else if (kind === 'glb') {
      state.selectedGlb = data.path;
      const glbPath = $('#glbPath');
      if (glbPath) glbPath.value = data.path;
      setCallout('meshResult', `GLB 已导入：${data.path}`, 'ok');
    }
    if (kind !== 'text') {
      state.config = { ...state.config, [isImage ? 'lastImage' : 'lastGlb']: data.path };
    }
    renderSelections();
    progress?.remove();
    if (!silent) toast(`已上传 ${file.name} · ${formatBytes(data.size)}`, 'ok');
    if (isImage) setTimeout(() => inspectActiveImage({ silent: true }), 60);
    return data;
  } catch (err) {
    progress?.remove();
    showError(`导入失败：${err.message}`);
    return null;
  } finally {
    if (isImage) {
      state.uploadQueue = Math.max(0, state.uploadQueue - 1);
      state.imageUploading = state.uploadQueue > 0;
      $('#imageDrop')?.setAttribute('aria-busy', state.imageUploading ? 'true' : 'false');
      renderMeshFlow();
    }
  }
}

async function uploadMany(files, kind) {
  const list = [...files];
  if (!list.length) return;
  if (kind === 'input' && list.length > 1) {
    const limit = state.limits?.poolSize || 8;
    const batch = list.slice(0, limit);
    let ok = 0;
    for (const file of batch) {
      // 串行上传：并行会同时抢 input 目录与预览状态，进度提示也会互相覆盖。
      const result = await uploadFile(file, kind, { silent: true });
      if (result) ok += 1;
    }
    toast(`已导入 ${ok} / ${batch.length} 张，点缩略图切换当前使用的图片`, ok ? 'ok' : 'error', 6000);
    return;
  }
  for (const file of list) await uploadFile(file, kind);
}

async function importPromptFile(file) {
  if (!file) return;
  const data = await uploadFile(file, 'text', { silent: true });
  if (!data?.text) {
    if (data) toast('文件已上传，但没有读到内容', 'warn');
    return;
  }
  const text = String(data.text).trim();
  if (!text) {
    toast('这个文件是空的', 'warn');
    return;
  }
  const subjectEl = $('#subject');
  const styleEl = $('#stylePrompt');
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (subjectEl) subjectEl.value = lines[0].slice(0, 600);
  if (styleEl) styleEl.value = (lines.slice(1).join('\n') || text).slice(0, 1600);
  updatePromptCount();
  state.promptSignature = '';
  setCallout('qwenResult', `已从 ${data.name} 读入提示词：第一行作为主体，其余作为风格描述。`, 'ok');
  toast('提示词已导入', 'ok');
}

function bindDropzone(zoneId, inputId, kind, { multiple = false } = {}) {
  const zone = document.getElementById(zoneId);
  const input = document.getElementById(inputId);
  if (!zone || !input) return;
  // The zone is a div with a click handler, which mouse users could operate but
  // keyboard and screen-reader users could not. role/tabindex plus an explicit
  // Enter/Space handler make it behave like the button it visually is.
  if (!zone.hasAttribute('role')) zone.setAttribute('role', 'button');
  if (!zone.hasAttribute('tabindex')) zone.setAttribute('tabindex', '0');
  if (!zone.hasAttribute('aria-label')) {
    zone.setAttribute('aria-label', kind === 'glb' ? '选择或拖入 GLB 文件' : '选择或拖入图片');
  }
  if (multiple) input.setAttribute('multiple', '');
  zone.addEventListener('click', (event) => {
    if (event.target === input) return;
    input.click();
  });
  zone.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    input.click();
  });
  input.addEventListener('change', () => {
    const files = input.files ? [...input.files] : [];
    if (files.length) uploadMany(files, kind);
    input.value = '';
  });
  for (const evt of ['dragenter', 'dragover']) {
    zone.addEventListener(evt, (event) => {
      event.preventDefault();
      zone.classList.add('dragover');
    });
  }
  for (const evt of ['dragleave', 'drop']) {
    zone.addEventListener(evt, (event) => {
      event.preventDefault();
      zone.classList.remove('dragover');
    });
  }
  zone.addEventListener('drop', (event) => {
    const files = event.dataTransfer?.files;
    if (files && files.length) uploadMany(files, kind);
  });
}

function renderArtifacts(payload) {
  const box = $('#artifacts');
  const list = $('#artifactList');
  if (!box || !list) return;
  const items = payload?.items || [];
  if (!items.length) {
    box.hidden = true;
    list.innerHTML = '';
    return;
  }
  box.hidden = false;
  list.innerHTML = items
    .map((item) => {
      const isStl = item.kind === 'stl';
      const href = isStl
        ? `/api/download?path=${encodeURIComponent(item.path)}`
        : `/api/file?path=${encodeURIComponent(item.path)}`;
      return `<li>
        <span class="artifact-kind ${isStl ? 'stl' : 'report'}">${isStl ? 'STL' : '报告'}</span>
        <a class="artifact-name" href="${href}"${isStl ? ' download' : ' target="_blank" rel="noreferrer"'} title="${escapeHtml(item.path)}">${escapeHtml(item.name)}</a>
        <span class="artifact-meta">${escapeHtml(formatBytes(item.size))} · ${escapeHtml(formatStamp(item.mtime))}</span>
      </li>`;
    })
    .join('');
}

async function loadArtifacts() {
  try {
    const data = await api('artifacts.list', { limit: 10 });
    renderArtifacts(data);
  } catch {
    // A failed listing must not disturb the main workflow.
  }
}

function renderResult(result) {
  state.lastResult = result;
  const analysis = result.analysis || null;
  const final = result.blenderReport?.final || null;
  const dims = analysis?.dimensionsMm || final?.dimensionsMm || [];
  const maxDim = dims.length ? Math.max(...dims) : null;
  const watertight = result.watertight ?? final?.watertight ?? analysis?.watertight ?? null;

  const big = $('#resultBig');
  if (big) {
    if (maxDim != null) big.innerHTML = `${Number(maxDim).toFixed(1)}<small>mm</small>`;
    else big.textContent = '—';
  }
  setText('resultLabel', result.stl ? basename(result.stl) : 'STL 已生成');

  const tag = $('#watertightTag');
  if (tag) {
    tag.className = `tag ${watertight === true ? 'ok' : watertight === false ? 'fail' : 'warn'}`;
    tag.textContent = watertight === true ? '水密 · 可切片' : watertight === false ? '未完全水密' : '未深度检查';
  }

  const cells = [
    ['尺寸', dims.length ? `${dims.map((n) => Number(n).toFixed(1)).join(' × ')} mm` : '—'],
    ['三角面', analysis?.triangles != null ? Number(analysis.triangles).toLocaleString() : final?.triangles != null ? Number(final.triangles).toLocaleString() : '—'],
    ['体积', analysis?.volumeMm3 != null ? `${(analysis.volumeMm3 / 1000).toFixed(2)} cm³` : final?.volumeMm3 != null ? `${(final.volumeMm3 / 1000).toFixed(2)} cm³` : '—'],
    ['边界边', analysis?.boundaryEdges ?? final?.boundaryEdges ?? '—'],
    ['非流形边', analysis?.nonManifoldEdges ?? final?.nonManifoldEdges ?? '—'],
    ['文件大小', analysis?.fileSize ? formatBytes(analysis.fileSize) : '—'],
  ];
  const metrics = $('#resultMetrics');
  if (metrics) metrics.innerHTML = cells.map(([k, v]) => `<div><span>${k}</span><b>${escapeHtml(v)}</b></div>`).join('');

  const warnings = $('#resultWarnings');
  if (warnings) {
    warnings.innerHTML = '';
    for (const text of result.warnings || []) {
      const node = document.createElement('div');
      node.className = 'warning-item';
      node.textContent = text;
      warnings.append(node);
    }
  }

  if (result.stl) {
    const link = $('#btnDownloadStl');
    if (link) {
      link.href = `/api/download?path=${encodeURIComponent(result.stl)}`;
      link.classList.remove('disabled');
    }
    setText('reportNote', result.report || result.stl);
    const note = $('#reportNote');
    if (note) note.title = result.report || '';
  }
  renderNextStep();
}

let settingsReturnFocus = null;

function openSettings() {
  renderSettings();
  settingsReturnFocus = document.activeElement;
  $('#settingsDrawer')?.setAttribute('aria-hidden', 'false');
  $('#drawerBackdrop')?.classList.add('show');
  setTimeout(() => $('#cfgInstallRoot')?.focus(), 30);
}

function closeSettings() {
  const drawer = $('#settingsDrawer');
  if (!drawer || drawer.getAttribute('aria-hidden') === 'true') return;
  drawer.setAttribute('aria-hidden', 'true');
  $('#drawerBackdrop')?.classList.remove('show');
  if (settingsReturnFocus instanceof HTMLElement) settingsReturnFocus.focus();
  settingsReturnFocus = null;
}

function trapSettingsFocus(event) {
  const drawer = $('#settingsDrawer');
  if (!drawer || event.key !== 'Tab' || drawer.getAttribute('aria-hidden') === 'true') return;
  const nodes = [...drawer.querySelectorAll('button, input, select, textarea, a[href]')].filter(
    (node) => !node.disabled && node.offsetParent !== null,
  );
  if (!nodes.length) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

async function saveSettings() {
  const patch = {
    installRoot: $('#cfgInstallRoot').value.trim(),
    comfyuiRoot: $('#cfgComfyRoot').value.trim(),
    blenderPath: $('#cfgBlender').value.trim(),
    chituboxPath: $('#cfgChitubox').value.trim(),
    targetHeightMm: Number($('#cfgHeight').value) || 80,
    repairMode: $('#cfgRepair').value,
    vlmUrl: $('#cfgVlmUrl')?.value.trim() || '',
    vlmModel: $('#cfgVlmModel')?.value.trim() || '',
  };
  // 留空不改已保存的密钥；输入了新 Key 就随设置一起保存，避免用户点
  // 「保存设置」时以为保存了、实际却丢掉。
  const keyInput = $('#cfgVlmApiKey');
  if (keyInput?.value.trim()) patch.vlmApiKey = keyInput.value.trim();
  try {
    const data = await api('config.save', { patch });
    state.config = data.config || state.config;
    if (keyInput) {
      keyInput.value = '';
      keyInput.placeholder = state.config.vlmHasKey ? '已保存（留空保持不变）' : '留空表示不需要鉴权';
    }
    // Explicit save: stored defaults are now the user's intent, so let the
    // post-process panel pick them up again.
    clearTouched();
    renderSelections();
    toast('设置已保存', 'ok');
    closeSettings();
    await refreshState({ silent: true });
    probeVlm();
  } catch (err) {
    toast(humanizeError(err).title, 'error');
  }
}

async function handleAction(button) {
  const action = button.dataset.action;
  const payload = {};
  if (button.dataset.target) payload.target = button.dataset.target;
  if (button.dataset.kind) payload.kind = button.dataset.kind;
  if (button.dataset.path) payload.path = button.dataset.path;
  if (action === 'install.oneclick') {
    payload.includeQwen = $('#oneClickQwen')?.checked === true;
    payload.reuseModels = $('#oneClickReuse')?.checked !== false;
  }

  switch (action) {
    case 'comfy.latestGlb': {
      try {
        const data = await runAction(action, payload, button);
        const path = data.path || data.result?.path;
        if (path) {
          state.selectedGlb = path;
          const glbPath = $('#glbPath');
          if (glbPath) glbPath.value = path;
          renderSelections();
          setCallout('meshResult', `已导入最新 GLB：${path}`, 'ok');
          toast('已导入 ComfyUI 最新 GLB', 'ok');
        }
        await refreshState({ silent: true });
      } catch {}
      return;
    }
    case 'shortcut.create': {
      try {
        const data = await runAction(action, payload, button);
        toast(data.message || '桌面快捷方式已创建', 'ok', 6000);
      } catch {}
      return;
    }
    case 'install.workflows': {
      try {
        const data = await runAction(action, payload, button);
        const result = data.result || {};
        toast(`已写入 ${result.copied?.length || 0} 个工作流`, 'ok');
        await recheck();
      } catch {}
      return;
    }
    case 'open.path':
    case 'open.url':
    case 'folder.open':
    case 'download.open':
    case 'comfy.open':
    case 'chitubox.open': {
      try {
        await runAction(action, payload, button);
        toast(action === 'download.open' ? '已在浏览器打开下载页' : '已打开', 'ok', 2500);
      } catch {}
      return;
    }
    default: {
      try {
        await runAction(action, payload, button);
        if (action.startsWith('install.') || action.startsWith('comfy.')) {
          await recheck();
        }
      } catch {}
    }
  }
}

/* ------------------------------------------------------------------ *
 * 10 事件绑定与启动
 * ------------------------------------------------------------------ */

function bindEvents() {
  document.addEventListener('click', (event) => {
    const scroll = event.target.closest('[data-scroll]');
    if (scroll) {
      document.querySelector(scroll.dataset.scroll)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const poolRemove = event.target.closest('[data-pool-remove]');
    if (poolRemove) {
      event.preventDefault();
      event.stopPropagation();
      removeFromPool(poolRemove.dataset.poolRemove);
      return;
    }
    const poolItem = event.target.closest('[data-pool]');
    if (poolItem) {
      event.preventDefault();
      selectPoolImage(poolItem.dataset.pool);
      return;
    }
    const template = event.target.closest('[data-template]');
    if (template) {
      applyTemplate(template.dataset.template);
      return;
    }
    const actionButton = event.target.closest('[data-action]');
    if (actionButton) {
      event.preventDefault();
      handleAction(actionButton);
    }
  });

  $('#btnRecheck').addEventListener('click', recheck);
  $('#btnOneClick').addEventListener('click', startOneClick);
  $$('[data-deploy-mode]').forEach((button) => {
    button.addEventListener('click', () => setDeployMode(button.dataset.deployMode));
  });
  $('#btnDeployDoctor').addEventListener('click', () => runDeployDoctor({ auto: false }).catch(() => {}));
  $('#btnDoctorCopy').addEventListener('click', async () => {
    if (!state.doctor) {
      toast('请先运行一次部署自检。', 'warn');
      return;
    }
    const text = doctorToText(state.doctor);
    try {
      if (await copyText(text)) {
        toast('自检报告已复制，可直接粘贴到排错记录中。', 'ok', 6000);
      } else if (downloadText(text, `ai3d-doctor-${Date.now()}.txt`)) {
        toast('剪贴板不可用，已下载自检报告文件。', 'warn', 8000);
      } else {
        toast('无法写入剪贴板或下载报告，请展开自检结果手动复制。', 'warn', 8000);
      }
    } catch {
      toast('复制自检报告失败，请手动选择文本。', 'warn', 8000);
    }
  });
  $('#oneClickReuse').addEventListener('change', () => {
    renderReuseHint();
    if ($('#oneClickReuse').checked && !state.reuse) scanModels();
  });
  $('#btnCancelJob').addEventListener('click', () => cancelCurrentJob(state.jobId));
  $('#btnOneClickCancel').addEventListener('click', () => cancelCurrentJob(state.oneClickJobId || state.jobId));
  $('#btnConnectionRetry').addEventListener('click', async () => {
    const data = await refreshState({ silent: true });
    if (data) {
      const running = (data.jobs || []).find((job) => job.status === 'running');
      if (running) watchJob(running.id);
      toast('本地服务连接已恢复', 'ok');
      await recheck();
    } else {
      toast('仍无法连接本地服务。请确认启动窗口还在运行，然后刷新页面。', 'error', 9000);
    }
  });
  $('#btnCopyDiagnostics').addEventListener('click', copyDiagnostics);
  $('#btnOneClickLog').addEventListener('click', () => {
    state.oneClickLogOpen = !state.oneClickLogOpen;
    if (state.oneClickJob) renderOneClick(state.oneClickJob);
  });
  $('#btnSettings').addEventListener('click', openSettings);
  $('#btnCloseSettings').addEventListener('click', closeSettings);
  $('#drawerBackdrop').addEventListener('click', closeSettings);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSettings();
    trapSettingsFocus(event);
    // Ctrl/Cmd + Enter：执行当前最关键的「下一步」。
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      const active = document.activeElement;
      if (active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) {
        event.preventDefault();
        if (active.id === 'subject' || active.id === 'stylePrompt' || active.id === 'avoidPrompt') {
          $('#btnPrepareQwen')?.click();
          return;
        }
      }
      event.preventDefault();
      runNextStep();
    }
  });

  $('#btnSaveSettings').addEventListener('click', saveSettings);
  $('#btnVlmProbe')?.addEventListener('click', async () => {
    // 先保存，再用新地址探测，避免「检测的是旧配置」。
    const url = $('#cfgVlmUrl')?.value.trim() || '';
    const model = $('#cfgVlmModel')?.value.trim() || '';
    const keyInput = $('#cfgVlmApiKey');
    const patch = { vlmUrl: url, vlmModel: model };
    // 留空 = 不修改已保存的密钥；要清除请点「清除密钥」。
    if (keyInput?.value.trim()) patch.vlmApiKey = keyInput.value.trim();
    try {
      await api('config.save', { patch });
      state.config = { ...state.config, vlmUrl: url, vlmModel: model, vlmHasKey: Boolean(patch.vlmApiKey || state.config.vlmHasKey) };
      if (keyInput) {
        keyInput.value = '';
        keyInput.placeholder = state.config.vlmHasKey ? '已保存（留空保持不变）' : '留空表示不需要鉴权';
      }
      await probeVlm({ announce: true });
    } catch (err) {
      toast(humanizeError(err).title, 'error', 7000);
    }
  });
  $('#btnVlmClearKey')?.addEventListener('click', async () => {
    try {
      await api('config.save', { patch: { vlmApiKey: '' } });
      state.config = { ...state.config, vlmHasKey: false };
      const input = $('#cfgVlmApiKey');
      if (input) {
        input.value = '';
        input.placeholder = '留空表示不需要鉴权';
      }
      toast('已清除视觉模型 API Key', 'ok', 4000);
    } catch (err) {
      toast(humanizeError(err).title, 'error', 7000);
    }
  });

  $('#btnPrepareQwen').addEventListener('click', (event) => prepareQwen(event.currentTarget));
  $('#btnPrepareMesh').addEventListener('click', (event) => prepareMesh(event.currentTarget));
  $('#btnPromptPreview')?.addEventListener('click', () => buildPromptPreview());
  $('#btnRandomSeed')?.addEventListener('click', () => {
    const el = $('#qwenSeed');
    if (el) el.value = String(Math.floor(Math.random() * 9e14) + 1);
    toast('已生成新的随机种子', 'ok', 2200);
  });
  for (const id of ['subject', 'stylePrompt', 'avoidPrompt']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('input', () => {
      updatePromptCount();
      // 输入变化后旧的预览已失效，避免用户按着过期的文本做判断。
      if (state.promptBuilt) {
        state.promptBuilt = null;
        renderPromptPreview(null);
      }
    });
  }
  $('#qwenPreset')?.addEventListener('change', updatePromptCount);
  $('#btnLoadPromptFile')?.addEventListener('click', () => $('#promptFileInput')?.click());
  $('#promptFileInput')?.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) importPromptFile(file);
    event.target.value = '';
  });

  $('#btnCopyPrompt').addEventListener('click', async () => {
    const prompt = state.promptBuilt?.positive || composePrompt();
    if (!prompt) {
      toast('提示词为空', 'warn');
      return;
    }
    try {
      const copied = await copyText(prompt);
      if (copied) toast('提示词已复制', 'ok');
      else toast('浏览器拒绝了剪贴板权限，请手动复制', 'warn');
    } catch {
      toast('浏览器拒绝了剪贴板权限，请手动复制', 'warn');
    }
  });

  $$('#meshPreset button').forEach((button) => {
    button.addEventListener('click', () => updatePreset(button.dataset.preset));
  });

  $('#btnReinspect')?.addEventListener('click', () => {
    state.pixelStats = null;
    state.inspectedPreset = '';
    inspectActiveImage({ silent: false });
  });
  $('#btnVlmCaption')?.addEventListener('click', captionWithVlm);
  $('#btnPoolClear')?.addEventListener('click', () => {
    state.pool = [];
    renderPool();
    toast('已清空候选池列表（不会删除文件）', 'ok', 3000);
  });

  $('#btnBrowseGlb').addEventListener('click', async () => {
    try {
      const data = await api('file.pick', { kind: 'glb' });
      if (data.path) {
        state.selectedGlb = data.path;
        $('#glbPath').value = data.path;
        renderSelections();
        toast('已选择 GLB', 'ok');
      }
    } catch (err) {
      toast(humanizeError(err).title, 'error');
    }
  });

  $('#glbPath').addEventListener('change', (event) => {
    state.selectedGlb = event.target.value.trim();
    renderSelections();
  });

  // Remember manual edits so a background refresh cannot revert them.
  for (const id of ['targetHeight', 'repairMode', 'decimateRatio', 'glbPath']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('input', () => markTouched(id));
    el.addEventListener('change', () => markTouched(id));
  }

  $('#btnPostprocess').addEventListener('click', async (event) => {
    const input = $('#glbPath').value.trim() || state.selectedGlb || state.config.lastGlb;
    if (!input) {
      toast('先导入或选择 GLB', 'warn');
      return;
    }
    const payload = {
      input,
      targetHeightMm: Number($('#targetHeight').value) || 0,
      repairMode: $('#repairMode').value,
      decimateRatio: Number($('#decimateRatio').value) || 0,
      keepLargest: $('#keepLargest').checked,
    };
    try {
      const data = await runAction('postprocess.run', payload, event.currentTarget);
      if (data.jobId) toast('Blender 已开始处理，进度见底部任务栏', 'info');
    } catch {}
  });

  $('#btnOpenStlFolder').addEventListener('click', async () => {
    try {
      await api('folder.open', { target: 'stl' });
    } catch (err) {
      toast(humanizeError(err).title, 'error');
    }
  });

  $('#btnArtifactsRefresh')?.addEventListener('click', () => loadArtifacts());

  $('#btnToggleLog').addEventListener('click', () => {
    state.jobLogOpen = !state.jobLogOpen;
    if (state.jobId) {
      apiGet(`/api/job?id=${encodeURIComponent(state.jobId)}`)
        .then((data) => renderJob(data.job))
        .catch(() => {});
    }
  });

  $('#btnHideJob').addEventListener('click', () => {
    $('#jobbar')?.classList.remove('show');
  });
  $('#btnJobRetry')?.addEventListener('click', retryLastJob);
  $('#btnJobCopyError')?.addEventListener('click', async () => {
    const info = state.jobError;
    if (!info) return;
    const text = [info.title, info.detail, info.hint].filter(Boolean).join('\n');
    if (await copyText(text)) toast('错误信息已复制', 'ok', 3000);
    else toast('浏览器拒绝了剪贴板权限，请手动选择文本', 'warn', 6000);
  });
  $('#btnJobDismissError')?.addEventListener('click', () => {
    const box = $('#jobError');
    if (box) box.hidden = true;
  });

  $('#nextStepBtn')?.addEventListener('click', runNextStep);
  $('#btnHideNextStep')?.addEventListener('click', () => {
    state.nextStepHidden = true;
    try {
      localStorage.setItem(NEXT_STEP_KEY, '1');
    } catch {}
    renderNextStep();
  });

  $$('.status-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const key = chip.dataset.status;
      if (key === 'vlm') {
        openSettings();
        probeVlm({ announce: true });
        return;
      }
      const group = key === 'trellis' ? 'trellis' : key === 'gpu' ? '' : key;
      const target = group ? document.querySelector(`[data-check-group="${group}"]`) : null;
      (target || document.querySelector('#deploy'))?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (target && target.animate) {
        target.animate(
          [
            { borderColor: 'rgba(255,107,44,0.9)', boxShadow: '0 0 0 3px rgba(255,107,44,0.16)' },
            { borderColor: '', boxShadow: '' },
          ],
          { duration: 1400, easing: 'ease-out' },
        );
      }
    });
  });

  bindDropzone('imageDrop', 'imageInput', 'input', { multiple: true });
  bindDropzone('glbDrop', 'glbInput', 'glb');
  $('#imagePreview').addEventListener('error', () => {
    $('#imagePreview').hidden = true;
    setText('imagePreviewError', '预览无法读取，请重新选择图片。');
  });
  $('#imagePreview').addEventListener('load', () => {
    $('#imagePreview').hidden = false;
    setText('imagePreviewError', '');
  });

  // Ctrl+V 粘贴截图 / 图片：比「保存到桌面再拖进来」少两步。
  document.addEventListener('paste', (event) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
      if (item.kind === 'file' && /^image\//i.test(item.type)) {
        const file = item.getAsFile();
        if (file) {
          const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
          files.push(new File([file], `paste-${Date.now()}.${ext}`, { type: file.type }));
        }
      }
    }
    if (!files.length) return;
    event.preventDefault();
    uploadMany(files, 'input');
    toast(`已粘贴 ${files.length} 张图片`, 'ok', 3000);
  });

  // 全局异常：不弹窗打扰，但落进 server.log，诊断信息里能看到。
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('error', (event) => {
      reportClientError('window.error', event.error || event.message);
    });
    window.addEventListener('unhandledrejection', (event) => {
      reportClientError('unhandledrejection', event.reason);
    });
  }
}

async function init() {
  bindEvents();
  updatePreset(state.config.preset || '1.5k');
  let savedMode = '';
  let nextHidden = '';
  try {
    savedMode = localStorage.getItem(DEPLOY_MODE_KEY) || '';
    nextHidden = localStorage.getItem(NEXT_STEP_KEY) || '';
  } catch {}
  state.nextStepHidden = nextHidden === '1';
  setDeployMode(savedMode || 'oneclick', { persist: false });
  updatePromptCount();
  scanModels();
  probeVlm();
  const data = await refreshState();
  loadArtifacts();
  loadPool();
  if (data?.config?.lastPrompt) {
    // 上次写进工作流的提示词：放进风格框不合适，只作为占位提示。
    const subject = $('#subject');
    if (subject && !subject.value) subject.placeholder = `上次使用：${String(data.config.lastPrompt).slice(0, 80)}…`;
  }
  const jobs = data?.jobs || [];
  const running = jobs.find((job) => job.status === 'running' && job.type === 'install.oneclick')
    || jobs.find((job) => job.status === 'running');
  if (running) {
    if (running.type === 'install.oneclick') {
      state.oneClickJobId = running.id;
      setDeployMode('oneclick', { persist: false });
      const panel = $('#oneClickProgress');
      if (panel) panel.hidden = false;
    }
    // Re-attach to a job that survived a page refresh.
    watchJob(running.id);
  } else {
    const latestOneClick = jobs
      .filter((job) => job.type === 'install.oneclick')
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
    if (latestOneClick) renderOneClick(latestOneClick);
  }
  if (window.location.hash === '#deploy') {
    setTimeout(() => document.querySelector('#deploy')?.scrollIntoView({ behavior: 'smooth' }), 300);
  }
  renderNextStep();
}

init();
