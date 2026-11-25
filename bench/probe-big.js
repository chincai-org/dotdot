"use strict";

// How does the engine behave at the top of the board range? Two cases per
// extent: a ring on its own (walls stay local), and a ring while the same
// player already has a stone on the far side of the board (which, without
// component scoping, would make the flood walk the whole bounding box).
//
//   node bench/probe-big.js

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { install } = require("./fake-dom");

function load() {
  const { sandbox } = install();
  const context = vm.createContext(sandbox);
  const file = path.join(__dirname, "..", "main.js");
  const source = fs.readFileSync(file, "utf8");
  vm.runInContext(`${source}
    globalThis.__g = { state, startGame, place, undo, analyse, renderBoard };
  `, context, { filename: "main-big.js" });
  return sandbox.__g;
}

const now = () => process.hrtime.bigint();
const ms = (t) => Number(process.hrtime.bigint() - t) / 1e6;

function ringPoints(cx, cy, size) {
  const points = [[cx, cy], [cx + size - 1, cy],
    [cx, cy + size - 1], [cx + size - 1, cy + size - 1]];
  for (let x = cx + 1; x < cx + size - 1; x += 1) {
    points.push([x, cy], [x, cy + size - 1]);
  }
  for (let y = cy + 1; y < cy + size - 1; y += 1) {
    points.push([cx, y], [cx + size - 1, y]);
  }
  return points;
}

function sealCost(dim, strayStone) {
  const g = load();
  const { state, startGame, place, renderBoard } = g;
  startGame(2, dim);
  const mid = Math.floor(dim / 2);

  if (strayStone) {
    state.turn = 1;
    place({ x: 10, y: 10 });
  }

  const ring = ringPoints(mid - 500, mid - 500, 1000);
  let closing = 0;
  for (const [x, y] of ring) {
    state.turn = 1;
    const t = now();
    place({ x, y });
    closing = ms(t);
  }

  for (let i = 0; i < 10; i += 1) renderBoard();
  let t = now();
  for (let i = 0; i < 100; i += 1) renderBoard();
  const frame = ms(t) / 100;

  if (global.gc) global.gc();
  const heap = process.memoryUsage().heapUsed / 1048576;
  return { ring, closing, frame, heap };
}

console.log("extent up to the 94,000,000 cap: ring 1000 close, 2 players");
console.log("");
console.log("extent".padEnd(10) + "local walls".padStart(14) +
  "stray stone".padStart(14) + "frame".padStart(10) + "heap L/S".padStart(12));

for (const dim of [10000, 100000, 1000000, 10000000, 30000000, 94000000]) {
  const local = sealCost(dim, false);
  const stray = sealCost(dim, true);
  console.log(
    `${String(dim).padStart(8)}`.padEnd(10) +
    `${local.closing.toFixed(1)} ms`.padStart(14) +
    `${stray.closing.toFixed(1)} ms`.padStart(14) +
    `${local.frame.toFixed(3)} ms`.padStart(10) +
    `${local.heap.toFixed(0)}/${stray.heap.toFixed(0)} MB`.padStart(12),
  );
}

console.log("");
console.log("board pixels at 32 px cells (the spacer is virtual and capped at 4 M):");
for (const dim of [10000, 1000000, 10000000, 94000000]) {
  const px = 28 * 2 + (dim - 1) * 32;
  console.log(`  ${String(dim).padStart(8)} crossings  ${(px / 1e6).toFixed(1)} M px`);
}
console.log("  Browser layout caps no longer apply: the spacer stays at 4 M px.");
console.log("  Drawing is frame-local, so even the 2.9 G px board stays exact.");
