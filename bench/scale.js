"use strict";

// Where does play start to feel slow? Board extent is almost free; wall
// length, region count and total stones are what cost. This measures the
// three things a player actually waits for: a normal move, a sealing move,
// and one composed frame.
//
//   node bench/scale.js

const { loadGame, now, ms } = require("./run");

function bench(fn, n) {
  for (let i = 0; i < 10; i += 1) fn();
  const t = now();
  for (let i = 0; i < n; i += 1) fn();
  return ms(t) / n;
}

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

// A. Board extent only, empty board.
function extent() {
  console.log("A. board extent, empty board, 2 players");
  for (const dim of [1000, 5000, 10000]) {
    const { game } = loadGame();
    const { state, startGame, place, renderBoard } = game;
    let t = now();
    startGame(2, dim);
    const startMs = ms(t);

    state.turn = 1;
    t = now();
    place({ x: Math.floor(dim / 2), y: Math.floor(dim / 2) });
    const moveMs = ms(t);

    const frameMs = bench(() => renderBoard(), 200);
    const dim2 = dim;
    console.log(
      `   ${String(dim2).padStart(5)} x ${dim2}  start ${startMs.toFixed(2)} ms  ` +
      `move ${moveMs.toFixed(3)} ms  frame ${frameMs.toFixed(3)} ms`,
    );
  }
}

// B. Closing a ring, by ring side. The flood walks the ring's bounding box.
function ringSide() {
  console.log("");
  console.log("B. sealing a ring, by side, 10,000 board");
  for (const size of [100, 500, 1000, 2000, 4000, 9998]) {
    const { game } = loadGame();
    const { state, startGame, place, analyse } = game;
    startGame(2, 10000);
    const mid = Math.floor(10000 / 2);
    const points = ringPoints(mid - Math.floor(size / 2),
      mid - Math.floor(size / 2), size);
    let closingMs = 0;
    for (const [x, y] of points) {
      state.turn = 1;
      const t = now();
      place({ x, y });
      closingMs = ms(t);
    }
    const a = analyse();
    const stones = points.length;
    console.log(
      `   side ${String(size).padStart(5)}  ${String(stones).padStart(6)} stones  ` +
      `closing move ${closingMs.toFixed(2).padStart(6)} ms  ` +
      `points ${a.scores[0].points}`,
    );
  }
}

// C. A wall network of N stones already on the board, then close one small
// ring elsewhere. The seal flood pays for every stone in the player's box.
function network() {
  console.log("");
  console.log("C. small ring closed next to N existing stones, 10,000 board");
  for (const count of [1000, 10000, 50000, 200000, 500000]) {
    const { game } = loadGame();
    const { state, startGame, place, setStone, computeSealed } = game;
    startGame(2, 10000);

    let seed = 987654321;
    let placed = 0;
    while (placed < count) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const x = seed % 5000;
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const y = seed % 5000;
      if (game.stoneAt(x, y) !== 0) continue;
      setStone(y * 10000 + x, 1);
      placed += 1;
    }

    const points = ringPoints(8000, 8000, 8);
    let closingMs = 0;
    for (const [x, y] of points) {
      state.turn = 1;
      const t = now();
      place({ x, y });
      closingMs = ms(t);
    }

    const t = now();
    computeSealed(1);
    const floodMs = ms(t);

    state.turn = 1;
    const t2 = now();
    place({ x: 100, y: 9000 });
    const moveMs = ms(t2);

    console.log(
      `   ${String(count).padStart(6)} stones  closing move ${closingMs.toFixed(1).padStart(7)} ms  ` +
      `flood ${floodMs.toFixed(1).padStart(6)} ms  normal move ${moveMs.toFixed(2)} ms`,
    );
  }
}

extent();
ringSide();
network();
