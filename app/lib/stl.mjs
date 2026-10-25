import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';

/**
 * 轻量 STL 分析器。
 * - 任意大小：流式统计三角形、包围盒、体积、表面积。
 * - ≤ 500k 三角形：额外做边流形检查（水密性）。
 * 单位按 STL 数值原样处理，本工具假定为 mm。
 */
export async function analyzeStl(path, { deepLimit = 500000 } = {}) {
  const info = await stat(path);
  const size = info.size;
  if (size < 84) throw new Error('文件太小，不是有效的 STL');

  const fh = await open(path, 'r');
  const head = Buffer.alloc(Math.min(2048, size));
  await fh.read(head, 0, head.length, 0);
  await fh.close();

  const declared = head.readUInt32LE(80);
  const binarySize = 84 + declared * 50;
  // A binary STL whose 80-byte header starts with "solid" (some exporters do
  // this) used to be misread as ASCII. Looking for an actual `facet normal`
  // record in the first 2 KB separates the two formats reliably.
  const text = head.toString('latin1');
  const asciiHint = /^\s*solid/i.test(text) && /facet\s+normal/i.test(text);
  const exactBinary = declared > 0 && size === binarySize;
  const nearBinary = declared > 0 && Math.abs(size - binarySize) < 1024;

  if (exactBinary && !asciiHint) return analyzeBinary(path, size, declared, deepLimit);
  if (asciiHint) return analyzeAscii(path, size, deepLimit);
  if (nearBinary) return analyzeBinary(path, size, declared, deepLimit);
  // Neither signature matched: let the ASCII parser produce the clear error.
  return analyzeAscii(path, size, deepLimit);
}

async function analyzeBinary(path, size, declared, deepLimit) {
  const triangles = Math.min(declared, Math.floor((size - 84) / 50));
  const deep = triangles <= deepLimit;
  const edges = deep ? new Map() : null;
  const verts = deep ? new Map() : null;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let volume = 0;
  let area = 0;
  let degenerate = 0;

  let leftover = Buffer.alloc(0);
  let index = 0;
  const stream = createReadStream(path, { start: 84, highWaterMark: 1024 * 1024 });

  for await (const chunk of stream) {
    let buf = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
    let offset = 0;
    while (offset + 50 <= buf.length && index < triangles) {
      const ax = buf.readFloatLE(offset + 12);
      const ay = buf.readFloatLE(offset + 16);
      const az = buf.readFloatLE(offset + 20);
      const bx = buf.readFloatLE(offset + 24);
      const by = buf.readFloatLE(offset + 28);
      const bz = buf.readFloatLE(offset + 32);
      const cx = buf.readFloatLE(offset + 36);
      const cy = buf.readFloatLE(offset + 40);
      const cz = buf.readFloatLE(offset + 44);

      minX = Math.min(minX, ax, bx, cx); maxX = Math.max(maxX, ax, bx, cx);
      minY = Math.min(minY, ay, by, cy); maxY = Math.max(maxY, ay, by, cy);
      minZ = Math.min(minZ, az, bz, cz); maxZ = Math.max(maxZ, az, bz, cz);

      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      const triArea = len / 2;
      area += triArea;
      if (triArea < 1e-12) degenerate++;
      volume += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;

      if (deep) {
        const ka = key(ax, ay, az, verts);
        const kb = key(bx, by, bz, verts);
        const kc = key(cx, cy, cz, verts);
        addEdge(edges, ka, kb);
        addEdge(edges, kb, kc);
        addEdge(edges, kc, ka);
      }

      offset += 50;
      index++;
    }
    leftover = buf.subarray(offset);
    if (index >= triangles) break;
  }

  return finish({
    format: 'binary',
    triangles: index,
    vertices: deep ? verts.size : null,
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    volume,
    area,
    degenerate,
    edges,
    deep,
    deepLimit,
    fileSize: size,
  });
}

