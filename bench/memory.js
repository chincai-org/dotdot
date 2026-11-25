"use strict";

// Memory scaling for the sparse engine. Each case runs in its own process so
// RSS is not polluted by earlier cases' garbage or vm contexts.
//
//   node --expose-gc bench/memory.js
//
// The live `game` is passed into report() on purpose: without a reference at
// the sampling point V8 may prove it dead and collect the whole board before
// memoryUsage() runs.

const { spawnSync } = require("node:child_process");

const MB = 1024 * 1024;

function mem() {
  if (global.gc) {
    global.gc();
    global.gc();
  }
  const m = process.memoryUsage();
  return { rss: m.rss / MB, heap: m.heapUsed / MB, ab: m.arrayBuffers / MB };
}

function report(label, game, stones, base, after) {
  const dHeap = after.heap - base.heap;
  const per = stones > 0 ? (dHeap * MB) / stones : 0;
  console.log(
    `${label.padEnd(26)} ${String(stones).padStart(8)} stones  ` +
    `heap ${after.heap.toFixed(1).padStart(6)} MB (+${dHeap.toFixed(1).padStart(5)})  ` +
    `rss ${after.rss.toFixed(0).padStart(4)} MB  ` +
    `ab ${after.ab.toFixed(1)}  ` +
    `rows ${game.state.rows.size}  ` +
    `${per.toFixed(0).padStart(4)} B/stone`,
  );
}

function scatter(dim, count, players) {
  const { game } = require("./run").loadGame();
  game.startGame(players, dim);
  const base = mem();
  let seed = 123456789;
  let placed = 0;
  for (let i = 0; i < count; i += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const x = seed % dim;
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const y = seed % dim;
    if (game.stoneAt(x, y) !== 0) {
      continue;
    }
    game.setStone(y * dim + x, 1 + (i % players));
    placed += 1;
  }
  report(`scatter ${dim}x${dim} p${players}`, game, placed, base, mem());
}

function ring(dim, size, players, clear) {
  const { loadGame, placeRing } = require("./run");
  const { game } = loadGame();
  game.startGame(players, dim);
  const base = mem();
  const points = placeRing(game, Math.floor(dim / 2), Math.floor(dim / 2), size);
  for (const [x, y] of points) {
    game.state.turn = 1;
    game.place({ x, y });
  }
  game.analyse();
  const filled = mem();
  report(`ring ${size} ${dim}x${dim} p${players}`, game, points.length, base,
    filled);
  if (clear) {
    game.startGame(players, dim);
    const after = mem();
    console.log(
      `  after Clear: heap ${after.heap.toFixed(1)} MB ` +
      `(peak ${filled.heap.toFixed(1)}, empty board ${base.heap.toFixed(1)}), ` +
      `rows ${game.state.rows.size}`,
    );
  }
}

function empty(dim) {
  const { game } = require("./run").loadGame();
  game.startGame(2, dim);
  const m = mem();
  console.log(
    `empty ${dim}x${dim}               heap ${m.heap.toFixed(1)} MB  ` +
    `rss ${m.rss.toFixed(0)} MB  arrayBuffers ${m.ab.toFixed(1)} MB  ` +
    `rows ${game.state.rows.size}`,
  );
}

