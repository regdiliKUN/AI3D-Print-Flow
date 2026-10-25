#!/usr/bin/env node
/**
 * STL 分析器用例：格式判定、水密性、单位可疑提示。
 *
 * 关键回归点：二进制 STL 的 80 字节 header 允许以 "solid" 开头，
 * 早期实现会把这类文件误判为 ASCII 并解析失败。
 */
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyzeStl } from '../app/lib/stl.mjs';

const dir = join(tmpdir(), `ai3d-test-stl-${process.pid}-${Date.now()}`);
mkdirSync(dir, { recursive: true });

const CUBE_FACES = [
  [0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6],
  [0, 4, 5], [0, 5, 1], [1, 5, 6], [1, 6, 2],
  [2, 6, 7], [2, 7, 3], [3, 7, 4], [3, 4, 0],
];

function cubeVerts(side) {
  const h = side / 2;
  return [
    [-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h],
    [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h],
  ];
}

function writeBinary(path, side, header = 'binary cube') {
  const v = cubeVerts(side);
  const buf = Buffer.alloc(84 + CUBE_FACES.length * 50);
  buf.write(header.padEnd(80, ' ').slice(0, 80), 0, 'ascii');
  buf.writeUInt32LE(CUBE_FACES.length, 80);
  CUBE_FACES.forEach(([a, b, c], i) => {
    const o = 84 + i * 50;
    for (let k = 0; k < 3; k += 1) {
      buf.writeFloatLE(v[a][k], o + 12 + k * 4);
      buf.writeFloatLE(v[b][k], o + 24 + k * 4);
      buf.writeFloatLE(v[c][k], o + 36 + k * 4);
    }
  });
  writeFileSync(path, buf);
  return path;
}

function writeAscii(path, side) {
  const v = cubeVerts(side);
  const lines = ['solid cube'];
  for (const [a, b, c] of CUBE_FACES) {
    lines.push('  facet normal 0 0 0', '    outer loop');
    for (const p of [a, b, c]) lines.push(`      vertex ${v[p].join(' ')}`);
    lines.push('    endloop', '  endfacet');
  }
  lines.push('endsolid cube');
  writeFileSync(path, lines.join('\n'));
  return path;
}

try {
  const binary = await analyzeStl(writeBinary(join(dir, 'bin.stl'), 80));
  assert.equal(binary.format, 'binary');
  assert.equal(binary.triangles, 12);
  assert.equal(binary.watertight, true, '闭合立方体应判定为水密');
  assert.deepEqual(binary.dimensionsMm, [80, 80, 80]);
  assert.equal(binary.unitSuspicion, false);
  assert.ok(Math.abs(binary.volumeMm3 - 512000) < 1, `体积应为 512000 mm³，实际 ${binary.volumeMm3}`);

  const tricky = await analyzeStl(writeBinary(join(dir, 'tricky.stl'), 80, 'solid exported-by-tool'));
  assert.equal(tricky.format, 'binary', 'header 以 solid 开头的二进制文件仍应按二进制解析');
  assert.equal(tricky.triangles, 12);

  const ascii = await analyzeStl(writeAscii(join(dir, 'ascii.stl'), 80));
  assert.equal(ascii.format, 'ascii');
  assert.equal(ascii.triangles, 12);
  assert.ok(Math.abs(ascii.volumeMm3 - binary.volumeMm3) < 1, 'ASCII 与二进制体积应一致');

  const tiny = await analyzeStl(writeBinary(join(dir, 'tiny.stl'), 0.08));
  assert.equal(tiny.unitSuspicion, true, '0.08 mm 的模型应触发单位告警');
  assert.match(tiny.note, /最大尺寸不足 1 mm/);

  writeFileSync(join(dir, 'junk.stl'), Buffer.alloc(200, 0x41));
  await assert.rejects(() => analyzeStl(join(dir, 'junk.stl')), /无法识别的 STL 格式/);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('stl test OK');
