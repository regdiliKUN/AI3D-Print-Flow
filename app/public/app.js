const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  config: {},
  checks: null,
  selectedImage: '',
  selectedGlb: '',
  imageUploading: false,
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
  toastTimer: null,
  rechecking: false,
  lastError: '',
};

const PRESET_HINTS = {
  '1k': { proxy: '8,000,000', res: '1024', note: '6–8 GB 显存' },
  '1.5k': { proxy: '12,000,000', res: '1536', note: '8–16 GB 显存' },
  '2k': { proxy: '25,000,000', res: '2048', note: '16 GB+ 显存 / 32 GB+ 内存' },
};

const CHECK_MAP = {
  gpu: ['gpu'],
  comfy: ['comfy'],
  trellis: ['trellis.node', 'comfy.torch'],
  blender: ['blender'],
  chitubox: ['chitubox'],
};

function initials(text) {
  return String(text || '').slice(0, 80);
}

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

function toast(message, kind = 'info', timeout = 4200) {
  const wrap = $('#toastWrap');
  if (!wrap) return null;
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  node.textContent = message;
  wrap.append(node);
  const remove = () => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 200);
  };
  setTimeout(remove, timeout);
  node.addEventListener('click', remove);
  return node;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      hero.textContent = '环境已就绪：可以开始生成图片与 3D 网格。';
    } else {
      const s = state.checks.summary || {};
      hero.textContent = `还有 ${s.fail || 0} 项阻塞、${s.warn || 0} 项注意。按「环境部署」顺序完成即可。`;
    }
  }
}

function renderSettings() {
  const c = state.config || {};
  $('#cfgInstallRoot').value = c.installRoot || '';
  $('#cfgComfyRoot').value = c.comfyuiRoot || '';
  $('#cfgBlender').value = c.blenderPath || '';
  $('#cfgChitubox').value = c.chituboxPath || '';
  $('#cfgHeight').value = c.targetHeightMm ?? 80;
  $('#cfgRepair').value = c.repairMode || 'auto';
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

function renderSelections() {
  const image = state.selectedImage || state.config.lastImage || '';
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
}

function renderMeshFlow() {
  const image = state.selectedImage || state.config.lastImage || '';
  if (state.preparedMesh && (state.preparedMesh.image !== image || state.preparedMesh.preset !== state.meshPreset)) {
    state.preparedMesh = null;
  }
  const button = $('#btnPrepareMesh');
  if (button) {
    button.disabled = !image || state.imageUploading || state.meshPreparing;
    button.textContent = state.imageUploading ? '正在导入图片…'
      : state.meshPreparing ? '正在创建工作流…' : '② 创建水密工作流';
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
  link.href = href;
  link.classList.remove('disabled');
  setText('resultLabel', `上次生成：${basename(stl)}`);
  setText('resultBig', '—');
  setText('reportNote', stl);
}

function jobDetailText(job) {
  if (job.detail) return job.detail;
  if (job.bytes != null && job.bytes > 0) {
    const total = job.totalBytes ? ` / ${formatBytes(job.totalBytes)}` : '';
    return `${formatBytes(job.bytes)}${total}`;
  }
  return '';
}

function renderJob(job) {
  if (!job) return;
  const bar = $('#jobbar');
  bar.classList.add('show');
  setText('jobTitle', job.title || '任务');
  setText('jobMessage', job.message || '');
  setText('jobPercent', `${Math.round(job.progress || 0)}%`);
  const spinner = $('#jobSpinner');
  spinner.className = `spinner ${job.status === 'running' ? '' : job.status}`.trim();
  const progress = $('#jobProgress');
  progress.style.width = `${Math.max(0, Math.min(100, job.progress || 0))}%`;
  const track = progress.parentElement;
  track.classList.toggle('indeterminate', !!job.indeterminate && job.status === 'running');
  track.classList.toggle('error', job.status === 'error');
  track.classList.toggle('done', job.status === 'done');
  setText('jobDetail', jobDetailText(job));
  const progressBar = $('#jobProgressBar');
  if (progressBar) {
    progressBar.setAttribute('aria-valuenow', String(Math.round(job.progress || 0)));
    progressBar.setAttribute('aria-valuetext', `${job.message || '任务'}，${Math.round(job.progress || 0)}%`);
    progressBar.classList.toggle('indeterminate', !!job.indeterminate && job.status === 'running');
    progressBar.classList.toggle('error', job.status === 'error');
    progressBar.classList.toggle('done', job.status === 'done');
  }
  const log = $('#jobLog');
  if (state.jobLogOpen) {
    log.hidden = false;
    const lines = (job.logs || []).slice(-120).map((entry) => `[${new Date(entry.t).toLocaleTimeString()}] ${entry.text}`);
    log.textContent = lines.join('\n') || '暂无日志';
    log.scrollTop = log.scrollHeight;
  } else {
    log.hidden = true;
  }
  const toggle = $('#btnToggleLog');
  toggle.textContent = state.jobLogOpen ? '收起日志' : '展开日志';
  toggle.setAttribute('aria-expanded', String(state.jobLogOpen));
  const cancel = $('#btnCancelJob');
  if (cancel) cancel.hidden = job.status !== 'running';
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
  const detail = jobDetailText(job);
  setText('oneClickDetail', detail);
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
    errorBox.textContent = show ? job.error : '';
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
      hint.textContent = `本机模型扫描失败：${err.message}`;
    }
    if (!silent) toast(`模型扫描失败：${err.message}`, 'warn', 8000);
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
    toast(`部署自检失败：${err.message}`, 'error', 9000);
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
  $('#jobbar').classList.add('show');
}

function hideJobbarLater(delay = 5200) {
  setTimeout(() => {
    if (state.jobTimer) return;
    $('#jobbar').classList.remove('show');
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
    toast(err.message, 'error', 8000);
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
        toast(job.error || job.message || '任务失败', 'error', 9000);
      } else if (job.status === 'cancelled') {
        toast('任务已取消', 'warn');
      } else if (job.type === 'install.oneclick') {
        toast('一键部署完成。正在运行部署后自检…', 'ok', 9000);
      } else {
        toast(job.message || '任务完成', 'ok');
      }
      await refreshState({ silent: true });
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
      toast(`${err.message} 任务可能仍在后台运行，请稍后点「重新检查」。`, 'error', 9000);
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
      $('#oneClickProgress').hidden = false;
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
      if (action === 'install.oneclick') {
        state.oneClickJobId = data.jobId;
        $('#oneClickProgress').hidden = false;
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
    toast(err.message, 'error', 8500);
    if (optimistic) hideJobbarLater(3000);
    throw err;
  } finally {
    if (button) button.disabled = false;
  }
}

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
    if (!silent) setText('heroStatus', state.checks?.ready ? '环境已就绪：可以开始生成图片与 3D 网格。' : '环境尚未就绪，请先完成部署。');
    return data;
  } catch (err) {
    setConnection(false, err.message);
    if (!silent) toast(err.message, 'error', 9000);
    return null;
  }
}

