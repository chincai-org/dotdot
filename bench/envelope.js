"use strict";

// Where does a 1,000,000-crossing board start to feel slow? Extent is now
// free; what remains is content: the wall being sealed, the number of sealed
// regions, and the rebuild after a removal. One section per process:
//
//   node bench/envelope.js extent
//   node bench/envelope.js ring
//   node bench/envelope.js wall
//   node bench/envelope.js repeat
//   node bench/envelope.js regions
//   node bench/envelope.js capture
//   node bench/envelope.js undo

const { loadGame, now, ms } = require("./run");

const DIM = 1000000;

function bench(fn, n) {
  for (let i = 0; i < Math.min(10, n); i += 1) {
    fn();
  }
  const t = now();
  for (let i = 0; i < n; i += 1) {
    fn();
  }
  return ms(t) / n;
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
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

function extent() {
  console.log("A. extent only, empty board, 2 players");
  console.log("     dim    start      move     frame    heap");
  for (const dim of [10000, 100000, 500000, 1000000]) {
    const { game } = loadGame();
    const { state, startGame, place, renderBoard } = game;
    let t = now();
    startGame(2, dim);
    const start = ms(t);

    const moves = [];
    for (let i = 0; i < 60; i += 1) {
      state.turn = 1;
      const x = (i * 7919) % dim;
      const y = (Math.floor(i / 3) * 104729 + i * 13) % dim;
      if (game.stoneAt(x, y) !== 0) {
        continue;
      }
      t = now();
      place({ x, y });
      moves.push(ms(t));
    }
    const frame = bench(() => renderBoard(), 200);
    if (global.gc) {
      global.gc();
    }
    console.log(
      `${String(dim).padStart(8)}  ${start.toFixed(2).padStart(6)} ms  ` +
      `${median(moves).toFixed(3).padStart(6)} ms  ` +
      `${frame.toFixed(3).padStart(6)} ms  ` +
      `${(process.memoryUsage().heapUsed / 1048576).toFixed(0).padStart(4)} MB`,
    );
  }
}

function ring() {
  console.log("B. closing a ring, 1,000,000 board, 2 players");
  console.log("    side   stones   closing move");
  for (const size of [100, 500, 1000, 2000, 4000, 8000, 16000]) {
    const { game } = loadGame();
    const { state, startGame, place } = game;
    startGame(2, DIM);
    const mid = Math.floor(DIM / 2);
    let closing = 0;
    for (const [x, y] of ringPoints(mid - Math.floor(size / 2),
      mid - Math.floor(size / 2), size)) {
      state.turn = 1;
      const t = now();
      place({ x, y });
      closing = ms(t);
    }
    console.log(
      `${String(size).padStart(7)}  ${String(4 * size - 4).padStart(6)}  ` +
      `${closing.toFixed(2).padStart(8)} ms`,
    );
  }
}

// One connected wall component spanning H rows, then a small ring closes at
// its top. The flood is scoped to the component, so its height is the cost.
// The ring body is placed through place() so every corner cycle caches its
// component; the last stone is a gap that actually seals the ring. A setStone
// setup has no cache yet, so it measures the fallback instead of real play.
function wall() {
  console.log("C. small ring on a connected wall spanning H rows, 1,000,000 board");
  console.log("       H rows   stones   closing move");
  for (const span of [10000, 25000, 50000, 100000, 250000, 500000, 990000]) {
    const { game } = loadGame();
    const { state, startGame, place, setStone } = game;
    startGame(2, DIM);

    const x0 = 100;
    const y0 = 10;
    const size = 8;
    const ring = ringPoints(x0, y0, size);
    const last = ring[ring.length - 1];

    // Vertical chain starts at the ring's bottom-left corner and runs down
    // `span` rows.
    for (let y = y0 + size - 1; y < y0 + size - 1 + span; y += 1) {
      setStone(y * DIM + x0, 1);
    }
    for (let i = 0; i < ring.length - 1; i += 1) {
      const [x, y] = ring[i];
      if (x === x0 && y >= y0 + size - 1) {
        continue; // already the first chain stone
      }
      state.turn = 1;
      place({ x, y });
    }

    state.turn = 1;
    const t = now();
    place({ x: last[0], y: last[1] });
    const closing = ms(t);

    if (global.gc) {
      global.gc();
    }
    console.log(
      `${String(span).padStart(11)}  ${String(span + ring.length).padStart(6)}  ` +
      `${closing.toFixed(2).padStart(8)} ms  ` +
      `${(process.memoryUsage().heapUsed / 1048576).toFixed(0)} MB`,
    );
  }
}

// Many small rings share one long wall as their left side. Each close is a
// cycle in the same component, so the first close pays the component flood and
// the rest should reuse its sealed cache instead of re-flooding the wall.
function repeat() {
  console.log("C2. 20 small rings on one connected wall, 1,000,000 board");
  console.log("       H rows   median close   total   points");
  for (const span of [10000, 100000, 990000]) {
    const { game } = loadGame();
    const { state, startGame, place, setStone, analyse } = game;
    startGame(2, DIM);

    const x0 = 100;
    const y0 = 10;
    const size = 8;
    const rings = 20;
    for (let y = y0; y < y0 + span; y += 1) {
      setStone(y * DIM + x0, 1);
    }

    const times = [];
    let points = 0;
    for (let r = 0; r < rings; r += 1) {
      const cy = y0 + r * (size + 4);
      const body = [];
      for (let x = x0 + 1; x < x0 + size; x += 1) body.push([x, cy]);
      for (let y = cy + 1; y < cy + size; y += 1) {
        body.push([x0 + size - 1, y]);
      }
      for (let x = x0 + size - 2; x > x0; x -= 1) {
        body.push([x, cy + size - 1]);
      }
      const last = body.pop();
      for (const [x, y] of body) {
        state.turn = 1;
        place({ x, y });
      }
      state.turn = 1;
      const t = now();
      place({ x: last[0], y: last[1] });
      times.push(ms(t));
      points = analyse().scores[0].points;
    }
    times.sort((a, b) => a - b);
    const total = times.reduce((a, b) => a + b, 0);
    const expected = rings * (size - 2) * (size - 2);
    console.log(
      `${String(span).padStart(11)}  ` +
      `${median(times).toFixed(3).padStart(12)} ms  ` +
      `${total.toFixed(2).padStart(6)} ms  ` +
      `${String(points).padStart(5)}/${expected}`,
    );
  }
}

function regions() {
  console.log("D. many sealed regions, 1,000,000 board, 2 players");
  console.log("    rings   first merge   seal move");
  const size = 6;
  const step = 16;
  for (const count of [25, 100, 400, 1600, 4000]) {
    const { game } = loadGame();
    const { state, startGame, place, setStone, analyse } = game;
    startGame(2, DIM);

    const cols = Math.ceil(Math.sqrt(count));
    for (let i = 0; i < count; i += 1) {
      const cx = 100 + (i % cols) * step;
      const cy = 100 + Math.floor(i / cols) * step;
      for (const [x, y] of ringPoints(cx, cy, size)) {
        setStone(y * DIM + x, 1);
      }
    }

    let t = now();
    analyse();
    const merge = ms(t);

    const cx = 100 + cols * step + 40;
    const cy = 100;
    let closing = 0;
    for (const [x, y] of ringPoints(cx, cy, size)) {
      state.turn = 1;
      t = now();
      place({ x, y });
      closing = ms(t);
    }
    console.log(
      `${String(count).padStart(8)}  ${merge.toFixed(2).padStart(9)} ms  ` +
      `${closing.toFixed(2).padStart(8)} ms`,
    );
  }
}

function capture() {
  console.log("E. seal that captures a victim with far-apart stones, 2 players");
  console.log("       dim   closing move   victim bbox rows");
  for (const dim of [100000, 500000, 1000000]) {
    const { game } = loadGame();
    const { state, startGame, place, setStone } = game;
    startGame(2, dim);

    const mid = Math.floor(dim / 2);
    // Victim stones at opposite corners, plus one inside the mover's ring.
    setStone(10 * dim + 10, 2);
    setStone((dim - 10) * dim + (dim - 10), 2);
    setStone(mid * dim + mid, 2);

    let closing = 0;
    for (const [x, y] of ringPoints(mid - 3, mid - 3, 8)) {
      state.turn = 1;
      const t = now();
      place({ x, y });
      closing = ms(t);
    }
    console.log(
      `${String(dim).padStart(10)}  ${closing.toFixed(2).padStart(11)} ms  ` +
      `${String(dim - 20).padStart(15)}`,
    );
  }
}

function undoCase() {
  console.log("F. undo the closing move, mover has a far stone, 2 players");
  console.log("       dim   undo move");
  for (const dim of [100000, 500000, 1000000]) {
    const { game } = loadGame();
    const { state, startGame, place, undo } = game;
    startGame(2, dim);

    const mid = Math.floor(dim / 2);
    state.turn = 1;
    place({ x: 10, y: 10 }); // far stone, separate component
    for (const [x, y] of ringPoints(mid - 3, mid - 3, 8)) {
      state.turn = 1;
      place({ x, y });
    }

    const t = now();
    undo();
    const undoMs = ms(t);
    console.log(`${String(dim).padStart(10)}  ${undoMs.toFixed(2).padStart(9)} ms`);
  }
}

const mode = process.argv[2];
const modes = {
  extent, ring, wall, repeat, regions, capture, undo: undoCase,
};
if (modes[mode] === undefined) {
  console.error(`usage: node bench/envelope.js ${Object.keys(modes).join("|")}`);
  process.exit(1);
}
modes[mode]();
