"use strict";

// Would a quadtree or a tile hash beat the sorted-row index? Measure the two
// operations the engine actually performs: point lookup and row-range scan.
// Synthetic data, same builder for all three structures.
//
//   node --expose-gc bench/structures.js

const MB = 1024 * 1024;

function mem() {
  if (global.gc) {
    global.gc();
    global.gc();
  }
  return process.memoryUsage().heapUsed;
}

function now() {
  return process.hrtime.bigint();
}

function ms(t) {
  return Number(process.hrtime.bigint() - t) / 1e6;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// ---- sorted rows (current engine shape) ------------------------------

function buildRows(points) {
  const rows = new Map();
  for (const [x, y, player] of points) {
    let row = rows.get(y);
    if (row === undefined) {
      row = { xs: [], players: [] };
      rows.set(y, row);
    }
    row.xs.push(x);
    row.players.push(player);
  }
  for (const row of rows.values()) {
    const order = row.xs.map((_, i) => i).sort((a, b) => row.xs[a] - row.xs[b]);
    row.xs = order.map((i) => row.xs[i]);
    row.players = order.map((i) => row.players[i]);
  }
  return {
    rows,
    at(x, y) {
      const row = rows.get(y);
      if (row === undefined) return 0;
      let lo = 0;
      let hi = row.xs.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const v = row.xs[mid];
        if (v === x) return row.players[mid];
        if (v < x) lo = mid + 1; else hi = mid - 1;
      }
      return 0;
    },
    scan(y, x0, x1) {
      const row = rows.get(y);
      if (row === undefined) return 0;
      let lo = 0;
      let hi = row.xs.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (row.xs[mid] < x0) lo = mid + 1; else hi = mid;
      }
      let n = 0;
      for (let i = lo; i < row.xs.length && row.xs[i] <= x1; i += 1) n += 1;
      return n;
    },
  };
}

// ---- uniform tile hash -----------------------------------------------

const TILE = 16;
const TILES_PER_ROW = 10000 / TILE;

function buildTiles(points) {
  const tiles = new Map();
  for (const [x, y, player] of points) {
    const key = ((y / TILE) | 0) * TILES_PER_ROW + ((x / TILE) | 0);
    let tile = tiles.get(key);
    if (tile === undefined) {
      tile = { xs: [], ys: [], players: [] };
      tiles.set(key, tile);
    }
    tile.xs.push(x);
    tile.ys.push(y);
    tile.players.push(player);
  }
  return {
    tiles,
    at(x, y) {
      const key = ((y / TILE) | 0) * TILES_PER_ROW + ((x / TILE) | 0);
      const tile = tiles.get(key);
      if (tile === undefined) return 0;
      for (let i = 0; i < tile.xs.length; i += 1) {
        if (tile.xs[i] === x && tile.ys[i] === y) return tile.players[i];
      }
      return 0;
    },
    scan(y, x0, x1) {
      const ty = (y / TILE) | 0;
      const t0 = (x0 / TILE) | 0;
      const t1 = (x1 / TILE) | 0;
      let n = 0;
      for (let tx = t0; tx <= t1; tx += 1) {
        const tile = tiles.get(ty * TILES_PER_ROW + tx);
        if (tile === undefined) continue;
        for (let i = 0; i < tile.xs.length; i += 1) {
          if (tile.ys[i] === y && tile.xs[i] >= x0 && tile.xs[i] <= x1) n += 1;
        }
      }
      return n;
    },
  };
}

// ---- pointer quadtree, bucket of 8, leaves one cell wide -------------
// 10,000 x 10,000 -> 14 levels of half-splitting until one cell.

const ROOT = 16384; // power of two >= 10000
const CELLS_PER_ROOT = 10000;

