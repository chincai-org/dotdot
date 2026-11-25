"use strict";

// One engine, one measurement run. Run in a fresh process so the dense and
// sparse memory numbers are not mixed. Prints a JSON line.

const { loadGame, placeRing, now, ms, mem } = require("./run");

const file = process.argv[2] || "main.js";
const dim = Number(process.argv[3] || 1000);
const ringSize = Number(process.argv[4] || 100);
const acyclicCount = Number(process.argv[5] || 500);

const { game } = loadGame(file);
const { state, startGame, place, undo, analyse } = game;

const tStart = now();
startGame(2, dim);
const startMs = ms(tStart);
const startMem = mem();

const tAcyclic = now();
for (let i = 0; i < acyclicCount; i += 1) {
  const x = 10 + (i % 100) * 3;
  const y = 10 + Math.floor(i / 100) * 3;
  state.turn = 1;
  place({ x, y });
}
const acyclicMs = ms(tAcyclic);
const acyclicMem = mem();

startGame(2, dim);
const ring = placeRing(game, Math.floor(dim / 2), Math.floor(dim / 2), ringSize);
const times = [];
for (const [x, y] of ring) {
  state.turn = 1;
  const t = now();
  place({ x, y });
  times.push(ms(t));
}
const ringTotal = times.reduce((a, b) => a + b, 0);
const sorted = times.slice().sort((a, b) => a - b);
const ringP50 = sorted[Math.floor(sorted.length / 2)];
const ringP95 = sorted[Math.floor(sorted.length * 0.95)];
const ringMax = sorted[sorted.length - 1];
const ringClosing = times[times.length - 1];
const ringMem = mem();

const tAnalyse = now();
state.analysis = null;
state.playerDirty[1] = 1;
const scores = analyse().scores.map((s) => s.points).join(",");
const analyseMs = ms(tAnalyse);

const tUndo = now();
undo();
const undoMs = ms(tUndo);

console.log(JSON.stringify({
  file,
  dim,
  ringSize,
  stones: ring.length,
  startMs,
  startMem,
  acyclicMs,
  acyclicMem,
  ringTotal,
  ringP50,
  ringP95,
  ringMax,
  ringClosing,
  ringMem,
  analyseMs,
  undoMs,
  scores,
}));
