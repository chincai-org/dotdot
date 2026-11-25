"use strict";

const { loadGame, historyLength, historyRemoved } = require("./run");

// ENGINE lets the same comparison run against a candidate engine file.
const FAST_ENGINE = process.env.ENGINE || "main.js";

function rng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function snapshot(game, dim, optimized) {
  const { state, analyse } = game;
  const analysis = analyse();
  const stones = [];
  const owners = [];
  for (let y = 0; y < dim; y += 1) {
    for (let x = 0; x < dim; x += 1) {
      const index = y * dim + x;
      stones.push(optimized ? game.stoneAt(x, y) : state.playerAt[index]);
      owners.push(optimized
        ? game.ownerAt(x, y)
        : analysis.owner[index]);
    }
  }
  return {
    stones,
    owners,
    scores: analysis.scores.map((s) => s.points),
    turn: state.turn,
    moves: historyLength(game),
  };
}

function compare(label, dense, fast, dim) {
  const a = snapshot(dense, dim, false);
  const b = snapshot(fast, dim, true);
  const fail = (what) => {
    console.error(`MISMATCH ${label}: ${what}`);
    console.error("dense", JSON.stringify({
      scores: a.scores, turn: a.turn, moves: a.moves,
    }));
    console.error("fast ", JSON.stringify({
      scores: b.scores, turn: b.turn, moves: b.moves,
    }));
    for (let i = 0; i < a.stones.length; i += 1) {
      if (a.stones[i] !== b.stones[i] || a.owners[i] !== b.owners[i]) {
        const x = i % dim;
        const y = (i - x) / dim;
        console.error(`first diff at ${x},${y}: dense stone ${a.stones[i]} ` +
          `owner ${a.owners[i]}; fast stone ${b.stones[i]} ` +
          `owner ${b.owners[i]}`);
        break;
      }
    }
    process.exit(1);
  };
  for (let i = 0; i < a.stones.length; i += 1) {
    if (a.stones[i] !== b.stones[i]) fail(`stone at cell ${i}`);
    if (a.owners[i] !== b.owners[i]) fail(`owner at cell ${i}`);
  }
  for (let i = 0; i < a.scores.length; i += 1) {
    if (a.scores[i] !== b.scores[i]) fail(`score player ${i + 1}`);
  }
  if (a.turn !== b.turn) fail("turn");
  if (a.moves !== b.moves) fail("move count");
}

function randomGame(seed, dim, players, steps) {
  const next = rng(seed);
  const dense = loadGame("bench/reference-dense.js").game;
  const fast = loadGame(FAST_ENGINE).game;
  dense.startGame(players, dim);
  fast.startGame(players, dim);

  for (let step = 0; step < steps; step += 1) {
    const undo = historyLength(dense) > 0 && next() < 0.18;
    if (undo) {
      dense.undo();
      fast.undo();
    } else {
      const legal = [];
      for (let y = 0; y < dim; y += 1) {
        for (let x = 0; x < dim; x += 1) {
          if (dense.state.playerAt[y * dim + x] !== 0) continue;
          if (dense.isBlocked({ x, y })) continue;
          legal.push([x, y]);
        }
      }
      if (legal.length === 0) {
        if (historyLength(dense) === 0) break;
        dense.undo();
        fast.undo();
      } else {
        const pick = legal[Math.floor(next() * legal.length)];
        dense.place({ x: pick[0], y: pick[1] });
        fast.place({ x: pick[0], y: pick[1] });
        const dr = historyRemoved(dense);
        const fr = historyRemoved(fast);
        const dk = dr.map((r) => r.index).sort((p, q) => p - q).join(",");
        const fk = fr.map((r) => r.index).sort((p, q) => p - q).join(",");
        if (dk !== fk) {
          console.error(`MISMATCH captures seed ${seed} step ${step}: ` +
            `dense [${dk}] fast [${fk}]`);
          process.exit(1);
        }
      }
    }
    compare(`seed ${seed} dim ${dim} players ${players} step ${step}`,
      dense, fast, dim);
  }
}

