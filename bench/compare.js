"use strict";

const { loadGame, placeRing, now, ms, mem } = require("./run");

function forcePlace(game, x, y, player = 1) {
  game.state.turn = player;
  game.place({ x, y });
}

function ringBench(label, dim, size) {
  const { game } = loadGame();
  const { state, startGame, undo } = game;
  startGame(2, dim);
  const ring = placeRing(game, Math.floor(dim / 2), Math.floor(dim / 2), size);
  const times = [];
  for (const [x, y] of ring) {
    state.turn = 1;
    const t = now();
    game.place({ x, y });
    times.push(ms(t));
  }
  times.sort((a, b) => a - b);
  const total = times.reduce((a, b) => a + b, 0);
  const p50 = times[Math.floor(times.length / 2)];
  const p95 = times[Math.floor(times.length * 0.95)];
  const max = times[times.length - 1];
  const scores = game.analyse().scores.map((s) => s.points).join(",");
  const t = now();
  undo();
  const undoMs = ms(t);
  console.log(
    `${label.padEnd(30)} total ${total.toFixed(1).padStart(8)} ms  ` +
    `p50 ${p50.toFixed(3).padStart(7)}  p95 ${p95.toFixed(3).padStart(7)}  ` +
    `max ${max.toFixed(3).padStart(8)}  undo ${undoMs.toFixed(2).padStart(6)} ms  ` +
    `scores ${scores}  ${JSON.stringify(mem())}`,
  );
}

function acyclicBench(label, dim, count) {
  const { game } = loadGame();
  const { state, startGame } = game;
  startGame(2, dim);
  const t = now();
  for (let i = 0; i < count; i += 1) {
    const x = 10 + (i % 100) * 3;
    const y = 10 + Math.floor(i / 100) * 3;
    state.turn = 1;
    game.place({ x, y });
  }
  console.log(`${label.padEnd(30)} ${ms(t).toFixed(2).padStart(9)} ms  ` +
    `${JSON.stringify(mem())}`);
}

function startBench(label, dim) {
  const { game } = loadGame();
  const t = now();
  game.startGame(2, dim);
  console.log(`${label.padEnd(30)} ${ms(t).toFixed(2).padStart(9)} ms  ` +
    `${JSON.stringify(mem())}`);
}

const which = process.argv[2] || "all";

if (which === "all" || which === "start") {
  startBench("startGame(1000)", 1000);
  startBench("startGame(10000)", 10000);
}

if (which === "all" || which === "acyclic") {
  acyclicBench("500 acyclic moves @1000", 1000, 500);
  acyclicBench("500 acyclic moves @10000", 10000, 500);
}

if (which === "all" || which === "rings") {
  ringBench("ring 100 @1000", 1000, 100);
  ringBench("ring 400 @1000", 1000, 400);
  ringBench("ring 1000 @10000", 10000, 1000);
  ringBench("ring 2000 @10000", 10000, 2000);
  ringBench("ring 4000 @10000", 10000, 4000);
}
