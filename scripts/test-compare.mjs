// 对 compareFrames 的核心场景做冒烟测试
import { compareFrames, GRAY_W, GRAY_H } from '../.tmp-test/compare.js';

function makeGray(fill) {
  const data = new Float32Array(GRAY_W * GRAY_H).fill(fill);
  return { w: GRAY_W, h: GRAY_H, data, mean: fill };
}

// 生成带图案的帧：随机斑点背景 + 一个亮块（模拟人偶）
function makeScene(seed, blockX, blockY) {
  const g = makeGray(40);
  let s = seed;
  const rand = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < g.data.length; i++) g.data[i] = 30 + rand() * 60;
  for (let y = blockY; y < blockY + 8; y++)
    for (let x = blockX; x < blockX + 8; x++) g.data[y * GRAY_W + x] = 200;
  g.mean = g.data.reduce((a, b) => a + b, 0) / g.data.length;
  return g;
}

function shiftFrame(src, dx, dy) {
  const g = makeGray(0);
  for (let y = 0; y < GRAY_H; y++)
    for (let x = 0; x < GRAY_W; x++) {
      const sx = x - dx, sy = y - dy;
      g.data[y * GRAY_W + x] =
        sx >= 0 && sx < GRAY_W && sy >= 0 && sy < GRAY_H ? src.data[sy * GRAY_W + sx] : 0;
    }
  g.mean = g.data.reduce((a, b) => a + b, 0) / g.data.length;
  return g;
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name); }
}

// 1. 相同帧 → 无警告
{
  const a = makeScene(1, 40, 20);
  const r = compareFrames(a, makeScene(1, 40, 20));
  check('相同帧无警告', r.warnings.length === 0);
  check('相同帧位移为 0', r.shiftX === 0 && r.shiftY === 0);
}

// 2. 亮度整体 +10 → 亮度警告
{
  const a = makeScene(2, 40, 20);
  const b = makeGray(0);
  b.data.set(a.data.map((v) => v + 10));
  b.mean = a.mean + 10;
  const r = compareFrames(a, b);
  check('亮度+10 触发亮度警告', r.warnings.some((w) => w.includes('亮度')));
  check('亮度+10 不误报位移', !r.warnings.some((w) => w.includes('偏移')));
}

// 3. 画面平移 (3, -2) → 位移警告且方向正确
{
  const a = makeScene(3, 40, 20);
  const b = shiftFrame(a, 3, -2);
  const r = compareFrames(a, b);
  check('平移(3,-2) 触发偏移警告', r.warnings.some((w) => w.includes('偏移')));
  check('检出位移方向正确', r.shiftX === 3 && r.shiftY === -2);
}

// 4. 人偶移动（局部变化）→ 不报警
{
  const a = makeScene(4, 40, 20);
  const b = makeScene(4, 44, 22); // 同样的背景，亮块挪了位置
  const r = compareFrames(a, b);
  check('人偶局部移动不报警', r.warnings.length === 0);
}

// 5. 全画面变化 → 全局变化警告
{
  const a = makeScene(5, 40, 20);
  const b = makeScene(999, 40, 20); // 完全不同的背景
  const r = compareFrames(a, b);
  check('全画面变化触发警告', r.warnings.some((w) => w.includes('一半')));
}

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