function forcedRing(dim, players) {
  const dense = loadGame("bench/reference-dense.js").game;
  const fast = loadGame(FAST_ENGINE).game;
  dense.startGame(players, dim);
  fast.startGame(players, dim);

  const cx = Math.floor(dim / 2);
  const cy = Math.floor(dim / 2);
  const size = Math.max(6, Math.min(dim - 2, 12));
  const half = Math.floor(size / 2);
  const x0 = cx - half;
  const x1 = cx + half;
  const y0 = cy - half;
  const y1 = cy + half;

  // A blue stone inside the red ring, plus a blue wall fragment.
  const blue = [[cx, cy], [cx + 1, cy], [cx, cy + 1]];
  for (const [x, y] of blue) {
    const index = y * dim + x;
    dense.setStone(index, 2);
    fast.setStone(index, 2);
  }

  const ring = [];
  for (let x = x0; x <= x1; x += 1) ring.push([x, y0]);
  for (let y = y0 + 1; y <= y1; y += 1) ring.push([x1, y]);
  for (let x = x1 - 1; x >= x0; x -= 1) ring.push([x, y1]);
  for (let y = y1 - 1; y > y0; y -= 1) ring.push([x0, y]);

  for (const [x, y] of ring) {
    dense.state.turn = 1;
    fast.state.turn = 1;
    dense.place({ x, y });
    fast.place({ x, y });
    compare(`forced ring ${dim}/${players} at ${x},${y}`, dense, fast, dim);
  }
  if (fast.state.playerCount < 2) throw new Error("player count");
}

const cases = [
  [1, 5, 2, 120],
  [2, 5, 3, 120],
  [3, 6, 2, 150],
  [4, 7, 4, 150],
  [5, 9, 2, 180],
  [6, 13, 2, 200],
  [7, 13, 5, 200],
  [8, 20, 2, 150],
];

for (const [seed, dim, players, steps] of cases) {
  randomGame(seed, dim, players, steps);
  console.log(`ok random seed ${seed} dim ${dim} players ${players}`);
}
for (const [dim, players] of [[7, 2], [9, 3], [13, 2]]) {
  forcedRing(dim, players);
  console.log(`ok forced ring dim ${dim} players ${players}`);
}
console.log("differential: all ok");

function randomWalls(seed, dim, players, stones) {
  const next = rng(seed);
  const dense = loadGame("bench/reference-dense.js").game;
  const fast = loadGame(FAST_ENGINE).game;
  dense.startGame(players, dim);
  fast.startGame(players, dim);
  const used = new Set();
  for (let i = 0; i < stones; i += 1) {
    const x = Math.floor(next() * dim);
    const y = Math.floor(next() * dim);
    const index = y * dim + x;
    if (used.has(index)) continue;
    used.add(index);
    const player = 1 + Math.floor(next() * players);
    dense.setStone(index, player);
    fast.setStone(index, player);
  }
  compare(`random walls seed ${seed} dim ${dim} players ${players}`,
    dense, fast, dim);
}

for (const [seed, dim, players, stones] of [
  [11, 5, 2, 8],
  [12, 6, 2, 12],
  [13, 7, 3, 18],
  [14, 9, 2, 30],
  [15, 12, 3, 50],
  [16, 15, 2, 80],
  [17, 20, 4, 120],
]) {
  randomWalls(seed, dim, players, stones);
  console.log(`ok random walls seed ${seed} dim ${dim}`);
}