async function analyzeAscii(path, size, deepLimit) {
  // The whole file is loaded as one string and scanned with a regex, so a huge
  // ASCII STL costs several times its own size in memory. 48 MB is already a
  // ~1M-triangle model; beyond that a binary STL is the right format anyway.
  if (size > 48 * 1024 * 1024) {
    throw new Error('ASCII STL 超过 48 MB，读取时会占用数倍内存。请在 Blender 里改用二进制 STL 导出后重试。');
  }
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(path, 'utf8');
  if (!/^\s*solid\b/i.test(text) || !/facet\s+normal/i.test(text)) {
    throw new Error('无法识别的 STL 格式');
  }

  const triangles = [];
  const re = /facet\s+normal\s+([^\n]+)\s+outer\s+loop([\s\S]*?)endloop\s+endfacet/gi;
  let m;
  while ((m = re.exec(text))) {
    const vs = [...m[2].matchAll(/vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g)]
      .map((x) => [Number(x[1]), Number(x[2]), Number(x[3])]);
    if (vs.length === 3) triangles.push(vs);
  }

  const deep = triangles.length <= deepLimit;
  const edges = deep ? new Map() : null;
  const verts = deep ? new Map() : null;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let volume = 0;
  let area = 0;
  let degenerate = 0;

  for (const [a, b, c] of triangles) {
    for (const v of [a, b, c]) {
      minX = Math.min(minX, v[0]); maxX = Math.max(maxX, v[0]);
      minY = Math.min(minY, v[1]); maxY = Math.max(maxY, v[1]);
      minZ = Math.min(minZ, v[2]); maxZ = Math.max(maxZ, v[2]);
    }
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const triArea = Math.hypot(nx, ny, nz) / 2;
    area += triArea;
    if (triArea < 1e-12) degenerate++;
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    if (deep) {
      const ka = key(a[0], a[1], a[2], verts);
      const kb = key(b[0], b[1], b[2], verts);
      const kc = key(c[0], c[1], c[2], verts);
      addEdge(edges, ka, kb);
      addEdge(edges, kb, kc);
      addEdge(edges, kc, ka);
    }
  }

  return finish({
    format: 'ascii',
    triangles: triangles.length,
    vertices: deep ? verts.size : null,
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    volume,
    area,
    degenerate,
    edges,
    deep,
    deepLimit,
    fileSize: size,
  });
}

function key(x, y, z, verts) {
  const k = `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;
  if (verts) verts.set(k, 1);
  return k;
}

function addEdge(map, a, b) {
  const edge = a < b ? `${a}|${b}` : `${b}|${a}`;
  map.set(edge, (map.get(edge) || 0) + 1);
}

function finish(data) {
  let boundaryEdges = null;
  let nonManifoldEdges = null;
  let watertight = null;
  if (data.edges) {
    boundaryEdges = 0;
    nonManifoldEdges = 0;
    for (const count of data.edges.values()) {
      if (count === 1) boundaryEdges++;
      else if (count > 2) nonManifoldEdges++;
    }
    watertight = boundaryEdges === 0 && nonManifoldEdges === 0;
  }

  const dims = data.min.map((v, i) => Math.max(0, data.max[i] - v));
  const maxDim = Math.max(...dims);
  // Blender writes STL in Blender units; if nobody scaled the mesh, an 0.08 m
  // statue becomes 0.08 mm and looks like a speck in CHITUBOX. Flagging it here
  // answers the most common "模型在切片软件里特别小" question at the source.
  const unitSuspicion = Number.isFinite(maxDim) && maxDim > 0 && maxDim < 1;
  const notes = [];
  if (!data.deep) {
    notes.push(
      `三角形 ${Number(data.triangles).toLocaleString()}，超过逐边水密检查上限 ${Number(data.deepLimit).toLocaleString()}，已跳过；请以 Blender 报告为准。`,
    );
  }
  if (unitSuspicion) {
    notes.push('最大尺寸不足 1 mm，导出时可能没有按毫米缩放。请在 CHITUBOX 里检查比例，或把目标高度设为 80 mm 重跑后处理。');
  }
  return {
    format: data.format,
    fileSize: data.fileSize,
    triangles: data.triangles,
    vertices: data.vertices,
    degenerateTriangles: data.degenerate,
    bboxMin: data.min.map((n) => round(n, 4)),
    bboxMax: data.max.map((n) => round(n, 4)),
    dimensionsMm: dims.map((n) => round(n, 3)),
    volumeMm3: round(Math.abs(data.volume), 2),
    surfaceAreaMm2: round(data.area, 2),
    normalsInward: data.volume < 0,
    watertight,
    boundaryEdges,
    nonManifoldEdges,
    deepChecked: data.deep,
    unitSuspicion,
    note: notes.join(' '),
  };
}

function round(n, digits) {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}