async function recheck() {
  if (state.rechecking) return;
  const button = $('#btnRecheck');
  state.rechecking = true;
  button.disabled = true;
  button.textContent = '检测中…';
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
    toast(err.message, 'error', 10000);
    setText('heroStatus', err.network ? '本地服务连接中断：请确认启动窗口还在运行。' : `检测失败：${err.message}`);
  } finally {
    state.rechecking = false;
    button.disabled = false;
    button.textContent = '重新检查';
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

function updatePreset(preset) {
  state.meshPreset = preset;
  $$('#meshPreset button').forEach((b) => b.classList.toggle('active', b.dataset.preset === preset));
  const hint = PRESET_HINTS[preset] || PRESET_HINTS['1.5k'];
  setText('proxyHint', hint.proxy);
  setText('resHint', hint.res);
  renderMeshFlow();
}

async function uploadFile(file, kind) {
  if (!file) return;
  const isImage = kind === 'input';
  if (isImage && (state.imageUploading || state.meshPreparing)) return;
  const showError = (message) => {
    if (isImage) setCallout('meshResult', message, 'error');
    toast(message, 'error', 8000);
  };
  const maxMb = kind === 'glb' ? 1024 : 40;
  const valid = kind === 'glb' ? /\.(glb|gltf)$/i.test(file.name) : /\.(png|jpe?g|webp)$/i.test(file.name);
  if (!valid) {
    showError(kind === 'glb' ? '只接受 .glb / .gltf 文件' : '只接受 png / jpg / webp 图片');
    return;
  }
  if (file.size > maxMb * 1024 * 1024) {
    showError(`文件过大，限制 ${maxMb} MB`);
    return;
  }
  if (file.size === 0) {
    showError('文件为空，无法上传');
    return;
  }
  const url = `/api/upload?kind=${kind}&name=${encodeURIComponent(file.name)}`;
  if (isImage) {
    state.imageUploading = true;
    $('#imageDrop').setAttribute('aria-busy', 'true');
    setCallout('meshResult', `正在导入 ${file.name} · 0%`);
    renderMeshFlow();
  }
  const progress = toast(`正在上传 ${file.name} · 0%`, 'info', 10 * 60 * 1000);
  try {
    const data = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.timeout = 10 * 60 * 1000;
      xhr.upload.addEventListener('progress', (event) => {
        if (!event.lengthComputable || !progress) return;
        progress.textContent = `正在上传 ${file.name} · ${Math.round((event.loaded / event.total) * 100)}%`;
        if (isImage) setCallout('meshResult', `正在导入 ${file.name} · ${Math.round((event.loaded / event.total) * 100)}%`);
      });
      xhr.addEventListener('load', () => {
        let payload = {};
        try {
          payload = JSON.parse(xhr.responseText || '{}');
        } catch {}
        if (xhr.status < 200 || xhr.status >= 300 || payload.ok === false) {
          reject(new Error(payload.error || `上传失败（HTTP ${xhr.status}）`));
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
      setCallout('meshResult', `图片已导入：${basename(data.path)}。请选择档位，然后点击「② 创建水密工作流」。`, 'ok');
    } else {
      state.selectedGlb = data.path;
      $('#glbPath').value = data.path;
      setCallout('meshResult', `GLB 已导入：${data.path}`, 'ok');
    }
    state.config = { ...state.config, [isImage ? 'lastImage' : 'lastGlb']: data.path };
    renderSelections();
    progress?.remove();
    toast(`已上传 ${file.name} · ${formatBytes(data.size)}`, 'ok');
  } catch (err) {
    progress?.remove();
    showError(`导入失败：${err.message}`);
  } finally {
    if (isImage) {
      state.imageUploading = false;
      $('#imageDrop').setAttribute('aria-busy', 'false');
      renderMeshFlow();
    }
  }
}

function bindDropzone(zoneId, inputId, kind) {
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
    if (input.files?.[0]) uploadFile(input.files[0], kind);
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
    const file = event.dataTransfer?.files?.[0];
    if (file) uploadFile(file, kind);
  });
}

function composePrompt() {
  const subject = $('#subject').value.trim();
  const style = $('#stylePrompt').value.trim();
  return [subject, style].filter(Boolean).join(', ');
}

async function prepareQwen(button) {
  const prompt = composePrompt();
  if (!prompt) {
    toast('先写一句主体描述', 'warn');
    $('#subject').focus();
    return;
  }
  try {
    const data = await runAction('workflow.prepareQwen', {
      prompt,
      preset: $('#qwenPreset').value,
    }, button);
    const result = data.result || {};
    const changes = (result.changes || []).slice(0, 4).join('；');
    setCallout('qwenResult', `已写入 ${result.fileName}，种子 ${result.seed}。${changes ? ` ${changes}。` : ''} 打开 ComfyUI → Workflows → PixelArtistry 运行。`, 'ok');
    toast('Qwen 工作流已生成', 'ok');
  } catch {}
}

async function prepareMesh(button) {
  if (state.imageUploading || state.meshPreparing) return;
  const image = state.selectedImage || state.config.lastImage;
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
    setCallout('meshResult', '工作流创建成功，网格尚未开始生成。请按下方步骤在 ComfyUI 中运行。', 'ok');
    toast('工作流已准备好，下一步到 ComfyUI 点击 Run', 'ok');
  } catch (err) {
    setCallout('meshResult', `创建失败：${err.message}`, 'error');
  } finally {
    state.meshPreparing = false;
    renderMeshFlow();
  }
}