function forcedShape(name, dim, players, ring, inside) {
  const dense = loadGame("bench/reference-dense.js").game;
  const fast = loadGame(FAST_ENGINE).game;
  dense.startGame(players, dim);
  fast.startGame(players, dim);

  for (const [x, y] of inside) {
    const index = y * dim + x;
    dense.setStone(index, 2);
    fast.setStone(index, 2);
  }
  for (const [x, y] of ring) {
    dense.state.turn = 1;
    fast.state.turn = 1;
    dense.place({ x, y });
    fast.place({ x, y });
    compare(`shape ${name} at ${x},${y}`, dense, fast, dim);
  }
  const dRemoved = historyRemoved(dense).length;
  const fRemoved = historyRemoved(fast).length;
  if (dRemoved !== fRemoved) {
    console.error(`MISMATCH ${name} captures ${dRemoved} vs ${fRemoved}`);
    process.exit(1);
  }
  dense.undo();
  fast.undo();
  compare(`shape ${name} undo`, dense, fast, dim);
}

function diamond(cx, cy, r) {
  const points = [];
  const seen = new Set();
  for (let dx = -r; dx <= r; dx += 1) {
    const dy = r - Math.abs(dx);
    for (const y of [cy + dy, cy - dy]) {
      const key = `${cx + dx},${y}`;
      if (!seen.has(key)) {
        seen.add(key);
        points.push([cx + dx, y]);
      }
    }
  }
  return points;
}

forcedShape("diamond 5", 13, 2, diamond(6, 6, 5), [[6, 6], [6, 5]]);
forcedShape("diamond 3", 9, 3, diamond(4, 4, 3), [[4, 4]]);
forcedShape("edge ring", 10, 2, (() => {
  const p = [];
  for (let x = 0; x <= 6; x += 1) p.push([x, 0]);
  for (let y = 1; y <= 5; y += 1) p.push([6, y]);
  for (let x = 5; x >= 0; x -= 1) p.push([x, 5]);
  for (let y = 4; y >= 1; y -= 1) p.push([0, y]);
  return p;
})(), [[3, 3], [3, 2]]);
console.log("ok diamond and edge shapes");

// Several separate sealed regions on one board, so the incremental owner-run
// patch is exercised across unrelated rows, plus undo through two of them.
function manyRings(dim, players) {
  const dense = loadGame("bench/reference-dense.js").game;
  const fast = loadGame(FAST_ENGINE).game;
  dense.startGame(players, dim);
  fast.startGame(players, dim);

  const spots = [
    [2, 2, 1], [15, 2, 2], [2, 15, 2], [15, 15, 1],
  ];
  const size = 6;

  // A couple of victim stones inside the last ring, for a capture.
  for (const [x, y] of [[17, 17], [18, 17]]) {
    const index = y * dim + x;
    dense.setStone(index, 2);
    fast.setStone(index, 2);
  }

  const placeRingAt = (cx, cy, player, label) => {
    const ring = [[cx, cy], [cx + size - 1, cy],
      [cx, cy + size - 1], [cx + size - 1, cy + size - 1]];
    for (let x = cx + 1; x < cx + size - 1; x += 1) {
      ring.push([x, cy], [x, cy + size - 1]);
    }
    for (let y = cy + 1; y < cy + size - 1; y += 1) {
      ring.push([cx, y], [cx + size - 1, y]);
    }
    for (const [x, y] of ring) {
      dense.state.turn = player;
      fast.state.turn = player;
      dense.place({ x, y });
      fast.place({ x, y });
      compare(`${label} ${dim} at ${x},${y}`, dense, fast, dim);
    }
  };

  spots.forEach(([cx, cy, player], i) => {
    placeRingAt(cx, cy, player, `many ring ${i}`);
  });

  const moves = spots.length * (4 + 4 * (size - 2));
  for (let i = 0; i < moves; i += 1) {
    dense.undo();
    fast.undo();
    compare(`many rings undo ${i}`, dense, fast, dim);
  }

  // Re-close the last ring after the undos.
  placeRingAt(15, 15, 1, "many ring redo");
}

manyRings(25, 2);
console.log("ok many separate rings + undo");

