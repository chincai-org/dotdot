"use strict";

const { loadGame, placeRing, now, ms, mem } = require("./run");

function spread(count, dim, players = 2) {
  const { game } = loadGame();
  game.startGame(players, dim);
  const t = now();
  let placed = 0;
  let seed = 123456789;
  for (let i = 0; i < count; i += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const x = seed % dim;
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const y = seed % dim;
    const index = y * dim + x;
    if (game.stoneAt(x, y) !== 0) continue;
    game.setStone(index, 1 + (i % players));
    placed += 1;
  }
  const placeMs = ms(t);
  const t2 = now();
  const analysis = game.analyse();
  const analyseMs = ms(t2);
  const points = analysis.scores.reduce((a, s) => a + s.points, 0);
  console.log(
    `${String(placed).padStart(8)} stones @${dim}  place ${placeMs.toFixed(0).padStart(7)} ms  ` +
    `analyse ${analyseMs.toFixed(2).padStart(7)} ms  points ${points}  ` +
    `${JSON.stringify(mem())}`,
  );
}

function ringWithDistantStone() {
  const { game } = loadGame();
  const { state, startGame, place, analyse } = game;
  startGame(2, 10000);
  const ring = placeRing(game, 5000, 5000, 1000);
  for (const [x, y] of ring) {
    state.turn = 1;
    place({ x, y });
  }
  const t = now();
  state.turn = 1;
  place({ x: 10, y: 10 }); // one far stone stretches player 1's bbox
  const moveMs = ms(t);
  const t2 = now();
  const scores = analyse().scores.map((s) => s.points).join(",");
  console.log(`distant stone after 1000 ring: move ${moveMs.toFixed(2)} ms  ` +
    `analyse ${ms(t2).toFixed(2)} ms  scores ${scores}`);
}

spread(100000, 10000, 2);
spread(1000000, 10000, 2);
ringWithDistantStone();
