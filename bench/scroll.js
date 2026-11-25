"use strict";

// Virtual scroll mapping: the spacer is capped, board coordinates are not.
// Checks that the far corner is reachable, that centring and revealing map
// back to the right board point, and that panning scales with the virtual
// range. Fake DOM, so the browser's own scroll clamping is not exercised.
//
//   node bench/scroll.js

const { loadGame } = require("./run");

const { game, elements, sandbox } = loadGame();
const { state, startGame, updateOrigin, centerOnCursor, revealCursor,
  panBoard } = game;
const wrap = elements.get("board-wrap");

let failures = 0;
const near = (a, b, tolerance = 2) => Math.abs(a - b) <= tolerance;

function check(name, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) {
    failures += 1;
  }
}

function maxScrollX() {
  return Math.max(0, state.spacerCssW - state.viewCssW);
}

function maxScrollY() {
  return Math.max(0, state.spacerCssH - state.viewCssH);
}

function testExtent(dim, dpr) {
  sandbox.window.devicePixelRatio = dpr;
  startGame(2, dim);
  const tag = `${dim} @ dpr${dpr}`;

  check(`${tag} spacer capped`,
    state.spacerCssW <= 4000000 && state.spacerCssH <= 4000000,
    `${state.spacerCssW} x ${state.spacerCssH}`);

  wrap.scrollLeft = maxScrollX();
  wrap.scrollTop = maxScrollY();
  updateOrigin();
  check(`${tag} far corner reachable`,
    near(state.originX, state.boardPx - state.viewW) &&
    near(state.originY, state.boardPx - state.viewH),
    `${state.originX},${state.originY}`);

  state.cursor = { x: Math.floor(dim / 2), y: Math.floor(dim / 2) };
  centerOnCursor();
  const wantX = Math.max(0, Math.min(state.boardPx - state.viewW,
    state.pad + state.cursor.x * state.spacing - state.viewW / 2));
  const wantY = Math.max(0, Math.min(state.boardPx - state.viewH,
    state.pad + state.cursor.y * state.spacing - state.viewH / 2));
  check(`${tag} centre cursor`,
    near(state.originX, wantX) && near(state.originY, wantY),
    `${state.originX},${state.originY} want ${wantX},${wantY}`);

  state.cursor = { x: 0, y: 0 };
  revealCursor();
  check(`${tag} reveal top-left`, wrap.scrollLeft === 0 && wrap.scrollTop === 0,
    `${wrap.scrollLeft},${wrap.scrollTop}`);
}

testExtent(1000000, 1);
testExtent(1000000, 2);
testExtent(94000000, 1);
testExtent(94000000, 2);

// A board that fits is centred and needs no virtual range.
startGame(2, 13);
check("small board spacer = board",
  near(state.spacerCssW, state.boardCss, 1), `${state.spacerCssW}`);
check("small board scroll 0", wrap.scrollLeft === 0 && wrap.scrollTop === 0);
check("small board centred",
  near(state.originX, (state.boardPx - state.viewW) / 2),
  `${state.originX}`);

// Panning moves the same number of board cells regardless of the mapping.
startGame(2, 1000000);
const step = (state.spacing / state.dpr) * 3;
const scale = game.scrollSpanX() / game.boardSpanX();
wrap.scrollLeft = 0;
updateOrigin();
panBoard(1, 0);
check("pan scales with virtual range",
  near(wrap.scrollLeft, step * scale, 1),
  `${wrap.scrollLeft} want ${step * scale}`);

// Flat cell indices must stay exact at the cap: dim*dim has to sit below
// 2^53, otherwise y*dim+x rounds and two crossings collide.
const CAP = 94000000;
startGame(2, CAP);
check("cap below 2^53", CAP * CAP < 2 ** 53,
  `${CAP * CAP} vs ${2 ** 53}`);
for (const [x, y] of [[0, 0], [CAP - 1, 0], [0, CAP - 1],
  [CAP - 1, CAP - 1], [CAP - 1, CAP - 2]]) {
  const index = game.cellIndex(x, y);
  check(`cap index exact ${x},${y}`,
    Number.isSafeInteger(index) && index % CAP === x &&
    (index - x) / CAP === y,
    `${index}`);
}

console.log("");
if (failures === 0) {
  console.log("scroll: all ok");
} else {
  console.error(`scroll: ${failures} failure(s)`);
  process.exit(1);
}
