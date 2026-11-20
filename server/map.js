'use strict';

// Карта арены: левая половина задаётся руками, правая — её зеркальная копия.
// '#' — стена, 'B' — ящик (тоже препятствие), '.' — пол.
const TILE = 32;

const LEFT_HALF = [
  '####################',
  '#...................',
  '#..###.......####..#',
  '#..#...........#...#',
  '#..#....B......#...#',
  '#..#...........#...#',
  '#..###.......####..#',
  '#..................#',
  '#.....B......B......',
  '#...........B......#',
  '#...####...........#',
  '#...#..............#',
  '#...#.....B........#',
  '#...#..............#',
  '#...####...........#',
  '#...................',
  '#.....B......B.....#',
  '#..###.......####..#',
  '#..#...........#...#',
  '#..#....B......#...#',
  '#..#...........#...#',
  '#..###.......####..#',
  '#..................#',
  '####################',
];

const rows = LEFT_HALF.map((r) => r + [...r].reverse().join(''));
const HEIGHT = rows.length;
const WIDTH = rows[0].length;

// 0 — пол, 1 — стена, 2 — ящик
const grid = rows.map((r) =>
  [...r].map((ch) => (ch === '#' ? 1 : ch === 'B' ? 2 : 0))
);

function isSolidTile(tx, ty) {
  if (ty < 0 || ty >= HEIGHT || tx < 0 || tx >= WIDTH) return true;
  return grid[ty][tx] > 0;
}

function isSolidAt(x, y) {
  return isSolidTile(Math.floor(x / TILE), Math.floor(y / TILE));
}

const WORLD_WIDTH = WIDTH * TILE;
const WORLD_HEIGHT = HEIGHT * TILE;

// Точки респавна: жадно выбираем максимально разнесённые открытые клетки.
function pickSpawns(count) {
  const cands = [];
  for (let ty = 2; ty < HEIGHT - 2; ty++) {
    for (let tx = 2; tx < WIDTH - 2; tx++) {
      let open = true;
      for (let y = ty - 1; y <= ty + 1 && open; y++) {
        for (let x = tx - 1; x <= tx + 1; x++) {
          if (isSolidTile(x, y)) {
            open = false;
            break;
          }
        }
      }
      if (open) cands.push({ x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE });
    }
  }
  if (!cands.length) return [{ x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2 }];

  const cx = WORLD_WIDTH / 2;
  const cy = WORLD_HEIGHT / 2;
  const chosen = [];
  // Первая точка — самая дальняя от центра.
  let first = cands[0];
  let bestD = -1;
  for (const c of cands) {
    const d = (c.x - cx) ** 2 + (c.y - cy) ** 2;
    if (d > bestD) {
      bestD = d;
      first = c;
    }
  }
  chosen.push(first);

  while (chosen.length < count && chosen.length < cands.length) {
    let best = null;
    let bestMin = -1;
    for (const c of cands) {
      let minD = Infinity;
      for (const s of chosen) {
        const d = (c.x - s.x) ** 2 + (c.y - s.y) ** 2;
        if (d < minD) minD = d;
      }
      if (minD > bestMin) {
        bestMin = minD;
        best = c;
      }
    }
    chosen.push(best);
  }
  return chosen;
}

const SPAWNS = pickSpawns(14);

module.exports = {
  TILE,
  WIDTH,
  HEIGHT,
  WORLD_WIDTH,
  WORLD_HEIGHT,
  grid,
  rows,
  isSolidTile,
  isSolidAt,
  SPAWNS,
};
