import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the real browser handlers with a small DOM and upload transport.
// In particular, use bindEvents() so the production file-kind wiring is tested.
const html = readFileSync(new URL('../app/public/index.html', import.meta.url), 'utf8');
const elements = new Map();
function element() {
  const listeners = new Map();
  const classes = new Set();
  return {
    textContent: '', value: '', hidden: false, disabled: false, dataset: {}, style: {},
    classList: { add: (v) => classes.add(v), remove: (v) => classes.delete(v), toggle(v, on) { if (on) classes.add(v); else classes.delete(v); } },
    addEventListener(name, callback) { listeners.set(name, [...(listeners.get(name) || []), callback]); },
    async dispatch(name, event = {}) { for (const callback of listeners.get(name) || []) await callback({ target: this, currentTarget: this, preventDefault() {}, ...event }); },
    setAttribute() {}, hasAttribute() { return false; }, removeAttribute() {},
    append() {}, remove() {}, focus() {}, click() {}, scrollIntoView() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
  };
}
for (const match of html.matchAll(/id="([^"]+)"/g)) elements.set(match[1], element());
const document = {
  querySelector: (selector) => elements.get(selector.replace(/^#/, '')) || null,
  querySelectorAll: () => [], getElementById: (id) => elements.get(id) || null,
  addEventListener() {}, createElement: element,
};
const requests = [];
let uploadError = false;
let actionError = false;
class Upload {
  upload = { addEventListener() {} };
  listeners = new Map();
  open(method, url) { this.url = url; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  send(file) {
    this.status = uploadError ? 400 : 200;
    this.responseText = JSON.stringify(uploadError
      ? { ok: false, error: '文件内容与扩展名不匹配' }
      : { ok: true, path: `I:\\workspace\\${this.url.includes('kind=glb') ? 'glb' : 'input'}\\${file.name}`, size: file.size });
    this.listeners.get('load')();
  }
}
const context = vm.createContext({
  document, console, URL, AbortController, XMLHttpRequest: Upload,
  navigator: {}, window: { addEventListener() {}, location: {} },
  setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
  fetch: async (url, options) => {
    if (options?.body) requests.push(JSON.parse(options.body));
    return { ok: !actionError, status: actionError ? 400 : 200, json: async () => actionError
      ? { ok: false, error: '未找到 ComfyUI' }
      : { ok: true, result: { fileName: 'AI3D_fixture.json', changes: [] } } };
  },
});
const source = readFileSync(new URL('../app/public/app.js', import.meta.url), 'utf8');
vm.runInContext(source.replace(/\binit\(\);\s*$/, ''), context);
vm.runInContext('bindEvents()', context);
vm.runInContext('renderSelections()', context);
assert.equal(elements.get('btnPrepareMesh').disabled, true, 'No image must disable generation');
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const get = (code) => vm.runInContext(code, context);
const input = elements.get('imageInput');
input.files = [{ name: 'fixture.png', size: 68 }];
await input.dispatch('change');
await flush();
assert.match(get('state.selectedImage'), /fixture\.png$/, 'PNG selection must populate image state');
assert.equal(get('state.selectedGlb'), '', 'PNG must never become a GLB');
assert.equal(elements.get('imageFileLine').textContent, 'fixture.png');
assert.equal(elements.get('btnPrepareMesh').disabled, false);
assert.equal(elements.get('imagePreview').src, '/api/file?path=' + encodeURIComponent(get('state.selectedImage')));
assert.equal(elements.get('imagePreview').hidden, false);
assert.match(elements.get('meshResult').textContent, /图片|下一步/);
await elements.get('btnPrepareMesh').dispatch('click');
await flush();
assert.equal(requests.at(-1)?.action, 'workflow.preparePixel', 'Next button must actually request a mesh workflow');
assert.match(requests.at(-1).payload.imagePath, /fixture\.png$/);
assert.equal(elements.get('meshWorkflowReady').hidden, false);
assert.equal(elements.get('meshWorkflowName').textContent, 'AI3D_fixture.json');
assert.match(elements.get('meshNext').textContent, /Run/);
console.log('[通过] PNG 选择 → 图片状态 → 生成水密工作流');

get('updatePreset("2k")');
assert.equal(elements.get('meshWorkflowReady').hidden, true, 'Changing preset invalidates old workflow instructions');
await elements.get('imageDrop').dispatch('drop', { dataTransfer: { files: [{ name: 'dropped.webp', size: 100 }] } });
await flush();
assert.equal(elements.get('imageFileLine').textContent, 'dropped.webp');
assert.equal(get('state.config.lastGlb'), undefined);
assert.match(get('state.config.lastImage'), /dropped\.webp$/);
get('state.selectedImage = ""; renderSelections()');
assert.equal(elements.get('imageFileLine').textContent, 'dropped.webp', 'Saved image must survive state refresh');
uploadError = true;
input.files = [{ name: 'bad.png', size: 100 }];
await input.dispatch('change');
await flush();
assert.match(elements.get('meshResult').textContent, /导入失败/);
assert.equal(elements.get('imageFileLine').textContent, 'dropped.webp', 'Failed replacement retains prior image');
assert.equal(get('state.imageUploading'), false);
actionError = true;
await elements.get('btnPrepareMesh').dispatch('click');
await flush();
assert.match(elements.get('meshResult').textContent, /创建失败.*未找到 ComfyUI/);
assert.equal(elements.get('btnPrepareMesh').disabled, false, 'Generation failure permits retry');
assert.equal(elements.get('meshWorkflowReady').hidden, true);
uploadError = false;
const glb = elements.get('glbInput');
glb.files = [{ name: 'model.glb', size: 100 }];
await glb.dispatch('change');
await flush();
assert.match(get('state.selectedGlb'), /model\.glb$/);
assert.equal(elements.get('imageFileLine').textContent, 'dropped.webp');
console.log('[通过] 拖入、更换、恢复图片、失败重试与 GLB 独立状态');
