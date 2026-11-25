"use strict";

// Closing a ring that has captured a huge number of stones. Captures used to
// remove one stone at a time, so every removal spliced the victim's row. The
// batch path groups victims by row and compacts each row once.
//
//   node --expose-gc bench/capture.js [victims] [side] [close|split]
//
// `close` times the whole closing move. `split` builds the ring through
// setStone, then times the flood and the batch removal separately, which is
// the engine cost with history and drawing left out.

const { loadGame, now, ms, historyRemovedLength } = require("./run");

const VICTIMS = Number(process.argv[2] || 100000);
const SIDE = Number(process.argv[3] ||
  (Math.ceil(Math.sqrt(VICTIMS)) + 2));
const MODE = process.argv[4] || "close";
const DIM = Math.max(10000, SIDE + 200);
const RUNS = 5;

function ringPoints(cx, cy, size) {
  const points = [];
  for (let x = cx; x < cx + size; x += 1) points.push([x, cy]);
  for (let y = cy + 1; y < cy + size; y += 1) {
    points.push([cx + size - 1, y]);
  }
  for (let x = cx + size - 2; x >= cx; x -= 1) {
    points.push([x, cy + size - 1]);
  }
  for (let y = cy + size - 2; y > cy; y -= 1) points.push([cx, y]);
  return points;
}

// Fill the open ring's interior with victim stones. Each victim row spreads
// its share across the full interior width, so no two victims share a cell.
function fillVictims(game, x0, y0, side, count) {
  const inner = side - 2;
  const rows = side - 2;
  const perRow = Math.ceil(count / rows);
  let left = count;
  for (let r = 0; r < rows && left > 0; r += 1) {
    const y = y0 + 1 + r;
    const take = Math.min(perRow, left, inner);
    for (let k = 0; k < take; k += 1) {
      const x = x0 + 1 + Math.floor((k + 0.5) * inner / take);
      game.setStone(y * DIM + x, 2);
      left -= 1;
    }
  }
  return count - left;
}

function setup(openAt = -1) {
  const { game } = loadGame();
  const { startGame } = game;
  startGame(2, DIM);
  const x0 = 100;
  const y0 = 100;
  const ring = ringPoints(x0, y0, SIDE);
  for (let i = 0; i < ring.length; i += 1) {
    if (i === openAt) {
      continue;
    }
    const [x, y] = ring[i];
    game.setStone(y * DIM + x, 1);
  }
  const placed = fillVictims(game, x0, y0, SIDE, VICTIMS);
  return { game, ring, placed };
}

if (MODE === "close") {
  for (let run = 0; run < RUNS; run += 1) {
    const openAt = Math.floor((SIDE * 4 - 4) / 2);
    const { game, ring, placed } = setup(openAt);
    // setStone built the component tree; this final place is the move that
    // closes the cycle and runs the capture.
    const cell = ring[openAt];
    game.state.turn = 1;
    if (global.gc) global.gc();

    const t = now();
    game.place({ x: cell[0], y: cell[1] });
    const closeMs = ms(t);
    const removed = historyRemovedLength(game);
    console.log(
      `${MODE} run ${run}  victims ${placed}  removed ${removed}  ` +
      `close ${closeMs.toFixed(1).padStart(6)} ms  ` +
      `${(closeMs * 1000 / Math.max(1, removed)).toFixed(2)} us/stone`,
    );
  }
} else if (MODE === "split") {
  for (let run = 0; run < RUNS; run += 1) {
    const { game, placed } = setup();
    const { computeSealed, removeStones, analyse } = game;
    if (global.gc) global.gc();

    let t = now();
    const spot = computeSealed(1);
    const floodMs = ms(t);
    const removed = spot.trapped.length;

    t = now();
    removeStones(spot.trapped);
    const removeMs = ms(t);

    t = now();
    const analysis = analyse();
    const analyseMs = ms(t);
    console.log(
      `${MODE} run ${run}  victims ${placed}  removed ${removed}  ` +
      `flood ${floodMs.toFixed(1).padStart(5)} ms  ` +
      `remove ${removeMs.toFixed(1).padStart(5)} ms  ` +
      `${(removeMs * 1000 / Math.max(1, removed)).toFixed(2)} us/stone  ` +
      `analyse ${analyseMs.toFixed(1)} ms  ` +
      `score ${analysis.scores[0].points}`,
    );
  }
} else if (MODE === "undo") {
  for (let run = 0; run < RUNS; run += 1) {
    const openAt = Math.floor((SIDE * 4 - 4) / 2);
    const { game, ring, placed } = setup(openAt);
    const cell = ring[openAt];
    game.state.turn = 1;
    game.place({ x: cell[0], y: cell[1] });
    const removed = historyRemovedLength(game);
    if (global.gc) global.gc();

    const t = now();
    game.undo();
    const undoMs = ms(t);
    console.log(
      `${MODE} run ${run}  victims ${placed}  restored ${removed}  ` +
      `undo ${undoMs.toFixed(1).padStart(6)} ms  ` +
      `${(undoMs * 1000 / Math.max(1, removed)).toFixed(2)} us/stone`,
    );
  }
} else {
  console.error("usage: node --expose-gc bench/capture.js " +
    "[victims] [side] [close|split|undo]");
  process.exit(1);
}
