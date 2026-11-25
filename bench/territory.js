"use strict";

// Territory cost when the board already holds many separate sealed regions.
// The question is the cost of the *next* seal, not the first analysis.
//
//   node bench/territory.js

const { loadGame, now, ms } = require("./run");

const DIM = 10000;
const RING = 6; // 6 x 6 perimeter, 4 x 4 = 16 owned crossings
const STEP = 16; // far enough that rings never touch

function ringPoints(cx, cy) {
  const points = [];
  for (let x = cx; x < cx + RING; x += 1) {
    points.push([x, cy]);
    points.push([x, cy + RING - 1]);
  }
  for (let y = cy + 1; y < cy + RING - 1; y += 1) {
    points.push([cx, y]);
    points.push([cx + RING - 1, y]);
  }
  return points;
}

function run(count) {
  const { game } = loadGame();
  const { state, startGame, setStone, analyse, place } = game;
  startGame(2, DIM);

  const cols = Math.ceil(Math.sqrt(count));
  for (let i = 0; i < count; i += 1) {
    const cx = 100 + (i % cols) * STEP;
    const cy = 100 + Math.floor(i / cols) * STEP;
    for (const [x, y] of ringPoints(cx, cy)) {
      setStone(y * DIM + x, 1);
    }
  }

  // First analysis after building everything: unavoidably a full merge.
  state.analysis = null;
  const first = analyse();

  let runs = 0;
  let bands = 0;
  for (const band of first.ownerBands) {
    runs += band.runs.length;
    bands += 1;
  }

  // One more ring, placed for real so the closing move pays for the seal.
  const cx = 100 + cols * STEP + 40;
  const cy = 100;
  let closingMs = 0;
  let t;
  for (const [x, y] of ringPoints(cx, cy)) {
    state.turn = 1;
    t = now();
    place({ x, y });
    const dt = ms(t);
    closingMs = dt;
  }

  const a = analyse();
  const points = a.scores.reduce((sum, s) => sum + s.points, 0);
  const expected = (count + 1) * (RING - 2) * (RING - 2);

  // Split the seal cost: flood over the player's bounding box, then the owner
  // merge. The merge rebuilds the band list once; it does not patch rows.
  t = now();
  game.computeSealed(1);
  const floodMs = ms(t);

  state.analysis = null;
  state.ownerDirty = true;
  t = now();
  analyse();
  const mergeMs = ms(t);

  console.log(
    `${String(count).padStart(5)} rings  ${String(bands).padStart(7)} bands  ` +
    `${String(runs).padStart(7)} runs  ` +
    `flood ${floodMs.toFixed(1).padStart(5)} ms  ` +
    `merge ${mergeMs.toFixed(2).padStart(5)} ms  ` +
    `seal move ${closingMs.toFixed(2).padStart(6)} ms  ` +
    `points ${points}${points === expected ? "" : ` EXPECTED ${expected}`}`,
  );
}

console.log("many sealed regions, 10,000 x 10,000, 2 players");
console.log("");
for (const count of [25, 100, 400, 1600, 4000]) {
  run(count);
}