function formatStamp(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Workspace artefacts. The console only knows `lastStl`, so without this list
 * an earlier export can only be found by browsing the folder by hand.
 */
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
  if (maxDim != null) {
    big.innerHTML = `${Number(maxDim).toFixed(1)}<small>mm</small>`;
  } else {
    big.textContent = '—';
  }
  setText('resultLabel', result.stl ? basename(result.stl) : 'STL 已生成');

  const tag = $('#watertightTag');
  tag.className = `tag ${watertight === true ? 'ok' : watertight === false ? 'fail' : 'warn'}`;
  tag.textContent = watertight === true ? '水密 · 可切片' : watertight === false ? '未完全水密' : '未深度检查';

  const cells = [
    ['尺寸', dims.length ? `${dims.map((n) => Number(n).toFixed(1)).join(' × ')} mm` : '—'],
    ['三角面', analysis?.triangles != null ? Number(analysis.triangles).toLocaleString() : final?.triangles != null ? Number(final.triangles).toLocaleString() : '—'],
    ['体积', analysis?.volumeMm3 != null ? `${(analysis.volumeMm3 / 1000).toFixed(2)} cm³` : final?.volumeMm3 != null ? `${(final.volumeMm3 / 1000).toFixed(2)} cm³` : '—'],
    ['边界边', analysis?.boundaryEdges ?? final?.boundaryEdges ?? '—'],
    ['非流形边', analysis?.nonManifoldEdges ?? final?.nonManifoldEdges ?? '—'],
    ['文件大小', analysis?.fileSize ? formatBytes(analysis.fileSize) : '—'],
  ];
  $('#resultMetrics').innerHTML = cells.map(([k, v]) => `<div><span>${k}</span><b>${escapeHtml(v)}</b></div>`).join('');

  const warnings = $('#resultWarnings');
  warnings.innerHTML = '';
  for (const text of result.warnings || []) {
    const node = document.createElement('div');
    node.className = 'warning-item';
    node.textContent = text;
    warnings.append(node);
  }

  if (result.stl) {
    const link = $('#btnDownloadStl');
    link.href = `/api/download?path=${encodeURIComponent(result.stl)}`;
    link.classList.remove('disabled');
    setText('reportNote', result.report || result.stl);
    $('#reportNote').title = result.report || '';
  }
}

