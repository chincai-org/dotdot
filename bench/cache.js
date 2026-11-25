"use strict";

// Per-component sealed cache: remove one wall stone from one of many rings,
// then rebuild the player's analysis. With the cache only the touched ring is
// re-flooded; with a player-wide cache every ring is re-flooded.
//
//   node bench/cache.js 400 1600 4000

const { loadGame, now, ms } = require("./run");

const DIM = 10000;
const RING = 6;
const STEP = 16;

function ringPoints(cx, cy) {
  const points = [];
  for (let x = cx; x < cx + RING; x += 1) {
    points.push([x, cy], [x, cy + RING - 1]);
  }
  for (let y = cy + 1; y < cy + RING - 1; y += 1) {
    points.push([cx, y], [cx + RING - 1, y]);
  }
  return points;
}

function run(count) {
  const { game } = loadGame();
  const { state, startGame, place, removeStone, analyse, cellIndex } = game;
  startGame(2, DIM);

  const cols = Math.ceil(Math.sqrt(count));
  const rings = [];
  for (let i = 0; i < count; i += 1) {
    const cx = 100 + (i % cols) * STEP;
    const cy = 100 + Math.floor(i / cols) * STEP;
    rings.push(ringPoints(cx, cy));
    for (const [x, y] of rings[i]) {
      state.turn = 1;
      place({ x, y });
    }
  }
  analyse();

  const victim = rings[Math.floor(count / 2)][0];
  const t = now();
  removeStone(cellIndex(victim[0], victim[1]));
  state.analysis = null;
  const analysis = analyse();
  const elapsed = ms(t);
  const points = analysis.scores.reduce((sum, s) => sum + s.points, 0);
  const expected = count * (RING - 2) * (RING - 2);
  console.log(JSON.stringify({
    rings: count,
    removeAndAnalyseMs: +elapsed.toFixed(2),
    cached: state.componentSealed[1].size,
    points,
    expected,
    ok: points === expected,
  }));
}

for (const n of process.argv.slice(2).map(Number)) {
  run(n);
}
