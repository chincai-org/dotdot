"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { install } = require("./fake-dom");

const ROOT = path.resolve(__dirname, "..");

function loadGame(file = process.env.ENGINE || "main.js") {
  const { sandbox, elements } = install();
  const context = vm.createContext(sandbox);
  const source = fs.readFileSync(path.isAbsolute(file)
    ? file
    : path.join(ROOT, file), "utf8");
  const hooks = `
    globalThis.__game = {
      state, startGame, place, undo, analyse, isBlocked, computeScores,
      cellIndex, setStone, removeStone, enclosure, connectWall, draw,
      removeStones: typeof removeStones === "function" ? removeStones : null,
      restoreStones:
        typeof restoreStones === "function" ? restoreStones : null,
      historyMoveIndex:
        typeof historyMoveIndex === "function" ? historyMoveIndex : null,
      historyMovePlayer:
        typeof historyMovePlayer === "function" ? historyMovePlayer : null,
      historyRemovedStartAt:
        typeof historyRemovedStartAt === "function"
          ? historyRemovedStartAt : null,
      historyRemovedCountAt:
        typeof historyRemovedCountAt === "function"
          ? historyRemovedCountAt : null,
      historyRemovedIndexAt:
        typeof historyRemovedIndexAt === "function"
          ? historyRemovedIndexAt : null,
      historyRemovedPlayerAt:
        typeof historyRemovedPlayerAt === "function"
          ? historyRemovedPlayerAt : null,
      rebuildWalls: typeof rebuildWalls === "function" ? rebuildWalls : null,
      sweepWalls: typeof sweepWalls === "function" ? sweepWalls : null,
      compactWalls: typeof compactWalls === "function" ? compactWalls : null,
      wallsAreStale: typeof wallsAreStale === "function" ? wallsAreStale : null,
      ownerAt: typeof ownerAt === "function" ? ownerAt : null,
      stoneAt: typeof stoneAt === "function" ? stoneAt : null,
      visibleWindow: typeof visibleWindow === "function" ? visibleWindow : null,
      renderBoard: typeof renderBoard === "function" ? renderBoard : null,
      computeSealedPlayer:
        typeof computeSealedPlayer === "function" ? computeSealedPlayer : null,
      computeSealed: typeof computeSealed === "function" ? computeSealed : null,
      addSealedBands: typeof addSealedBands === "function" ? addSealedBands : null,
      unionBands: typeof unionBands === "function" ? unionBands : null,
      floodScratch: typeof floodOffsets === "undefined" ? null : () => ({
        offsets: floodOffsets.length,
        gaps: floodGapStart.length,
        reached: floodReached.length,
      }),
      wallStats: typeof state === "undefined" ? null : () => {
        const countSet = (value) => {
          if (value === undefined || value === null) return null;
          if (typeof value.size === "number") return value.size;
          return value.length;
        };
        const countNonZero = (value, stride) => {
          if (value === undefined || value === null) return null;
          if (typeof value.size === "number") return value.size;
          let count = 0;
          for (let i = 0; i < value.length; i += stride) {
            if (value[i] !== 0) count += 1;
          }
          return count;
        };
        return {
          parent: typeof state.wallParent.size === "number"
            ? state.wallParent.size : state.wallEntries,
          size: countNonZero(state.wallSize, 1),
          box: countNonZero(state.wallBox, 4),
          cycle: countNonZero(state.wallCycle, 1),
          children: countSet(state.wallChildren),
          dead: countSet(state.wallDead),
          roots: countNonZero(state.wallRootPlayer, 1),
          stoneTotal: state.stoneTotal,
          nextNode: typeof nextWallNode === "undefined" ? null : nextWallNode,
        };
      },
      bandAt: typeof bandAt === "function" ? bandAt : null,
      updateOwnerBands:
        typeof updateOwnerBands === "function" ? updateOwnerBands : null,
      rebuildOwnerBands:
        typeof rebuildOwnerBands === "function" ? rebuildOwnerBands : null,
      resize: typeof resize === "function" ? resize : null,
      updateOrigin:
        typeof updateOrigin === "function" ? updateOrigin : null,
      centerOnCursor:
        typeof centerOnCursor === "function" ? centerOnCursor : null,
      revealCursor:
        typeof revealCursor === "function" ? revealCursor : null,
      panBoard: typeof panBoard === "function" ? panBoard : null,
      boardSpanX: typeof boardSpanX === "function" ? boardSpanX : null,
      scrollSpanX: typeof scrollSpanX === "function" ? scrollSpanX : null,
      boardSpanY: typeof boardSpanY === "function" ? boardSpanY : null,
      scrollSpanY: typeof scrollSpanY === "function" ? scrollSpanY : null,
      boardToScrollX:
        typeof boardToScrollX === "function" ? boardToScrollX : null,
      scrollToBoardX:
        typeof scrollToBoardX === "function" ? scrollToBoardX : null,
    };
  `;
  vm.runInContext(`${source}\n${hooks}`, context, { filename: file });

  // Panels are collapsed in the fake DOM, so no history or score rows are
  // built unless a bench opens one. Canvas calls stay real (no-ops).
  return { game: sandbox.__game, elements, sandbox };
}