// Two sealed rings owned by one player: the inner ring seals first, then a
// larger ring around it. The outer flood sees the inner wall as an obstacle,
// and the player's sealed cache is a union of both components.
function nestedSamePlayer(dim) {
  const dense = loadGame("bench/reference-dense.js").game;
  const fast = loadGame(FAST_ENGINE).game;
  dense.startGame(2, dim);
  fast.startGame(2, dim);

  const placeRingAt = (cx, cy, size, player, label) => {
    const ring = [[cx, cy], [cx + size - 1, cy],
      [cx, cy + size - 1], [cx + size - 1, cy + size - 1]];
    for (let x = cx + 1; x < cx + size - 1; x += 1) {
      ring.push([x, cy], [x, cy + size - 1]);
    }
    for (let y = cy + 1; y < cy + size - 1; y += 1) {
      ring.push([cx, y], [cx + size - 1, y]);
    }
    for (const [x, y] of ring) {
      dense.state.turn = player;
      fast.state.turn = player;
      dense.place({ x, y });
      fast.place({ x, y });
      compare(`${label} ${dim} at ${x},${y}`, dense, fast, dim);
    }
  };

  placeRingAt(10, 10, 5, 1, "nested inner");
  placeRingAt(6, 6, 13, 1, "nested outer");

  // Undo reopens the outer region. The rebuild must drop it and keep the
  // inner one, without reporting the same trapped stone twice.
  for (let i = 0; i < 3; i += 1) {
    dense.undo();
    fast.undo();
    compare(`nested undo ${i}`, dense, fast, dim);
  }
}

nestedSamePlayer(25);
console.log("ok nested same-player rings");

// A stone placed directly inside an already-cached sealed band (undo restore,
// or the test harness) must clear the band's clean flag and split that row.
// Normal moves cannot do this: isBlocked refuses sealed ground.
function stoneInsideSealed(dim) {
  const dense = loadGame("bench/reference-dense.js").game;
  const fast = loadGame(FAST_ENGINE).game;
  dense.startGame(2, dim);
  fast.startGame(2, dim);

  const ring = [];
  for (let x = 1; x <= 6; x += 1) ring.push([x, 1], [x, 6]);
  for (let y = 2; y <= 5; y += 1) ring.push([1, y], [6, y]);
  for (const [x, y] of ring) {
    dense.state.turn = 1;
    fast.state.turn = 1;
    dense.place({ x, y });
    fast.place({ x, y });
  }
  compare(`inside sealed ${dim}: ring`, dense, fast, dim);

  for (const [x, y, player] of [[3, 3, 2], [4, 4, 1]]) {
    const index = y * dim + x;
    dense.setStone(index, player);
    fast.setStone(index, player);
    compare(`inside sealed ${dim}: insert ${x},${y}`, dense, fast, dim);
  }

  // Removing the stone must leave the still-sealed rows exact too.
  dense.removeStone(3 * dim + 3);
  fast.removeStone(3 * dim + 3);
  compare(`inside sealed ${dim}: remove`, dense, fast, dim);
}

stoneInsideSealed(9);
console.log("ok stone inside sealed band");

// A stone on the far side of the board must not inflate the seal flood.
function farStray(dim) {
  const dense = loadGame("bench/reference-dense.js").game;
  const fast = loadGame(FAST_ENGINE).game;
  dense.startGame(2, dim);
  fast.startGame(2, dim);

  const index = 1 * dim + 1;
  dense.setStone(index, 1);
  fast.setStone(index, 1);

  const ring = [[15, 15], [21, 15], [15, 21], [21, 21]];
  for (let x = 16; x < 21; x += 1) ring.push([x, 15], [x, 21]);
  for (let y = 16; y < 21; y += 1) ring.push([15, y], [21, y]);
  for (const [x, y] of ring) {
    dense.state.turn = 1;
    fast.state.turn = 1;
    dense.place({ x, y });
    fast.place({ x, y });
    compare(`far stray ${dim} at ${x},${y}`, dense, fast, dim);
  }
}

farStray(31);
console.log("ok far stray stone");