function buildQuadtree(points) {
  const root = { points: [], children: undefined };

  function insert(node, x0, y0, size, point) {
    if (node.children === undefined) {
      node.points.push(point);
      if (node.points.length <= 8 || size === 1) return;
      const half = size >> 1;
      node.children = [null, null, null, null];
      const old = node.points;
      node.points = null;
      for (const p of old) insert(node, x0, y0, size, p);
      return;
    }
    const half = size >> 1;
    const qx = point[0] >= x0 + half ? 1 : 0;
    const qy = point[1] >= y0 + half ? 1 : 0;
    const index = qy * 2 + qx;
    let child = node.children[index];
    if (child === null) {
      child = { points: [], children: undefined };
      node.children[index] = child;
    }
    insert(child, x0 + qx * half, y0 + qy * half, half, point);
  }

  for (const point of points) insert(root, 0, 0, ROOT, point);

  return {
    root,
    at(x, y) {
      let node = root;
      let x0 = 0;
      let y0 = 0;
      let size = ROOT;
      while (node.children !== undefined) {
        const half = size >> 1;
        const qx = x >= x0 + half ? 1 : 0;
        const qy = y >= y0 + half ? 1 : 0;
        node = node.children[qy * 2 + qx];
        if (node === undefined || node === null) return 0;
        x0 += qx * half;
        y0 += qy * half;
        size = half;
      }
      for (const p of node.points) if (p[0] === x && p[1] === y) return p[2];
      return 0;
    },
    scan(y, x0, x1) {
      let n = 0;
      const visit = (node, nx, ny, size) => {
        if (node === undefined || node === null) return;
        if (ny > y || ny + size - 1 < y || nx > x1 || nx + size - 1 < x0) return;
        if (node.children !== undefined) {
          const half = size >> 1;
          visit(node.children[0], nx, ny, half);
          visit(node.children[1], nx + half, ny, half);
          visit(node.children[2], nx, ny + half, half);
          visit(node.children[3], nx + half, ny + half, half);
          return;
        }
        for (const p of node.points) {
          if (p[1] === y && p[0] >= x0 && p[0] <= x1) n += 1;
        }
      };
      visit(root, 0, 0, ROOT);
      return n;
    },
  };
}

// ---- harness ---------------------------------------------------------

function points(count, seed) {
  const next = rng(seed);
  const out = new Array(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = [
      Math.floor(next() * 10000),
      Math.floor(next() * 10000),
      1 + (i & 1),
    ];
  }
  return out;
}

function queries(count, seed) {
  const next = rng(seed);
  const out = new Array(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = [Math.floor(next() * 10000), Math.floor(next() * 10000)];
  }
  return out;
}

const builders = {
  rows: buildRows,
  tiles: buildTiles,
  quadtree: buildQuadtree,
};

const N = Number(process.env.N || process.argv[3] || 200000);
const Q = 200000;

function bench(name) {
  const build = builders[name];
  const pts = points(N, 7);
  const qs = queries(Q, 9);

  const before = mem();
  const t = now();
  const s = build(pts);
  const buildMs = ms(t);
  const heap = mem() - before;

  const t2 = now();
  let hits = 0;
  for (let i = 0; i < Q; i += 1) {
    const q = i < Q / 2 && i < pts.length ? [pts[i][0], pts[i][1]] : qs[i];
    if (s.at(q[0], q[1]) !== 0) hits += 1;
  }
  const lookupUs = (ms(t2) * 1000) / Q;

  const t3 = now();
  let found = 0;
  for (let i = 0; i < 5000; i += 1) {
    const y = (i * 7919) % 10000;
    const x0 = (i * 104729) % 9900;
    found += s.scan(y, x0, x0 + 64);
  }
  const scanUs = (ms(t3) * 1000) / 5000;

  console.log(
    name.padEnd(10) +
    `${buildMs.toFixed(0)} ms`.padStart(9) +
    `${lookupUs.toFixed(2)} us`.padStart(11) +
    `${scanUs.toFixed(1)} us`.padStart(11) +
    `${(heap / N).toFixed(0)} B`.padStart(12) +
    `   (hits ${hits}, scanned ${found})`,
  );
  void s;
}

if (process.argv[2] === undefined) {
  console.log(`structure comparison, ${N} stones on 10,000 x 10,000`);
  console.log("");
  console.log(
    "structure".padEnd(10) + "build".padStart(9) + "lookup".padStart(11) +
    "rowscan".padStart(11) + "heap/stone".padStart(12),
  );
  const { spawnSync } = require("node:child_process");
  for (const name of Object.keys(builders)) {
    const out = spawnSync(process.execPath,
      ["--expose-gc", __filename, name, String(N)], { encoding: "utf8" });
    process.stdout.write(out.stdout);
    if (out.status !== 0) {
      process.stderr.write(out.stderr);
      process.exit(out.status ?? 1);
    }
  }
} else {
  bench(process.argv[2]);
}