let settingsReturnFocus = null;

function openSettings() {
  renderSettings();
  settingsReturnFocus = document.activeElement;
  $('#settingsDrawer').setAttribute('aria-hidden', 'false');
  $('#drawerBackdrop').classList.add('show');
  setTimeout(() => $('#cfgInstallRoot')?.focus(), 30);
}

function closeSettings() {
  const drawer = $('#settingsDrawer');
  if (drawer.getAttribute('aria-hidden') === 'true') return;
  drawer.setAttribute('aria-hidden', 'true');
  $('#drawerBackdrop').classList.remove('show');
  if (settingsReturnFocus instanceof HTMLElement) settingsReturnFocus.focus();
  settingsReturnFocus = null;
}

function trapSettingsFocus(event) {
  const drawer = $('#settingsDrawer');
  if (event.key !== 'Tab' || drawer.getAttribute('aria-hidden') === 'true') return;
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
  };
  try {
    const data = await api('config.save', { patch });
    state.config = data.config || state.config;
    // Explicit save: stored defaults are now the user's intent, so let the
    // post-process panel pick them up again.
    clearTouched();
    renderSelections();
    toast('设置已保存', 'ok');
    closeSettings();
    await refreshState({ silent: true });
  } catch (err) {
    toast(err.message, 'error');
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
          $('#glbPath').value = path;
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

function bindEvents() {
  document.addEventListener('click', (event) => {
    const scroll = event.target.closest('[data-scroll]');
    if (scroll) {
      document.querySelector(scroll.dataset.scroll)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  });

  $('#btnSaveSettings').addEventListener('click', saveSettings);

  $('#btnPrepareQwen').addEventListener('click', (event) => prepareQwen(event.currentTarget));
  $('#btnPrepareMesh').addEventListener('click', (event) => prepareMesh(event.currentTarget));

  $('#btnCopyPrompt').addEventListener('click', async () => {
    const prompt = composePrompt();
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
      toast(err.message, 'error');
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
    try {
      const data = await runAction('postprocess.run', {
        input,
        targetHeightMm: Number($('#targetHeight').value) || 0,
        repairMode: $('#repairMode').value,
        decimateRatio: Number($('#decimateRatio').value) || 0,
        keepLargest: $('#keepLargest').checked,
      }, event.currentTarget);
      if (data.jobId) toast('Blender 已开始处理，进度见底部任务栏', 'info');
    } catch {}
  });

  $('#btnOpenStlFolder').addEventListener('click', async () => {
    try {
      await api('folder.open', { target: 'stl' });
    } catch (err) {
      toast(err.message, 'error');
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
    $('#jobbar').classList.remove('show');
  });

  $$('.status-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const key = chip.dataset.status;
      const group = key === 'trellis' ? 'trellis' : key === 'gpu' ? '' : key;
      const target = group ? document.querySelector(`[data-check-group="${group}"]`) : null;
      (target || document.querySelector('#deploy')).scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (target) {
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

  bindDropzone('imageDrop', 'imageInput', 'input');
  bindDropzone('glbDrop', 'glbInput', 'glb');
  $('#imagePreview').addEventListener('error', () => {
    $('#imagePreview').hidden = true;
    setText('imagePreviewError', '预览无法读取，请重新选择图片。');
  });
  $('#imagePreview').addEventListener('load', () => {
    $('#imagePreview').hidden = false;
    setText('imagePreviewError', '');
  });
}

async function init() {
  bindEvents();
  updatePreset('1.5k');
  let savedMode = '';
  try {
    savedMode = localStorage.getItem(DEPLOY_MODE_KEY) || '';
  } catch {}
  setDeployMode(savedMode || 'oneclick', { persist: false });
  scanModels();
  const data = await refreshState();
  loadArtifacts();
  const jobs = data?.jobs || [];
  const running = jobs.find((job) => job.status === 'running' && job.type === 'install.oneclick')
    || jobs.find((job) => job.status === 'running');
  if (running) {
    if (running.type === 'install.oneclick') {
      state.oneClickJobId = running.id;
      setDeployMode('oneclick', { persist: false });
      $('#oneClickProgress').hidden = false;
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
}

init();