function now() {
  return process.hrtime.bigint();
}

function ms(start) {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function mem() {
  const m = process.memoryUsage();
  return {
    rss: Math.round(m.rss / 1048576),
    heap: Math.round(m.heapUsed / 1048576),
    arrayBuffers: Math.round(m.arrayBuffers / 1048576),
  };
}

function placeRing(game, cx, cy, size) {
  const half = Math.floor(size / 2);
  const x0 = cx - half;
  const x1 = cx + half;
  const y0 = cy - half;
  const y1 = cy + half;
  const points = [];
  for (let x = x0; x <= x1; x += 1) points.push([x, y0]);
  for (let y = y0 + 1; y <= y1; y += 1) points.push([x1, y]);
  for (let x = x1 - 1; x >= x0; x -= 1) points.push([x, y1]);
  for (let y = y1 - 1; y > y0; y -= 1) points.push([x0, y]);
  return points;
}

function bench(label, fn, iterations = 1) {
  const start = now();
  for (let i = 0; i < iterations; i += 1) {
    fn(i);
  }
  const elapsed = ms(start);
  console.log(
    `${label.padEnd(44)} ${elapsed.toFixed(2).padStart(9)} ms` +
    `  (${(elapsed / iterations).toFixed(3)} ms/op)`,
  );
  return elapsed;
}

function baseline() {
  console.log("node", process.version);
  console.log("baseline:", mem());

  const { game } = loadGame();
  const { state, startGame, place, undo, analyse } = game;

  let t = now();
  startGame(2, 13);
  console.log(`startGame(13)                ${ms(t).toFixed(2)} ms`, mem());

  t = now();
  startGame(2, 1000);
  console.log(`startGame(1000)              ${ms(t).toFixed(2)} ms`, mem());

  // Acyclic stones on a big open board: union-find gate should skip floods.
  t = now();
  for (let i = 0; i < 500; i += 1) {
    place({ x: 100 + (i % 50) * 2, y: 100 + Math.floor(i / 50) * 2 });
  }
  console.log(`500 scattered acyclic moves  ${ms(t).toFixed(2)} ms`, mem());

  startGame(2, 1000);
  const ring = placeRing(game, 500, 500, 100);
  const times = [];
  for (const [x, y] of ring) {
    t = now();
    place({ x, y });
    times.push(ms(t));
  }
  times.sort((a, b) => a - b);
  console.log(`ring ${ring.length} stones total    ${times.reduce((a, b) => a + b, 0).toFixed(2)} ms`);
  console.log(`  median ${times[Math.floor(times.length / 2)].toFixed(3)} ms  ` +
    `p95 ${times[Math.floor(times.length * 0.95)].toFixed(3)} ms  ` +
    `max ${times[times.length - 1].toFixed(3)} ms`);
  console.log("  closing move was the max above");

  t = now();
  const scores = analyse();
  console.log(`analyse after ring           ${ms(t).toFixed(2)} ms`,
    scores.scores.map((s) => s.points).join(","));

  t = now();
  undo();
  console.log(`undo closing move            ${ms(t).toFixed(2)} ms`, mem());
}

if (require.main === module) {
  baseline();
}

// History accessors that work for both the dense reference (array of records)
// and the packed sparse engine (typed columns). Tests only need the last move.
function historyLength(game) {
  const state = game.state;
  return state.historyLength === undefined
    ? state.history.length
    : state.historyLength;
}

function historyRemovedLength(game, at = historyLength(game) - 1) {
  const state = game.state;
  if (state.historyLength === undefined) {
    return state.history[at].removed.length;
  }
  return game.historyRemovedCountAt
    ? game.historyRemovedCountAt(at) : state.historyRemovedCount[at];
}

function historyRemoved(game, at = historyLength(game) - 1) {
  const state = game.state;
  if (state.historyLength === undefined) {
    return state.history[at].removed;
  }
  const start = game.historyRemovedStartAt
    ? game.historyRemovedStartAt(at) : state.historyRemovedStart[at];
  const count = game.historyRemovedCountAt
    ? game.historyRemovedCountAt(at) : state.historyRemovedCount[at];
  const removed = new Array(count);
  for (let i = 0; i < count; i += 1) {
    removed[i] = {
      index: game.historyRemovedIndexAt
        ? game.historyRemovedIndexAt(start + i)
        : state.historyRemovedIndex[start + i],
      player: game.historyRemovedPlayerAt
        ? game.historyRemovedPlayerAt(start + i)
        : state.historyRemovedPlayer[start + i],
    };
  }
  return removed;
}

module.exports = {
  loadGame, placeRing, bench, mem, now, ms, historyLength, historyRemovedLength,
  historyRemoved,
};
