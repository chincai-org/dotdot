"use strict";

// Frame composition cost at realistic window sizes, and what a margin cache
// would save while panning. Fake DOM, so this measures the JavaScript passes
// and the number of canvas calls; actual raster cost is browser-only.
//
//   node bench/frame.js

const { loadGame, now, ms } = require("./run");

const { game } = loadGame();
const { state, startGame, renderBoard, visibleWindow } = game;

// Corners on screen, given a CSS window and a CSS cell size. DPR doubles both
// the backing pixels and the spacing, so the corner count depends on CSS size.
const VIEWS = [
  { name: "1080p dpr1", w: 1920, h: 1080, cell: 32, dpr: 1 },
  { name: "1080p dpr2", w: 3840, h: 2160, cell: 64, dpr: 2 },
  { name: "4K    dpr1", w: 3840, h: 2160, cell: 32, dpr: 1 },
  { name: "4K    dpr2", w: 7680, h: 4320, cell: 64, dpr: 2 },
];

function bench(fn, n = 200) {
  for (let i = 0; i < 20; i += 1) {
    fn();
  }
  const t = now();
  for (let i = 0; i < n; i += 1) {
    fn();
  }
  return ms(t) / n;
}

function layout(view) {
  state.viewW = view.w;
  state.viewH = view.h;
  state.dpr = view.dpr;
  state.spacing = view.cell;
  state.pad = 28 * view.dpr;
  state.originX = 0;
  state.originY = 0;
}

startGame(2, 10000);
state.rows.clear(); // measure the empty-board case, the common one while panning
state.analysis = null;

console.log("pan frame cost (empty 10,000 board, one composed frame)");
console.log("");
console.log(
  "window".padEnd(12) + "corners".padStart(8) + "  renderBoard".padStart(13) +
  "  visibleWindow".padStart(14) + "  recenters/60f@33px".padStart(20),
);

for (const view of VIEWS) {
  layout(view);
  const view0 = visibleWindow();
  const corners = view0.w * view0.h;
  const render = bench(() => renderBoard());
  const windowMs = bench(() => visibleWindow(), 2000);
  // A fling at ~2000 device px/s moves 33 px per frame. With a 128 device px
  // margin, a full recompose is needed once per 128/33 frames.
  const recenters = 60 * (33 / 128);
  console.log(
    view.name.padEnd(12) + String(corners).padStart(8) +
    `${render.toFixed(3)} ms`.padStart(13) +
    `${(windowMs * 1000).toFixed(1)} us`.padStart(14) +
    `${recenters.toFixed(1)} vs 60`.padStart(20),
  );
}

console.log("");
console.log(
  "Margin cache memory at 128 device px border:",
);
for (const view of VIEWS) {
  const extra = ((view.w + 256) * (view.h + 256) - view.w * view.h) * 4;
  console.log(
    `  ${view.name}: +${(extra / (1024 * 1024)).toFixed(1)} MB backing store`,
  );
}
