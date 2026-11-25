"use strict";

// Wall-map cleanup after a mass removal that leaves many live stones. The
// stale entries can be swept out without re-unioning the survivors, or the
// whole graph can be rebuilt from the live stones. `remove` times the real
// removeStones() call, cleanup included.
//
//   node bench/sweep.js remove 100000 250000
//   node bench/sweep.js sweep  100000 250000
//   node bench/sweep.js rebuild 100000 250000

const { loadGame, now, ms } = require("./run");

const op = process.argv[2] || "remove";
const live = Number(process.argv[3] || 100000);
const dead = Number(process.argv[4] || 250000);
const DIM = 100000;
const SIDE = Math.ceil(Math.sqrt(Math.max(live, dead)));

function fill(game, x0, y0, count, player, list) {
  let placed = 0;
  for (let y = y0; y < y0 + SIDE && placed < count; y += 1) {
    for (let x = x0; x < x0 + SIDE && placed < count; x += 1) {
      const index = y * DIM + x;
      game.setStone(index, player);
      if (list !== null) {
        list.push({ index, player });
      }
      placed += 1;
    }
  }
}

const { game } = loadGame();
const { startGame, state } = game;
startGame(2, DIM);
fill(game, 100, 100, live, 1, null);
const victims = [];
fill(game, 50000, 50000, dead, 2, victims);
if (global.gc) {
  global.gc();
}
const before = game.wallStats();

let elapsed;
if (op === "remove") {
  const t = now();
  game.removeStones(victims);
  elapsed = ms(t);
} else {
  // Keep the automatic threshold out of the measurement.
  const realTotal = state.stoneTotal;
  state.stoneTotal = 1e9;
  game.removeStones(victims);
  state.stoneTotal = realTotal - dead;
  if (global.gc) {
    global.gc();
  }
  const t = now();
  if (op === "sweep") {
    game.sweepWalls();
  } else {
    game.rebuildWalls();
  }
  elapsed = ms(t);
}

if (global.gc) {
  global.gc();
}
console.log(JSON.stringify({
  op, live, dead, ms: +elapsed.toFixed(1),
  before, after: game.wallStats(),
  heap: +(process.memoryUsage().heapUsed / 1048576).toFixed(0),
}));