// Many separate sealed regions. Territory is stored as rectangle bands, not
// cells and not rows, so 4,000 small rings share 63 bands.
function regions(dim, count) {
  const { game } = require("./run").loadGame();
  game.startGame(2, dim);
  const base = mem();
  const cols = Math.ceil(Math.sqrt(count));
  const step = 16;
  const size = 6;
  let stones = 0;
  for (let i = 0; i < count; i += 1) {
    const cx = 100 + (i % cols) * step;
    const cy = 100 + Math.floor(i / cols) * step;
    for (const [x, y] of [
      [cx, cy], [cx + size - 1, cy],
      [cx, cy + size - 1], [cx + size - 1, cy + size - 1],
    ]) {
      game.setStone(y * dim + x, 1);
      stones += 1;
    }
    for (let k = 1; k < size - 1; k += 1) {
      for (const [x, y] of [[cx + k, cy], [cx + k, cy + size - 1],
        [cx, cy + k], [cx + size - 1, cy + k]]) {
        game.setStone(y * dim + x, 1);
        stones += 1;
      }
    }
  }
  const beforeSeal = mem();
  const analysis = game.analyse();
  const after = mem();
  let runCount = 0;
  let sealedRows = 0;
  for (const band of analysis.ownerBands) {
    runCount += band.runs.length;
    sealedRows += band.y1 - band.y0 + 1;
  }
  report(`regions ${count} ${dim}x${dim}`, game, stones, base, after);
  console.log(
    `  bands ${analysis.ownerBands.length}  sealed rows ${sealedRows}  ` +
    `runs ${runCount}  ` +
    `seal ${(after.heap - beforeSeal.heap).toFixed(1)} MB  ` +
    `~${((after.heap - beforeSeal.heap) * MB / runCount).toFixed(0)} B/run`,
  );
}

// Every move keeps a history record so it can be undone. This measures that
// per-move cost, which a scattered setStone() does not pay.
function moves(dim, count) {
  const { game } = require("./run").loadGame();
  game.startGame(2, dim);
  const base = mem();
  let seed = 987654321;
  let placed = 0;
  while (placed < count) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const x = seed % dim;
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const y = seed % dim;
    if (game.stoneAt(x, y) !== 0 || game.isBlocked({ x, y })) {
      continue;
    }
    game.state.turn = 1 + (placed % 2);
    game.place({ x, y });
    placed += 1;
  }
  const after = mem();
  const dHeap = after.heap - base.heap;
  console.log(
    `moves ${placed} ${dim}x${dim}        heap ${after.heap.toFixed(1)} MB ` +
    `(+${dHeap.toFixed(1)})  rss ${after.rss.toFixed(0)} MB  ` +
    `history ${require("./run").historyLength(game)}  ` +
    `${(dHeap * MB / placed).toFixed(0)} B/move`,
  );
}

const cases = {
  empty1000: () => empty(1000),
  empty10000: () => empty(10000),
  empty1m: () => empty(1000000),
  empty94m: () => empty(94000000),
  scatter1000: () => scatter(1000, 100000, 2),
  scatter10k: () => scatter(10000, 10000, 2),
  scatter100k: () => scatter(10000, 100000, 2),
  scatter500k: () => scatter(10000, 500000, 2),
  scatter1m: () => scatter(10000, 1000000, 2),
  scatter8p: () => scatter(10000, 200000, 8),
  scatter1mboard: () => scatter(1000000, 100000, 2),
  ring1000: () => ring(10000, 1000, 2),
  ring2000: () => ring(10000, 2000, 2),
  ring4000: () => ring(10000, 4000, 2),
  ring9998: () => ring(10000, 9998, 2),
  ring8p: () => ring(10000, 2000, 8),
  ring10k1m: () => ring(1000000, 10000, 2),
  ring40k1m: () => ring(1000000, 40000, 2),
  regions4000: () => regions(1000000, 4000),
  moves100k: () => moves(10000, 100000),
  clear: () => ring(10000, 4000, 2, true),
};

const order = [
  "empty1000", "empty10000", "empty1m", "empty94m",
  "scatter1000", "scatter10k", "scatter100k", "scatter500k", "scatter1m",
  "scatter8p", "scatter1mboard",
  "ring1000", "ring2000", "ring4000", "ring9998", "ring8p",
  "ring10k1m", "ring40k1m", "regions4000", "moves100k",
  "clear",
];

if (process.argv[2] !== undefined) {
  cases[process.argv[2]]();
} else {
  for (const name of order) {
    const out = spawnSync(process.execPath,
      ["--expose-gc", __filename, name], { encoding: "utf8" });
    if (out.status !== 0) {
      process.stderr.write(out.stderr);
      process.exit(out.status ?? 1);
    }
    process.stdout.write(out.stdout);
  }
}
