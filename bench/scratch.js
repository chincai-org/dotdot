"use strict";

// One-off giant flood scratch: after a wall spanning ~1M rows is flooded, the
// reused typed-array scratch must not pin that high-water mark. Run with
// --expose-gc so the measurement reflects retained buffers, not garbage.
//
//   node --expose-gc bench/scratch.js [span]

const { loadGame, now, ms } = require("./run");

const DIM = 1000000;
const SPAN = Number(process.argv[2] || 990000);

function mem() {
  if (global.gc) {
    global.gc();
    global.gc();
  }
  const m = process.memoryUsage();
  return {
    heap: +(m.heapUsed / 1048576).toFixed(1),
    ab: +(m.arrayBuffers / 1048576).toFixed(1),
    rss: +(m.rss / 1048576).toFixed(0),
  };
}

const { game } = loadGame();
const { state, startGame, setStone, computeSealed } = game;
startGame(2, DIM);
console.log("empty", mem());

const x0 = 100;
const y0 = 10;
const size = 8;
const ring = [];
for (let x = x0; x < x0 + size; x += 1) ring.push([x, y0]);
for (let y = y0 + 1; y < y0 + size; y += 1) {
  ring.push([x0 + size - 1, y]);
}
for (let x = x0 + size - 2; x >= x0; x -= 1) {
  ring.push([x, y0 + size - 1]);
}
for (let y = y0 + size - 2; y > y0; y -= 1) ring.push([x0, y]);
const ringSet = new Set(ring.map(([x, y]) => `${x},${y}`));
for (const [x, y] of ring) setStone(y * DIM + x, 1);
for (let y = y0 + size - 1; y < y0 + size - 1 + SPAN; y += 1) {
  if (!ringSet.has(`${x0},${y}`)) setStone(y * DIM + x0, 1);
}
console.log("setup", mem());

const t = now();
const sealed = computeSealed(1);
const floodMs = ms(t);
const after = mem();
console.log(
  `flood ${SPAN} rows  ${floodMs.toFixed(0)} ms  ` +
  `bands ${sealed.bands === null ? 0 : sealed.bands.length}  ` +
  `heap ${after.heap} MB  arrayBuffers ${after.ab} MB  rss ${after.rss} MB`,
);
console.log("scratch", game.floodScratch());

startGame(2, DIM);
const cleared = mem();
console.log(
  `after clear  heap ${cleared.heap} MB  arrayBuffers ${cleared.ab} MB  ` +
  `rss ${cleared.rss} MB  scratch ${JSON.stringify(game.floodScratch())}`,
);
