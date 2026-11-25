"use strict";

/* Board: dim x dim grid of boxes; stones sit on line crossings.

   Players: 2 to 48, chosen in the floating toolbar. Board size: any whole
   number of crossings from BOARD_SIZE_MIN to BOARD_SIZE_MAX (5 to 1000 by
   default; edit the constants below to change the cap). Changing either
   starts a fresh game. Cell size stays fixed and the board scrolls; only the
   visible slice is ever drawn, so board size costs cell grids, not pixels.

   Rules: a closed ring of one colour owns everything inside it, no matter
   how many empty crossings (liberties) stay open. Enclosed opponent stones
   are eaten (removed), and the whole interior is painted with the ring
   colour. Bigger ring beats smaller ring. Diagonal stones count as
   touching, so a diagonal wall is closed too. Nobody may place a stone
   inside a region that is already sealed.

   Performance: flood fills run on flat typed-array grids with integer
   indices and reused buffers, and only the mover is flooded for captures
   because a removed stone can only open a wall, never close one. A stone
   that closes no cycle in its colour's wall graph cannot seal anything, so
   its move skips the flood completely. Each player's enclosure is cached
   until that player's stones change. Undo stores one move delta, the visible
   frame is cached until the stones or scroll position change, stones are
   batched into one path per player, and territory is painted as merged unit
   faces inside the walls, out to the wall lines. */

// ---- config ----------------------------------------------------------

const BOARD_SIZE_DEFAULT = 13; // default crossings per row and column
const BOARD_SIZE_MIN = 5;      // smallest selectable board
// Largest selectable board. Rendering is viewport-only, so the canvas cost
// does not grow with this. The remaining cost is the dim*dim cell grids (a
// few bytes per crossing); 1000 means ~1M crossings and ~20 MB of grids.
const BOARD_SIZE_MAX = 1000;

// A sealed region needs a wall all the way round, and the smallest closed
// wall is the four crossings around a single cell. Fewer stones cannot
// enclose anything, so the floods below skip them.
const MIN_RING_STONES = 4;
const CELL_MIN_CSS = 32;       // preferred smallest cell; big boards scroll
const CELL_MAX_CSS = 64;       // largest cell, so tiny boards do not balloon
const PADDING_CSS = 28;        // board margin, css pixels
const DOT_RADIUS_RATIO = 0.40; // stone radius, fraction of spacing
const LINE_WIDTH_CSS = 0.8;    // grid line thickness, in css pixels
const LINK_WIDTH_RATIO = 0.10; // link thickness, fraction of spacing
const DRAG_TOLERANCE_PX = 8;   // press-to-release drift before it is a drag
const ARROW_STEP_CELLS = 3;    // cells panned per shift+arrow press
const CURSOR_MARGIN_CELLS = 1; // keep the keyboard cursor this far from the edge
const DPR_MAX = 2;             // cap backing-store pixels on 3x phone screens

// Cell size stays fixed at CELL_MIN_CSS and the board scrolls, no matter how
// large it gets, because only the visible frame is ever drawn. See resize()
// and the scroll handler: the canvas is viewport-sized, a spacer carries the
// board's full size for the scrollbars, and originX/originY select the slice
// of the board shown.

const COLOR_LINE = "#3f2c15";
const COLOR_COUNT = 24;       // distinct colours, reused by the cross shape
const MAX_PLAYERS = COLOR_COUNT * 2;
const COLOR_PLAYER = {
  1: "#d43a34",  // red
  2: "#2f6fd8",  // blue
  3: "#2f9e5f",  // green
  4: "#e5b82e",  // yellow
  5: "#8e5bd0",  // purple
  6: "#e8802a",  // orange
  7: "#2fb7c4",  // cyan
  8: "#e05a9e",  // pink
  9: "#8b5a2b",  // brown
  10: "#1f1f1f", // black
  11: "#f2f0e6", // white
  12: "#8a8f98", // gray
  13: "#a4d928", // lime
  14: "#0f8f8f", // teal
  15: "#7b1f2b", // maroon
  16: "#ff69b4", // hot pink
  17: "#f5e27a", // banana
  18: "#b08968", // tan
  19: "#ff6f5e", // coral
  20: "#40826d", // viridian
  21: "#8b008b", // dark magenta
  22: "#ffb07c", // peach
  23: "#cd7f32", // bronze
  24: "#7fa650", // artichoke
};
const NAME_PLAYER = {
  1: "Red",
  2: "Blue",
  3: "Green",
  4: "Yellow",
  5: "Purple",
  6: "Orange",
  7: "Cyan",
  8: "Pink",
  9: "Brown",
  10: "Black",
  11: "White",
  12: "Gray",
  13: "Lime",
  14: "Teal",
  15: "Maroon",
  16: "Hot Pink",
  17: "Banana",
  18: "Tan",
  19: "Coral",
  20: "Viridian",
  21: "Dark Magenta",
  22: "Peach",
  23: "Bronze",
  24: "Artichoke",
};

// 4 of the 8 neighbour directions. Right/down halves cover all pairs.
const LINK_DIRECTIONS = [
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 1, dy: 1 },
  { dx: 1, dy: -1 },
];

// Triangles for a face split by a diagonal wall, indexed by the owned corner:
// A(top-left), B(top-right), C(bottom-left), D(bottom-right). The other two
// corners of each triangle are the diagonal wall's stones.
const HALF_FACES = [
  [[0, 0], [1, 0], [0, 1]], // A owned, wall B-C
  [[1, 0], [0, 0], [1, 1]], // B owned, wall A-D
  [[0, 1], [0, 0], [1, 1]], // C owned, wall A-D
  [[1, 1], [1, 0], [0, 1]], // D owned, wall B-C
];

// All 8 neighbours, used by the wall-cycle check: touching stones of one
// colour form the wall graph, and only a cycle can seal a region.
const WALL_DIRECTIONS = [
  { dx: -1, dy: -1 }, { dx: 0, dy: -1 }, { dx: 1, dy: -1 },
  { dx: -1, dy: 0 }, { dx: 1, dy: 0 },
  { dx: -1, dy: 1 }, { dx: 0, dy: 1 }, { dx: 1, dy: 1 },
];

// Flood uses 4-way moves against flat row-major indices in enclosure().
// Stones sit on crossings, so a diagonal chain still blocks the flood: there
// is no orthogonal cell between two diagonally touching stones.

// ---- elements --------------------------------------------------------

const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");
invariant(ctx !== null, "2d context unavailable for board");
const statusEl = document.getElementById("status");
const undoBtn = document.getElementById("undo");
const clearBtn = document.getElementById("clear");
const playersInput = document.getElementById("players");
const playersDecBtn = document.getElementById("players-dec");
const playersIncBtn = document.getElementById("players-inc");
const boardInput = document.getElementById("board-size");
const boardDecBtn = document.getElementById("board-dec");
const boardIncBtn = document.getElementById("board-inc");
const boardWrap = document.getElementById("board-wrap");
const boardSpacer = document.getElementById("board-spacer");
const coordXInput = document.getElementById("coord-x");
const coordYInput = document.getElementById("coord-y");
const hudEl = document.getElementById("hud");
const controlsEl = document.getElementById("controls");
const controlsTab = document.getElementById("controls-tab");
const scoresEl = document.getElementById("scores");
const scoresTab = document.getElementById("scores-tab");
const leaderDot = document.getElementById("leader-dot");
const scoresList = document.getElementById("scores-list");
const leaderLine = document.getElementById("leader-line");
const historyEl = document.getElementById("history");
const historyTab = document.getElementById("history-tab");
const historyLine = document.getElementById("history-line");
const historyList = document.getElementById("history-list");

// The visible frame, composed (grid, territory, links, stones). It is the
// size of the canvas, not the board. Hovering only blits this layer and draws
// the ghost stone on top; scrolling or a stone change recomposes it.
const boardLayer = document.createElement("canvas");
const boardCtx = boardLayer.getContext("2d");
invariant(boardCtx !== null, "2d context unavailable for board layer");

// ---- territory -------------------------------------------------------

// Territory is painted straight from the per-crossing owner grid as merged
// unit faces on the visible slice. No per-board bitmap: a full-board ImageData
// would cost a dim x dim rebuild on every move, while visible faces are bounded
// by the frame just like every other draw pass.

// ---- state -----------------------------------------------------------

const state = {
  viewW: 0,    // canvas size in device pixels (the visible frame)
  viewH: 0,
  boardPx: 0,  // full board size in device pixels (includes the margin)
  originX: 0,  // board device pixel shown at the canvas top-left
  originY: 0,
  hudBand: 0,  // reserved HUD height, device pixels
  hudInset: 0, // top scroll inset that keeps a scrolled board below the HUD
  dpr: 1,
  pad: 0,      // board margin in device pixels
  spacing: 0,  // distance between crossings in device pixels
  stones: new Map(), // "x,y" -> { x, y, player }
  history: [],       // one move record per placement, for undo
  historyRevision: 0, // bumped whenever the move list changes, for the panel
  dim: BOARD_SIZE_DEFAULT,  // crossings per row and column
  playerCount: 2,
  turn: 1,
  hover: null,       // { x, y } or null
  cursor: null,      // { x, y } keyboard cursor, null until an arrow key
  territoryDirty: true,
  boardDirty: true,   // visible slice needs recomposing
  analysis: null,    // { scores, owner } cached for current stones

  // Flat cell grids, sized dim * dim. The Map above stays the readable
  // source of truth for drawing; these are the hot lookup paths that the
  // floods and the renderer read instead of string keys.
  playerAt: new Int8Array(0),   // 0 empty, else player id
  ownerCells: new Int8Array(0), // 0 none, else enclosing player
  // Int32, not Int16: a single player can own more than 32767 stones on a
  // large board, and a silent wrap would disable captures and crash undo.
  stoneCounts: new Int32Array(MAX_PLAYERS + 1),

  // Per-player enclosure cache for analyse(): a player's sealed region only
  // changes when that player's own stones change, and only a stone that
  // closes a wall cycle can change it. playerDirty marks a cache that must be
  // rebuilt; otherwise analyse() reuses it, skipping the whole board flood.
  playerDirty: new Uint8Array(MAX_PLAYERS + 1),
  playerTerritory: new Array(MAX_PLAYERS + 1).fill(null),
  playerTerritoryCount: new Uint32Array(MAX_PLAYERS + 1),

  // Reused flood scratch space, so a move allocates no per-cell objects.
  cellFloodVisited: new Int32Array(0),
  cellFloodQueue: new Int32Array(0),
  cellFloodStamp: 0,
  trappedCells: new Int32Array(0),
  territoryCells: new Int32Array(0),

  // Per-crossing union-find over each player's touching stones. A new stone
  // that closes no cycle cannot seal a new region, so its move skips the
  // board-wide flood. Components never span players, so one pair of arrays
  // serves everyone; entries are reused across captures and undo.
  wallParent: new Int32Array(0),
  wallSize: new Int32Array(0),
};

// ---- helpers ---------------------------------------------------------

function invariant(condition, message) {
  if (!condition) {
    throw new Error(`invariant: ${message}`);
  }
}

function keyOf(x, y) {
  return `${x},${y}`;
}

// Players 1..24 are circles. Above that, the same colours repeat as crosses,
// which doubles the table without adding more colour names.
function isCross(player) {
  return player > COLOR_COUNT;
}

function colorOf(player) {
  return COLOR_PLAYER[((player - 1) % COLOR_COUNT) + 1];
}

// Cross players reuse the same names as their circle counterparts; the
// coloured cross marker in the board, status bar, and lists tells them apart.
function playerName(player) {
  return NAME_PLAYER[((player - 1) % COLOR_COUNT) + 1];
}

function nextPlayer(player) {
  return (player % state.playerCount) + 1;
}

// Snap a coordinate so an odd-width line lands on a pixel centre.
function crisp(value, lineWidth) {
  const whole = Math.round(value);
  return lineWidth % 2 === 1 ? whole + 0.5 : whole;
}

// Flat index for a crossing: row-major, x fastest.
function cellIndex(x, y) {
  invariant(x >= 0 && x < state.dim, "cell x off board");
  invariant(y >= 0 && y < state.dim, "cell y off board");
  return y * state.dim + x;
}

function cellX(index) {
  invariant(index >= 0 && index < state.playerAt.length,
    "cell index off board");
  return index % state.dim;
}

function cellY(index) {
  invariant(index >= 0 && index < state.playerAt.length,
    "cell index off board");
  const x = index % state.dim;
  return (index - x) / state.dim;
}

// Coordinates are centred on the board: the middle crossing is 0,0.
function centerCell() {
  return Math.floor(state.dim / 2);
}

function coordX(index) {
  return cellX(index) - centerCell();
}

function coordY(index) {
  return cellY(index) - centerCell();
}

// Coordinate of one axis value (a column or a row), as opposed to a flat
// cell index. Passing a column to coordY would decode it as row zero.
function axisX(x) {
  return x - centerCell();
}

function axisY(y) {
  return y - centerCell();
}

// Clamp a typed coordinate to the board and snap it to a crossing.
function clampCoord(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const center = centerCell();
  return Math.min(state.dim - 1 - center,
    Math.max(-center, Math.round(value)));
}

// Size every board-sized buffer once per new game. Allocation stays out of
// the move path, and stale stamps are dropped along with the old arrays.
function allocateCellState(dim) {
  invariant(Number.isInteger(dim) && dim > 0, "bad cell grid size");
  invariant(MAX_PLAYERS < 128, "player id must fit a signed byte");
  const cells = dim * dim;
  invariant(cells > 0, "cell grid must hold at least one crossing");

  state.playerAt = new Int8Array(cells);
  state.ownerCells = new Int8Array(cells);
  state.cellFloodVisited = new Int32Array(cells);
  state.cellFloodQueue = new Int32Array(cells);
  state.trappedCells = new Int32Array(cells);
  state.territoryCells = new Int32Array(cells);
  state.wallParent = new Int32Array(cells);
  state.wallParent.fill(-1); // -1 means this crossing never held a stone
  state.wallSize = new Int32Array(cells);
  state.stoneCounts.fill(0);
  state.cellFloodStamp = 0;
  // Drop the per-player enclosure cache; every player must be re-flooded on
  // the first analyse() of the new game.
  state.playerDirty.fill(1);
  state.playerTerritory.fill(null);
  state.playerTerritoryCount.fill(0);
}

// ---- enclosure -------------------------------------------------------

/* Union the new stone with its same-colour neighbours in the 8-way wall
   graph. Returns true when the union closes a cycle.

   A wall with no cycle is a tree: it cannot cut the grid in two, so the
   player's reachable set (and therefore their enclosure) is unchanged. That
   lets setStone skip marking the player dirty and resolveCaptures skip its
   board-wide flood on most moves. Captures and undo leave stale parent links
   behind, but stale links only ever over-connect, so a real cycle is still
   found; the cost is at worst a needless flood. */
function connectWall(index, player) {
  const parent = state.wallParent;
  const size = state.wallSize;
  const dim = state.dim;
  const last = dim - 1;
  const x = index % dim;
  const y = (index - x) / dim;

  if (parent[index] === -1) {
    parent[index] = index;
    size[index] = 1;
  }

  function root(node) {
    let current = node;
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]]; // path halving
      current = parent[current];
    }
    return current;
  }

  let cycle = false;
  for (const { dx, dy } of WALL_DIRECTIONS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || nx > last || ny < 0 || ny > last) {
      continue;
    }
    const neighbour = ny * dim + nx;
    if (state.playerAt[neighbour] !== player) {
      continue;
    }

    let a = root(index);
    let b = root(neighbour);
    if (a === b) {
      cycle = true; // two already-connected neighbours
      continue;
    }
    if (size[a] < size[b]) {
      const swap = a;
      a = b;
      b = swap;
    }
    parent[b] = a;
    size[a] += size[b];
  }

  return cycle;
}

/* Flood from every border crossing through anything that is not one of
   `player`'s stones. Whatever the flood cannot reach is walled in.

   Works on flat Int32 indices in reused buffers: no string keys, no
   per-cell objects, so a full-board flood allocates nothing.

   Returns:
     trapped       - opponent stones sealed inside the wall (indices)
     territory     - empty crossings sealed inside the wall (indices)
     area          - size used to rank competing enclosures */
function enclosure(player) {
  invariant(Number.isInteger(player), "player id must be an integer");
  invariant(player >= 1 && player <= MAX_PLAYERS, "bad player id");

  const dim = state.dim;
  const cells = dim * dim;
  const last = dim - 1;
  const visited = state.cellFloodVisited;
  const playerAt = state.playerAt;

  invariant(visited.length === cells, "flood grid size mismatch");

  // A stamp lets each flood reuse the visited grid without clearing it.
  // Wrap far before Int32 overflow, then clear once.
  state.cellFloodStamp += 1;
  if (state.cellFloodStamp >= 2147483647) {
    visited.fill(0);
    state.cellFloodStamp = 1;
  }
  const stamp = state.cellFloodStamp;

  let stack = state.cellFloodQueue;
  let sp = 0;
  let reached = 0;

  // Push one seed crossing. Only span starts go on the stack, so it stays
  // far below the cell count; grow only if a pathological wall shape seeds
  // more spans than there are crossings.
  function push(index) {
    if (sp === stack.length) {
      const grown = new Int32Array(stack.length * 2);
      grown.set(stack);
      stack = grown;
      state.cellFloodQueue = grown;
    }
    stack[sp] = index;
    sp += 1;
  }

  for (let i = 0; i <= last; i += 1) {
    push(i);
    push(last * dim + i);
    push(i * dim);
    push(i * dim + last);
  }

  // Span fill: mark a whole horizontal run per pop, then seed the runs it
  // touches on the rows above and below. Same visited set and reachability
  // as a per-cell flood, with a fraction of the queue traffic.
  while (sp > 0) {
    sp -= 1;
    const index = stack[sp];
    if (visited[index] === stamp) {
      continue;
    }
    if (playerAt[index] === player) {
      continue; // own stone: wall, not passable
    }

    const x = index % dim;
    const y = (index - x) / dim;

    let x0 = x;
    while (x0 > 0) {
      const left = index - (x - x0) - 1;
      if (visited[left] === stamp || playerAt[left] === player) {
        break;
      }
      x0 -= 1;
    }

    let x1 = x;
    while (x1 < last) {
      const right = index + (x1 - x) + 1;
      if (visited[right] === stamp || playerAt[right] === player) {
        break;
      }
      x1 += 1;
    }

    const row = index - x;
    for (let xx = x0; xx <= x1; xx += 1) {
      visited[row + xx] = stamp;
    }
    reached += x1 - x0 + 1;

    for (let dy = -1; dy <= 1; dy += 2) {
      const ny = y + dy;
      if (ny < 0 || ny > last) {
        continue;
      }
      const nextRow = ny * dim;
      let xx = x0;
      while (xx <= x1) {
        while (xx <= x1 &&
               (visited[nextRow + xx] === stamp ||
                playerAt[nextRow + xx] === player)) {
          xx += 1;
        }
        if (xx > x1) {
          break;
        }
        push(nextRow + xx);
        while (xx <= x1 && visited[nextRow + xx] !== stamp &&
               playerAt[nextRow + xx] !== player) {
          xx += 1;
        }
      }
    }
  }

  invariant(sp === 0, "flood stack not drained");
  invariant(reached <= cells, "flood reached more cells than exist");

  const result = classifyUnreached(player, stamp, reached);
  invariant(reached > 0 || result.area > 0, "flood visited nothing");
  return result;
}

// Split the cells the flood missed into sealed empties and sealed opponent
// stones, writing their flat indices into the shared scratch buffers. When
// the flood reached every non-wall crossing there is nothing to split, so
// the full-grid scan is skipped (the common case on an open board).
function classifyUnreached(player, stamp, reached) {
  const cells = state.dim * state.dim;
  const visited = state.cellFloodVisited;
  const playerAt = state.playerAt;

  invariant(Number.isInteger(stamp) && stamp > 0, "bad flood stamp");
  invariant(visited.length === cells, "flood grid size mismatch");

  if (reached === cells - state.stoneCounts[player]) {
    return {
      trapped: state.trappedCells,
      trappedCount: 0,
      territory: state.territoryCells,
      territoryCount: 0,
      area: 0,
    };
  }

  let trappedCount = 0;
  let territoryCount = 0;

  for (let index = 0; index < cells; index += 1) {
    if (visited[index] === stamp) {
      continue;
    }
    const occupant = playerAt[index];
    if (occupant === 0) {
      state.territoryCells[territoryCount] = index;
      territoryCount += 1;
    } else if (occupant !== player) {
      state.trappedCells[trappedCount] = index;
      trappedCount += 1;
    }
  }

  return {
    trapped: state.trappedCells,
    trappedCount,
    territory: state.territoryCells,
    territoryCount,
    area: trappedCount + territoryCount,
  };
}

// Cache every crossing the player's flood could not reach (empty or occupied).
// Reachability depends only on that player's own stones, so adding or removing
// another player's stone cannot change this set. analyse() then filters out
// crossing that currently hold a stone, which keeps captured cells owned
// without a re-flood. A move therefore re-floods the mover (and any victims
// whose own walls changed), never the whole player list.
function storeEnclosure(player, spot) {
  const count = spot.territoryCount + spot.trappedCount;
  let buffer = state.playerTerritory[player];
  if (buffer === null || buffer.length < count) {
    buffer = new Int32Array(count);
    state.playerTerritory[player] = buffer;
  }
  for (let i = 0; i < spot.territoryCount; i += 1) {
    buffer[i] = spot.territory[i];
  }
  for (let i = 0; i < spot.trappedCount; i += 1) {
    buffer[spot.territoryCount + i] = spot.trapped[i];
  }
  state.playerTerritoryCount[player] = count;
  state.playerDirty[player] = 0;
}

/* Only the mover can capture on a move: adding a stone is the only thing
   that closes a wall, and removing one (a capture) only opens the flood, so
   it can never seal a new region. That means the old "try every player,
   repeat until nothing settles" loop did up to playerCount * rounds floods
   for a result one flood can prove. A bigger ring still eats a smaller one
   inside it, because the mover's flood collects every sealed stone at once.
   Eaten stones leave the board; the wall's interior stays painted. Each one
   is appended to `removed` so undo can put it back. */
function resolveCaptures(player, removed) {
  invariant(Number.isInteger(player) && player >= 1, "bad move player");
  invariant(Array.isArray(removed), "capture log must be an array");

  if (state.stoneCounts[player] < MIN_RING_STONES) {
    return; // too few stones to close a wall
  }

  if (state.playerDirty[player] === 0) {
    return; // the new stone completed no cycle, so nothing can be sealed
  }

  const spot = enclosure(player);
  storeEnclosure(player, spot); // analyse() reuses this, captures included

  for (let i = 0; i < spot.trappedCount; i += 1) {
    const index = spot.trapped[i];
    const victim = state.playerAt[index];
    invariant(victim > 0, "trapped crossing without stone");
    removed.push({ index, player: victim });
    removeStone(index);
  }
}

/* Rebuild the owner grid and scores. A player's sealed region depends only
   on that player's own stones, so the enclosure of an untouched player is
   reused instead of re-flooded. On a big board a move now costs one flood
   for the mover (plus any victims), not one flood per player. */
function analyse() {
  if (state.analysis !== null) {
    return state.analysis;
  }

  const owner = state.ownerCells;
  invariant(owner.length === state.dim * state.dim, "owner grid size mismatch");

  for (let player = 1; player <= state.playerCount; player += 1) {
    if (state.playerDirty[player] === 0) {
      continue; // region already cached
    }
    state.playerDirty[player] = 0;

    if (state.stoneCounts[player] < MIN_RING_STONES) {
      state.playerTerritory[player] = null; // too few stones to close a wall
      state.playerTerritoryCount[player] = 0;
      continue;
    }

    storeEnclosure(player, enclosure(player));
  }

  owner.fill(0);
  const playerAt = state.playerAt;
  for (let player = 1; player <= state.playerCount; player += 1) {
    const buffer = state.playerTerritory[player];
    const count = state.playerTerritoryCount[player];
    if (buffer === null || count === 0) {
      continue;
    }
    for (let i = 0; i < count; i += 1) {
      owner[buffer[i]] = player; // later players paint over earlier ones
    }
  }

  const scores = [];
  for (let player = 1; player <= state.playerCount; player += 1) {
    scores.push({ player, points: 0 });
  }
  for (let index = 0; index < owner.length; index += 1) {
    if (playerAt[index] !== 0) {
      owner[index] = 0; // a crossing holding a stone is a wall, not ground
      continue;
    }
    const player = owner[index];
    if (player > 0) {
      scores[player - 1].points += 1;
    }
  }

  state.analysis = { scores, owner };
  return state.analysis;
}

// A crossing sealed by any wall is owned already: no stone may go there.
function isBlocked(point) {
  const index = cellIndex(point.x, point.y);
  return analyse().owner[index] !== 0;
}

// Territory points per player. Later players paint over earlier ones, so
// the later enclosure owns a shared cell, matching the on-board colours.
function computeScores() {
  return analyse().scores;
}

function renderScores(scores) {
  const ranked = scores
    .slice()
    .sort((a, b) => b.points - a.points || a.player - b.player);
  const best = ranked[0];

  leaderLine.textContent = best.points > 0
    ? `${playerName(best.player)} · ${best.points}`
    : "No territory";
  leaderDot.style.setProperty(
    "--dot",
    best.points > 0 ? colorOf(best.player) : "var(--muted)",
  );
  leaderDot.classList.toggle(
    "cross",
    best.points > 0 && isCross(best.player),
  );

  scoresList.replaceChildren();
  for (const entry of ranked) {
    const row = document.createElement("li");
    if (best.points > 0 && entry.points === best.points) {
      row.className = "top";
    }

    const dot = document.createElement("span");
    dot.classList.add("score-dot");
    if (isCross(entry.player)) {
      dot.classList.add("cross");
    }
    dot.style.setProperty("--dot", colorOf(entry.player));

    const name = document.createElement("span");
    name.className = "score-name";
    name.textContent = playerName(entry.player);

    const points = document.createElement("span");
    points.className = "score-points";
    points.textContent = String(entry.points);

    row.append(dot, name, points);
    scoresList.append(row);
  }
}

// Newest move first, so the recent placements are visible without scrolling.
// A very long game would otherwise rebuild thousands of rows per move, so
// only the newest window is rendered; the header always shows the last move.
const HISTORY_ROWS = 200;

function renderHistory() {
  const moves = state.history;
  const last = moves[moves.length - 1];
  historyLine.textContent = last === undefined
    ? "No moves"
    : `${playerName(last.player)} · ${coordX(last.index)}, ${coordY(last.index)}`;

  historyList.replaceChildren();
  const shown = Math.min(moves.length, HISTORY_ROWS);
  for (let i = moves.length - 1; i >= moves.length - shown; i -= 1) {
    const record = moves[i];
    const x = coordX(record.index);
    const y = coordY(record.index);

    const row = document.createElement("li");
    row.title = `Move ${i + 1}: ${playerName(record.player)} at ` +
      `x ${x}, y ${y}`;

    const dot = document.createElement("span");
    dot.classList.add("score-dot");
    if (isCross(record.player)) {
      dot.classList.add("cross");
    }
    dot.style.setProperty("--dot", colorOf(record.player));

    const name = document.createElement("span");
    name.className = "history-name";
    name.textContent = playerName(record.player);

    const coord = document.createElement("span");
    coord.className = "history-coord";
    coord.textContent = `${x}, ${y}`;

    row.append(dot, name, coord);
    historyList.append(row);
  }

  if (moves.length > shown) {
    const more = document.createElement("li");
    more.className = "history-more";
    more.textContent = `${moves.length - shown} earlier moves`;
    historyList.append(more);
  }
}

// ---- layout ----------------------------------------------------------

// Collapsed HUD height: each panel folds to its header, so reserve only that
// and let a hovered panel overlay the board while it is open.
function hudHeight() {
  const column = getComputedStyle(hudEl).flexDirection === "column";
  let height = 0;

  for (const tab of [controlsTab, scoresTab]) {
    const panelHeight = tab.getBoundingClientRect().height + 2;
    height = column
      ? height + panelHeight
      : Math.max(height, panelHeight);
  }

  return height + (column ? 12 : 0) + 16;
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, DPR_MAX);
  const rect = boardWrap.getBoundingClientRect();
  // A hidden container can report a zero-size frame. Fall back to a 1px
  // layout instead of throwing, so the game survives being hidden and shown.
  const frameW = Math.max(1, rect.width);
  const frameH = Math.max(1, rect.height);

  // The HUD band is reserved only while the board fits; a scrolled board
  // gets a matching top inset below so its first row stays clear of the HUD.
  const edge = hudHeight();

  // Cell size depends on the frame, never on the board: a small board fills
  // the frame, a big one keeps a tappable cell and scrolls. The canvas stays
  // frame-sized, so board size no longer affects bitmap memory at all. If the
  // frame is too small to fit even one minimum cell, the max() keeps the
  // board scrollable rather than failing.
  const avail = Math.min(frameW, frameH) - edge * 2 - 2;
  const fitCell = (avail - PADDING_CSS * 2) / (state.dim - 1);
  const cellCss = Math.max(CELL_MIN_CSS,
    Math.min(CELL_MAX_CSS, Math.floor(fitCell)));
  const boardCss = PADDING_CSS * 2 + (state.dim - 1) * cellCss;

  // The spacer carries the full board size for the scrollbars. It is
  // invisible and gets pointer-events: none.
  boardSpacer.style.width = `${boardCss}px`;
  boardSpacer.style.height = `${boardCss}px`;

  // Measure after the spacer is in place: scrollbars may have appeared and
  // changed the client area.
  const viewW = Math.max(1, Math.round(boardWrap.clientWidth * dpr));
  const viewH = Math.max(1, Math.round(boardWrap.clientHeight * dpr));
  canvas.style.width = `${viewW / dpr}px`;
  canvas.style.height = `${viewH / dpr}px`;
  canvas.width = viewW;
  canvas.height = viewH;

  boardLayer.width = viewW;
  boardLayer.height = viewH;

  state.viewW = viewW;
  state.viewH = viewH;
  state.boardPx = Math.round(boardCss * dpr);
  state.dpr = dpr;
  state.pad = PADDING_CSS * dpr;
  state.spacing = cellCss * dpr;
  state.hudBand = Math.round(edge * dpr);

  // A board taller than the frame would otherwise start with its top row
  // under the fixed HUD. Pad the scroll content by the HUD band and shift the
  // slice origin by the same amount. The extra content extends the scroll
  // range, so the last row still lands flush at the bottom.
  const overflowY = boardCss > boardWrap.clientHeight;
  state.hudInset = overflowY ? Math.min(state.hudBand, viewH / 4) : 0;
  if (state.hudInset !== 0) {
    boardSpacer.style.height = `${boardCss + state.hudInset / dpr}px`;
  }

  invariant(state.spacing > 0, "board spacing must be positive");
  invariant(state.boardPx > 2 * state.pad, "board wider than its margin");
  state.territoryDirty = true;
  state.boardDirty = true;
  // Keep the current scroll position on a window resize; only a fresh game
  // resets it (startGame re-centres the board on 0, 0). Layout does not affect
  // ownership, so the cached analysis stays valid.
  updateOrigin();
  refreshHover();
  draw();
}

// Recompute which slice of the board the frame shows and keep the canvas
// pinned to the frame while the spacer scrolls underneath it.
function updateOrigin() {
  const { dpr, boardPx, viewW, viewH, hudBand, hudInset } = state;

  if (boardPx <= viewW) {
    state.originX = (boardPx - viewW) / 2; // centre a board that fits
  } else {
    state.originX = boardWrap.scrollLeft * dpr;
  }

  const band = Math.min(hudBand, viewH / 4);
  if (hudInset === 0 && boardPx <= viewH - band * 2) {
    // Board top sits half the spare space below the HUD band.
    state.originY = (boardPx - (viewH - band * 2)) / 2 - band;
  } else if (hudInset === 0 && boardPx <= viewH) {
    state.originY = (boardPx - viewH) / 2;
  } else {
    state.originY = boardWrap.scrollTop * dpr - hudInset;
  }

  invariant(Number.isFinite(state.originX) && Number.isFinite(state.originY),
    "bad board origin");
}

// Show the cursor coordinate. The same fields accept a typed coordinate to
// jump the cursor there.
let renderedCoordX = null;
let renderedCoordY = null;

function syncCoordFields(force) {
  if (state.cursor === null) {
    return;
  }
  const x = axisX(state.cursor.x);
  const y = axisY(state.cursor.y);
  if (force || x !== renderedCoordX) {
    renderedCoordX = x;
    coordXInput.value = String(x);
  }
  if (force || y !== renderedCoordY) {
    renderedCoordY = y;
    coordYInput.value = String(y);
  }
}

function updateCoord() {
  if (document.activeElement === coordXInput ||
      document.activeElement === coordYInput) {
    return; // leave the field being typed in alone
  }
  syncCoordFields();
}

// ---- drawing ---------------------------------------------------------

// Stones are circles for the first colour set and plus signs for the
// second, so two players can share a colour and still be told apart.
function drawStone(target, x, y, radius, color, alpha, player) {
  const cx = state.pad + x * state.spacing;
  const cy = state.pad + y * state.spacing;

  target.save();
  target.globalAlpha = alpha;
  target.beginPath();

  if (isCross(player)) {
    // Diagonal X with round caps: softer than a plus-shaped polygon.
    const reach = radius * 0.68;
    const arm = radius * 0.33;
    const outline = Math.max(1, radius * 0.09);

    target.lineCap = "round";
    target.moveTo(cx - reach, cy - reach);
    target.lineTo(cx + reach, cy + reach);
    target.moveTo(cx + reach, cy - reach);
    target.lineTo(cx - reach, cy + reach);

    target.lineWidth = arm + outline * 2;
    target.strokeStyle = "rgba(0, 0, 0, 0.35)";
    target.stroke();

    target.lineWidth = arm;
    target.strokeStyle = color;
    target.stroke();
    target.restore();
    return;
  }

  target.arc(cx, cy, radius, 0, Math.PI * 2);
  target.fillStyle = color;
  target.fill();
  target.lineWidth = Math.max(1, radius * 0.09);
  target.strokeStyle = "rgba(0, 0, 0, 0.35)";
  target.stroke();
  target.restore();
}

// Cell range the frame currently shows, padded by one so links and stones
// straddling the edge still draw. Everything that walks the grid uses this
// instead of the whole board, which is what keeps a 1000x1000 board cheap.
function visibleCells() {
  const { originX, originY, viewW, viewH, pad, spacing, dim } = state;
  const x0 = Math.max(0, Math.floor((originX - pad) / spacing) - 1);
  const x1 = Math.min(dim - 1,
    Math.ceil((originX + viewW - pad) / spacing) + 1);
  const y0 = Math.max(0, Math.floor((originY - pad) / spacing) - 1);
  const y1 = Math.min(dim - 1,
    Math.ceil((originY + viewH - pad) / spacing) + 1);
  return { x0, x1, y0, y1 };
}

function drawGrid(target, lineWidth) {
  const { pad, spacing, originX, originY, viewW, viewH, dim } = state;
  const first = crisp(pad, lineWidth);
  const last = crisp(pad + spacing * (dim - 1), lineWidth);

  const cx0 = Math.max(0, Math.floor((originX - pad) / spacing));
  const cx1 = Math.min(dim - 1, Math.ceil((originX + viewW - pad) / spacing));
  const cy0 = Math.max(0, Math.floor((originY - pad) / spacing));
  const cy1 = Math.min(dim - 1, Math.ceil((originY + viewH - pad) / spacing));

  target.strokeStyle = COLOR_LINE;
  target.lineWidth = lineWidth;
  target.beginPath();

  // Every line still spans the whole board; clipping trims the off-screen
  // part. Only the lines near the frame are built.
  for (let i = cx0; i <= cx1; i += 1) {
    const p = crisp(pad + i * spacing, lineWidth);
    target.moveTo(p, first);
    target.lineTo(p, last);
  }
  for (let i = cy0; i <= cy1; i += 1) {
    const p = crisp(pad + i * spacing, lineWidth);
    target.moveTo(first, p);
    target.lineTo(last, p);
  }

  target.stroke();
}

// One segment per same-colour neighbouring pair, drawn under the stones.
// A single sweep over the flat grid groups segments per player, so the cost
// is one pass over the board rather than one pass per player.
function drawLinks(target) {
  invariant(state.spacing > 0, "link pass before layout");

  const { pad, spacing } = state;
  const dim = state.dim;
  const last = dim - 1;
  const playerAt = state.playerAt;
  const paths = new Array(state.playerCount + 1).fill(null);
  const range = visibleCells();

  for (let y = range.y0; y <= range.y1; y += 1) {
    for (let x = range.x0; x <= range.x1; x += 1) {
      const player = playerAt[y * dim + x];
      if (player === 0) {
        continue;
      }

      const x0 = pad + x * spacing;
      const y0 = pad + y * spacing;

      for (const { dx, dy } of LINK_DIRECTIONS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx > last || ny < 0 || ny > last) {
          continue;
        }
        if (playerAt[ny * dim + nx] !== player) {
          continue;
        }

        let path = paths[player];
        if (path === null) {
          path = new Path2D();
          paths[player] = path;
        }
        path.moveTo(x0, y0);
        path.lineTo(pad + nx * spacing, pad + ny * spacing);
      }
    }
  }

  target.save();
  target.lineWidth = Math.max(1, spacing * LINK_WIDTH_RATIO);
  target.lineCap = "round";

  for (let player = 1; player <= state.playerCount; player += 1) {
    const path = paths[player];
    if (path === null) {
      continue;
    }
    target.strokeStyle = colorOf(player);
    target.stroke(path);
  }

  target.restore();
}

// Paint the enclosed faces: one box per unit cell between crossings, merged
// into horizontal runs. A face is inside when it has an owned corner and no
// reachable empty corner; that reaches the straight wall lines exactly.
// A diagonal pair of stones cuts a face in two, so each half is painted as a
// triangle from its own owned crossing. Faces fully surrounded by stones carry
// no owner and are skipped.
function drawTerritory(target) {
  invariant(state.viewW > 0, "territory pass before layout");
  const { owner } = analyse();

  if (state.territoryDirty) {
    state.territoryDirty = false;
    renderScores(computeScores());
  }

  drawTerritoryFaces(target, owner);
}

function drawTerritoryFaces(target, owner) {
  invariant(state.viewW > 0, "territory pass before layout");
  invariant(state.spacing > 0, "territory before layout");
  invariant(state.dim >= 2, "board too small for faces");
  invariant(owner.length === state.dim * state.dim, "owner grid size mismatch");

  drawFullFaces(target, owner);
  drawSplitFaces(target, owner);
}

// Faces that no wall line cuts: every corner is a stone or owned crossing.
// Adjacent faces are merged into horizontal runs, so a straight wall becomes
// one solid rectangle out to the wall line.
function drawFullFaces(target, owner) {
  invariant(state.spacing > 0, "faces before layout");
  invariant(owner.length === state.dim * state.dim, "owner grid size mismatch");

  const { pad, spacing, dim } = state;
  const playerAt = state.playerAt;
  const bleed = 1; // device pixel of overlap hides antialias seams
  const range = visibleCells();

  // Face (x, y) spans crossings (x, y) to (x + 1, y + 1).
  const x0 = Math.max(0, range.x0);
  const x1 = Math.min(dim - 2, range.x1);
  const y0 = Math.max(0, range.y0);
  const y1 = Math.min(dim - 2, range.y1);

  for (let y = y0; y <= y1; y += 1) {
    const row = y * dim;
    let runPlayer = 0;
    let runStart = 0;

    for (let x = x0; x <= x1 + 1; x += 1) {
      let player = 0;
      if (x <= x1) {
        const top = row + x;
        const bottom = top + dim;
        const a = owner[top];
        const b = owner[top + 1];
        const c = owner[bottom];
        const d = owner[bottom + 1];
        const stoneA = playerAt[top] !== 0;
        const stoneB = playerAt[top + 1] !== 0;
        const stoneC = playerAt[bottom] !== 0;
        const stoneD = playerAt[bottom + 1] !== 0;
        const open = (a === 0 && !stoneA) || (b === 0 && !stoneB) ||
          (c === 0 && !stoneC) || (d === 0 && !stoneD);
        // A diagonal pair of stones cuts this face in two; each half is
        // painted from its own corner in the half-face pass.
        const split = (stoneB && stoneC) || (stoneA && stoneD);
        if (!open && !split && (a !== 0 || b !== 0 || c !== 0 || d !== 0)) {
          player = Math.max(a, b, c, d);
        }
      }

      if (player === runPlayer) {
        continue;
      }

      if (runPlayer !== 0) {
        target.fillStyle = colorOf(runPlayer);
        target.fillRect(
          pad + runStart * spacing,
          pad + y * spacing,
          (x - runStart) * spacing + bleed,
          spacing + bleed,
        );
      }

      runPlayer = player;
      runStart = x;
    }
  }
}

// Half faces cut by a diagonal pair of stones. The diagonal through B and C
// separates the A and D halves; the diagonal through A and D separates the B
// and C halves. Each half is painted from its own crossing when that crossing
// is owned. This also fills the corner face of a straight wall, where a pair
// of edge stones sits diagonally beside the inner crossing.
function drawSplitFaces(target, owner) {
  invariant(state.spacing > 0, "split faces before layout");
  invariant(owner.length === state.dim * state.dim, "owner grid size mismatch");

  const { pad, spacing, dim, playerCount } = state;
  const playerAt = state.playerAt;
  const range = visibleCells();

  const x0 = Math.max(0, range.x0);
  const x1 = Math.min(dim - 2, range.x1);
  const y0 = Math.max(0, range.y0);
  const y1 = Math.min(dim - 2, range.y1);

  const paths = new Array(playerCount + 1).fill(null);

  function paintHalf(corner, player, bx, by) {
    let path = paths[player];
    if (path === null) {
      path = new Path2D();
      paths[player] = path;
    }
    const triangle = HALF_FACES[corner];
    path.moveTo(bx + triangle[0][0] * spacing,
      by + triangle[0][1] * spacing);
    path.lineTo(bx + triangle[1][0] * spacing,
      by + triangle[1][1] * spacing);
    path.lineTo(bx + triangle[2][0] * spacing,
      by + triangle[2][1] * spacing);
  }

  for (let y = y0; y <= y1; y += 1) {
    const row = y * dim;

    for (let x = x0; x <= x1; x += 1) {
      const top = row + x;
      const bottom = top + dim;
      const a = owner[top];
      const b = owner[top + 1];
      const c = owner[bottom];
      const d = owner[bottom + 1];
      const stoneA = playerAt[top] !== 0;
      const stoneB = playerAt[top + 1] !== 0;
      const stoneC = playerAt[bottom] !== 0;
      const stoneD = playerAt[bottom + 1] !== 0;

      const bx = pad + x * spacing;
      const by = pad + y * spacing;

      if (stoneB && stoneC) {
        if (a !== 0) {
          paintHalf(0, a, bx, by);
        }
        if (d !== 0) {
          paintHalf(3, d, bx, by);
        }
      }
      if (stoneA && stoneD) {
        if (b !== 0) {
          paintHalf(1, b, bx, by);
        }
        if (c !== 0) {
          paintHalf(2, c, bx, by);
        }
      }
    }
  }

  for (let player = 1; player <= playerCount; player += 1) {
    const path = paths[player];
    if (path === null) {
      continue;
    }
    target.fillStyle = colorOf(player);
    target.fill(path);
  }
}

// Draw every stone in one pass per player instead of one canvas state change
// per stone: on a 200x200 board that is 40k stones, and save/beginPath/fill/
// restore for each one dominates the repaint. Path2D batches them.
function drawStones(target) {
  const radius = state.spacing * DOT_RADIUS_RATIO;
  const outline = Math.max(1, radius * 0.09);
  const dim = state.dim;
  const playerAt = state.playerAt;
  const circles = new Array(state.playerCount + 1).fill(null);
  const crosses = new Array(state.playerCount + 1).fill(null);
  const range = visibleCells();

  for (let y = range.y0; y <= range.y1; y += 1) {
    const row = y * dim;
    const cy = state.pad + y * state.spacing;
    for (let x = range.x0; x <= range.x1; x += 1) {
      const player = playerAt[row + x];
      if (player === 0) {
        continue;
      }

      const cx = state.pad + x * state.spacing;

      if (isCross(player)) {
        const reach = radius * 0.68;
        let path = crosses[player];
        if (path === null) {
          path = new Path2D();
          crosses[player] = path;
        }
        path.moveTo(cx - reach, cy - reach);
        path.lineTo(cx + reach, cy + reach);
        path.moveTo(cx + reach, cy - reach);
        path.lineTo(cx - reach, cy + reach);
      } else {
        let path = circles[player];
        if (path === null) {
          path = new Path2D();
          circles[player] = path;
        }
        path.moveTo(cx + radius, cy);
        path.arc(cx, cy, radius, 0, Math.PI * 2);
      }
    }
  }

  target.save();
  target.lineWidth = outline;
  target.strokeStyle = "rgba(0, 0, 0, 0.35)";

  for (let player = 1; player <= state.playerCount; player += 1) {
    const path = circles[player];
    if (path === null) {
      continue;
    }
    target.fillStyle = colorOf(player);
    target.fill(path);
    target.stroke(path);
  }

  const arm = radius * 0.33;
  target.lineCap = "round";
  for (let player = 1; player <= state.playerCount; player += 1) {
    const path = crosses[player];
    if (path === null) {
      continue;
    }
    target.lineWidth = arm + outline * 2;
    target.strokeStyle = "rgba(0, 0, 0, 0.35)"; // reset after last colour
    target.stroke(path);
    target.lineWidth = arm;
    target.strokeStyle = colorOf(player);
    target.stroke(path);
  }

  target.restore();
}

// Compose everything that only changes when the stones or layout change.
// Hover then costs one blit plus the ghost stone.
function renderBoard() {
  const lineWidth = Math.max(1, Math.round(LINE_WIDTH_CSS * state.dpr));

  // Clear in frame space, then compose in board space shifted by the origin.
  boardCtx.setTransform(1, 0, 0, 1, 0, 0);
  boardCtx.clearRect(0, 0, state.viewW, state.viewH);
  boardCtx.setTransform(1, 0, 0, 1, -state.originX, -state.originY);

  drawGrid(boardCtx, lineWidth);
  drawTerritory(boardCtx);
  drawLinks(boardCtx);
  drawStones(boardCtx);
}

function isPlaceable(point) {
  return !state.stones.has(keyOf(point.x, point.y)) && !isBlocked(point);
}

function drawGhost(point) {
  if (!isPlaceable(point)) {
    return;
  }

  const radius = state.spacing * DOT_RADIUS_RATIO;
  ctx.setTransform(1, 0, 0, 1, -state.originX, -state.originY);
  drawStone(ctx, point.x, point.y, radius, colorOf(state.turn), 0.35,
    state.turn);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// The cursor is a ghost stone on a legal crossing, and a ring only on a
// sealed empty one, so a blocked crossing still shows where it is. A
// crossing holding a stone is its own marker, so nothing is stacked on it.
function drawCursor(point) {
  if (state.stones.has(keyOf(point.x, point.y))) {
    return;
  }
  if (isPlaceable(point)) {
    drawGhost(point);
    return;
  }

  const radius = state.spacing * DOT_RADIUS_RATIO;
  const cx = state.pad + point.x * state.spacing;
  const cy = state.pad + point.y * state.spacing;

  ctx.setTransform(1, 0, 0, 1, -state.originX, -state.originY);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 1.4, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(2, state.spacing * 0.05);
  ctx.strokeStyle = colorOf(state.turn);
  ctx.stroke();
  ctx.restore();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

let renderedTurn = 0; // last turn whose status text was written to the DOM
let renderedMoves = -1; // last move count whose button state was written
let renderedHistory = -1; // last history revision painted into the panel
let pendingDraw = 0;

// Pointer moves can fire several times per frame. Coalesce them into one
// repaint; scroll and stone changes still draw immediately.
function scheduleDraw() {
  if (pendingDraw !== 0) {
    return;
  }
  pendingDraw = requestAnimationFrame(() => {
    pendingDraw = 0;
    draw();
  });
}

function draw() {
  invariant(state.spacing > 0, "draw called before layout");

  if (state.territoryDirty) {
    state.boardDirty = true;
  }
  if (state.boardDirty) {
    renderBoard();
    state.boardDirty = false;
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, state.viewW, state.viewH);
  ctx.drawImage(boardLayer, 0, 0);

  if (state.hover !== null &&
      (state.cursor === null ||
       state.hover.x !== state.cursor.x || state.hover.y !== state.cursor.y)) {
    drawGhost(state.hover);
  }
  if (state.cursor !== null) {
    drawCursor(state.cursor);
  }

  const moves = state.history.length;
  if (state.turn !== renderedTurn) {
    renderedTurn = state.turn;
    statusEl.textContent = `${playerName(state.turn)} to play`;
    statusEl.style.setProperty("--dot", colorOf(state.turn));
    statusEl.classList.toggle("cross", isCross(state.turn));
  }
  if (moves !== renderedMoves) {
    renderedMoves = moves;
    undoBtn.disabled = moves === 0;
    clearBtn.disabled = moves === 0;
  }
  if (state.historyRevision !== renderedHistory) {
    renderedHistory = state.historyRevision;
    renderHistory();
  }
  updateCoord();
}

// ---- input -----------------------------------------------------------

// Pointer position in board device pixels: canvas-local, plus the slice
// origin so a scrolled board maps clicks to the right crossings.
function pointAt(event) {
  const rect = canvas.getBoundingClientRect();
  invariant(rect.width > 0, "board has zero width");

  const scale = canvas.width / rect.width;
  return {
    x: (event.clientX - rect.left) * scale + state.originX,
    y: (event.clientY - rect.top) * scale + state.originY,
  };
}

// Nearest crossing to a point, or null when the point is off the board.
// Snaps within half a cell, so a click between crossings still lands on the
// closest one instead of doing nothing.
function intersectionAt(point) {
  const { pad, spacing, dim } = state;

  const gx = Math.round((point.x - pad) / spacing);
  const gy = Math.round((point.y - pad) / spacing);

  if (gx < 0 || gx >= dim || gy < 0 || gy >= dim) {
    return null;
  }

  return { x: gx, y: gy };
}

// Last mouse position in client px, so scrolling or a resize can remap the
// ghost without waiting for another pointermove. Null while off the board.
let lastPointer = null;

// Re-resolve the pointer against the board after its origin moved.
function refreshHover() {
  if (lastPointer === null) {
    return;
  }

  const frame = canvas.getBoundingClientRect();
  if (frame.width <= 0 || frame.height <= 0) {
    return; // hidden frame: pointAt would reject it
  }

  const hit = intersectionAt(pointAt(lastPointer));
  state.hover = hit;
  if (hit !== null) {
    state.cursor = hit;
  }
  canvas.style.cursor = hit !== null && isBlocked(hit)
    ? "not-allowed"
    : "crosshair";
}

// ---- keyboard cursor -------------------------------------------------

// First arrow press starts from the centre of the visible slice; later presses
// keep the current crossing and clamp at the edges.
function ensureCursor() {
  if (state.cursor !== null) {
    return;
  }

  const { originX, originY, viewW, viewH, pad, spacing, dim } = state;
  const x = Math.round((originX + viewW / 2 - pad) / spacing);
  const y = Math.round((originY + viewH / 2 - pad) / spacing);
  state.cursor = {
    x: Math.min(dim - 1, Math.max(0, x)),
    y: Math.min(dim - 1, Math.max(0, y)),
  };
}

// Scroll just enough to bring the cursor back into the frame, staying clear
// of the edge and of the HUD band at the top.
function revealCursor() {
  invariant(state.cursor !== null, "cursor not set");
  invariant(state.spacing > 0, "cursor before layout");

  const cell = state.spacing / state.dpr;
  const margin = cell * CURSOR_MARGIN_CELLS;
  const hud = state.hudBand / state.dpr;
  const x = (state.pad + state.cursor.x * state.spacing) / state.dpr;
  const y = (state.pad + state.cursor.y * state.spacing) / state.dpr;

  const width = boardWrap.clientWidth;
  const height = boardWrap.clientHeight;
  let scrollX = boardWrap.scrollLeft;
  let scrollY = boardWrap.scrollTop;

  if (x < scrollX + margin) {
    scrollX = x - margin;
  } else if (x > scrollX + width - margin) {
    scrollX = x - width + margin;
  }

  if (y < scrollY + hud + margin) {
    scrollY = y - hud - margin;
  } else if (y > scrollY + height - margin) {
    scrollY = y - height + margin;
  }

  boardWrap.scrollLeft = Math.max(0, scrollX);
  boardWrap.scrollTop = Math.max(0, scrollY);
  updateOrigin();
  state.boardDirty = true;
  draw();
}

// Put the cursor crossing in the middle of the frame. A board that fits is
// already centred by updateOrigin, so only the scroll offsets are needed.
function centerOnCursor() {
  invariant(state.cursor !== null, "cursor not set");
  invariant(state.spacing > 0, "cursor before layout");

  const x = (state.pad + state.cursor.x * state.spacing - state.viewW / 2) /
    state.dpr;
  const y = (state.pad + state.cursor.y * state.spacing - state.viewH / 2 +
    state.hudInset) / state.dpr;

  boardWrap.scrollLeft = state.boardPx > state.viewW ? Math.max(0, x) : 0;
  boardWrap.scrollTop = state.boardPx > state.viewH ? Math.max(0, y) : 0;
  updateOrigin();
  state.boardDirty = true;
  draw();
}

// Typing a coordinate moves the cursor (and centres the view on it).
function applyCoordInputs() {
  const x = clampCoord(coordXInput.valueAsNumber);
  const y = clampCoord(coordYInput.valueAsNumber);
  if (x === null || y === null) {
    syncCoordFields(true); // empty or invalid: restore the cursor values
    return;
  }

  const center = centerCell();
  state.hover = null;
  state.cursor = { x: x + center, y: y + center };
  lastPointer = null;
  centerOnCursor();
  syncCoordFields(true);
}

function moveCursor(dx, dy) {
  ensureCursor();
  state.hover = null; // keyboard takes over from the pointer ghost
  lastPointer = null;
  const last = state.dim - 1;
  state.cursor = {
    x: Math.min(last, Math.max(0, state.cursor.x + dx)),
    y: Math.min(last, Math.max(0, state.cursor.y + dy)),
  };
  revealCursor();
}

function panBoard(dx, dy) {
  lastPointer = null;
  const step = (state.spacing / state.dpr) * ARROW_STEP_CELLS;
  boardWrap.scrollLeft += dx * step;
  boardWrap.scrollTop += dy * step;
}

function placeAtCursor() {
  ensureCursor();
  invariant(state.cursor !== null, "cursor not set");

  const point = state.cursor;
  if (state.stones.has(keyOf(point.x, point.y)) || isBlocked(point)) {
    return;
  }
  place(point);
  revealCursor();
}

// ---- moves -----------------------------------------------------------

// Keep the readable Map and the flat lookup grid in step.
function setStone(index, player) {
  invariant(player >= 1 && player <= MAX_PLAYERS, "bad stone player");
  invariant(state.playerAt[index] === 0, "cell already occupied");

  const x = cellX(index);
  const y = cellY(index);
  const key = keyOf(x, y);
  state.stones.set(key, { x, y, player });
  state.playerAt[index] = player;
  state.stoneCounts[player] += 1;
  // Only a cycle can seal a new region. A dangling wall leaves the player's
  // reachable set exact as cached, so the flood can be skipped.
  if (connectWall(index, player)) {
    state.playerDirty[player] = 1;
  }
  state.analysis = null;
  state.territoryDirty = true;
}

function removeStone(index) {
  invariant(state.playerAt[index] !== 0, "cell already empty");

  const x = cellX(index);
  const y = cellY(index);
  const key = keyOf(x, y);
  const stone = state.stones.get(key);
  invariant(stone !== undefined, "grid and stone map disagree");

  state.stones.delete(key);
  state.playerAt[index] = 0;
  state.stoneCounts[stone.player] -= 1;
  invariant(state.stoneCounts[stone.player] >= 0, "negative stone count");
  state.playerDirty[stone.player] = 1; // its walls changed too
  state.analysis = null;
  state.territoryDirty = true;
}

// A move that closed no cycle and captured nothing leaves every enclosure
// exactly as cached. The one crossing that changed is the new stone.
function anyPlayerDirty() {
  for (let player = 1; player <= state.playerCount; player += 1) {
    if (state.playerDirty[player] !== 0) {
      return true;
    }
  }
  return false;
}

// A stone may land on empty ground someone already owns. That crossing then
// becomes wall, not score, so fix the cached owner grid and score in place
// instead of rebuilding the whole board.
function patchCachedAnalysisForStone(index) {
  const analysis = state.analysis;
  if (analysis === null) {
    return;
  }
  const holder = analysis.owner[index];
  if (holder === 0) {
    return;
  }
  const score = analysis.scores[holder - 1];
  invariant(score !== undefined && score.player === holder,
    "score row mismatch");
  score.points -= 1;
  invariant(score.points >= 0, "negative territory score");
  analysis.owner[index] = 0;
}

function place(intersection) {
  const index = cellIndex(intersection.x, intersection.y);
  invariant(state.playerAt[index] === 0, "stone already placed here");
  invariant(!isBlocked(intersection), "cannot place inside sealed ground");

  // Undo only needs this move: the stone added, the stones it captured.
  const record = { index, player: state.turn, removed: [] };
  state.history.push(record);
  state.historyRevision += 1;

  const mover = state.turn;
  const cached = state.analysis; // setStone/removeStone drop it
  setStone(index, mover);
  state.turn = nextPlayer(mover);

  // setStone flags the mover when the new stone closes a wall cycle; that
  // flag is consumed again by resolveCaptures/storeEnclosure, so remember it
  // here to know whether the cached analysis still holds.
  const closedCycle = state.playerDirty[mover] !== 0;
  resolveCaptures(mover, record.removed);

  if (closedCycle || record.removed.length > 0 || anyPlayerDirty()) {
    state.analysis = null;
  } else if (cached !== null) {
    state.analysis = cached; // every enclosure is unchanged
    patchCachedAnalysisForStone(index);
  }
  state.territoryDirty = true;
  state.boardDirty = true;
  draw();
}

function undo() {
  const record = state.history.pop();
  if (record === undefined) {
    return;
  }
  state.historyRevision += 1;

  removeStone(record.index);
  for (const captured of record.removed) {
    setStone(captured.index, captured.player);
  }
  state.turn = record.player;
  state.analysis = null;
  state.territoryDirty = true;
  state.boardDirty = true;
  draw();
}

function clampDim(value) {
  if (!Number.isFinite(value)) {
    return state.dim;
  }
  return Math.min(BOARD_SIZE_MAX, Math.max(BOARD_SIZE_MIN, Math.round(value)));
}

function clampPlayers(value) {
  if (!Number.isFinite(value)) {
    return state.playerCount;
  }
  return Math.min(MAX_PLAYERS, Math.max(2, Math.round(value)));
}

function startGame(playerCount, dim) {
  invariant(Number.isInteger(playerCount), "player count not an integer");
  invariant(playerCount >= 2 && playerCount <= MAX_PLAYERS, "bad player count");
  invariant(Number.isInteger(dim), "board size not an integer");
  invariant(dim >= BOARD_SIZE_MIN && dim <= BOARD_SIZE_MAX,
    "board size out of range");

  state.playerCount = playerCount;
  state.dim = dim;
  state.stones.clear();
  state.history.length = 0;
  state.historyRevision += 1;
  state.turn = 1;
  state.hover = null;
  state.cursor = null;
  state.analysis = null;
  allocateCellState(dim);
  state.territoryDirty = true;
  canvas.style.cursor = "";
  playersInput.value = String(playerCount);
  playersDecBtn.disabled = playerCount <= 2;
  playersIncBtn.disabled = playerCount >= MAX_PLAYERS;
  boardInput.min = String(BOARD_SIZE_MIN);
  boardInput.max = String(BOARD_SIZE_MAX);
  boardInput.value = String(dim);
  boardDecBtn.disabled = dim <= BOARD_SIZE_MIN;
  boardIncBtn.disabled = dim >= BOARD_SIZE_MAX;
  const center = centerCell();
  coordXInput.min = String(-center);
  coordXInput.max = String(dim - 1 - center);
  coordYInput.min = String(-center);
  coordYInput.max = String(dim - 1 - center);
  // Start the cursor on the board centre and centre the view on it, so the
  // bottom-left fields read 0, 0.
  boardWrap.scrollLeft = 0;
  boardWrap.scrollTop = 0;
  resize(); // lays out, updates the origin, and draws
  state.cursor = { x: center, y: center };
  state.hover = null;
  lastPointer = null;
  centerOnCursor();
  syncCoordFields(true);
}

function stepPlayers(delta) {
  const next = clampPlayers(state.playerCount + delta);
  if (next !== state.playerCount) {
    startGame(next, state.dim);
  }
}

function stepDim(delta) {
  const next = clampDim(state.dim + delta);
  if (next !== state.dim) {
    startGame(state.playerCount, next);
  }
}

function clearBoard() {
  startGame(state.playerCount, state.dim);
}

// ---- wiring ----------------------------------------------------------

canvas.addEventListener("pointermove", (event) => {
  if (event.pointerType !== "mouse") {
    return; // finger drags scroll the frame, no ghost
  }

  lastPointer = { clientX: event.clientX, clientY: event.clientY };
  const hit = intersectionAt(pointAt(event));
  const blocked = hit !== null && isBlocked(hit);

  state.hover = hit;
  if (hit !== null) {
    state.cursor = hit; // pointer and keyboard share one cursor
  }
  canvas.style.cursor = blocked ? "not-allowed" : "crosshair";
  scheduleDraw();
});

canvas.addEventListener("pointerleave", () => {
  lastPointer = null;
  if (state.hover === null) {
    return;
  }
  state.hover = null;
  canvas.style.cursor = "";
  scheduleDraw();
});

// Place on release, not press, so dragging still scrolls a big board.
let pressOrigin = null;

canvas.addEventListener("pointerdown", (event) => {
  // Only the primary pointer's left button places. Right/middle clicks and
  // extra fingers must not drop a stone.
  if (!event.isPrimary || event.button !== 0) {
    pressOrigin = null;
    return;
  }
  pressOrigin = { x: event.clientX, y: event.clientY };
});

canvas.addEventListener("pointercancel", () => {
  pressOrigin = null;
});

canvas.addEventListener("pointerup", (event) => {
  const origin = pressOrigin;
  pressOrigin = null;

  if (!event.isPrimary || event.button !== 0) {
    return;
  }

  if (event.pointerType !== "mouse") {
    state.hover = null;
  }

  if (origin === null) {
    return;
  }
  const drift = Math.hypot(event.clientX - origin.x, event.clientY - origin.y);
  if (drift > DRAG_TOLERANCE_PX) {
    return;
  }

  const hit = intersectionAt(pointAt(event));
  if (hit === null) {
    return;
  }
  state.cursor = hit;
  if (state.stones.has(keyOf(hit.x, hit.y))) {
    draw();
    return;
  }
  if (isBlocked(hit)) {
    draw();
    return;
  }
  place(hit);
});

undoBtn.addEventListener("click", undo);
clearBtn.addEventListener("click", clearBoard);
playersInput.addEventListener("change", () => {
  const next = clampPlayers(playersInput.valueAsNumber);
  if (next === state.playerCount) {
    playersInput.value = String(state.playerCount); // empty/invalid input
    return;
  }
  startGame(next, state.dim);
});
playersDecBtn.addEventListener("click", () => stepPlayers(-1));
playersIncBtn.addEventListener("click", () => stepPlayers(1));
boardInput.addEventListener("change", () => {
  const next = clampDim(boardInput.valueAsNumber);
  if (next === state.dim) {
    boardInput.value = String(state.dim); // empty/invalid input
    return;
  }
  startGame(state.playerCount, next);
});
boardDecBtn.addEventListener("click", () => stepDim(-1));
boardIncBtn.addEventListener("click", () => stepDim(1));

coordXInput.addEventListener("change", applyCoordInputs);
coordYInput.addEventListener("change", applyCoordInputs);
for (const input of [coordXInput, coordYInput]) {
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyCoordInputs();
      input.blur();
    }
  });
}

// Keep the settings open while a field is focused, even if the pointer
// leaves the panel (typing a board size must not make the panel fold).
controlsEl.addEventListener("focusin", (event) => {
  if (event.target.closest(".panel-inner") !== null) {
    controlsEl.classList.add("keep-open");
  }
});

controlsEl.addEventListener("focusout", (event) => {
  const next = event.relatedTarget;
  if (!(next instanceof Element) || next.closest(".panel-inner") === null) {
    controlsEl.classList.remove("keep-open");
  }
});

// Hover opens a panel via CSS; click or tap pins it open for touch devices.
function bindPanel(panel, tab) {
  tab.addEventListener("click", () => {
    const open = panel.classList.toggle("open");
    tab.setAttribute("aria-expanded", String(open));
  });
}

bindPanel(controlsEl, controlsTab);
bindPanel(scoresEl, scoresTab);
bindPanel(historyEl, historyTab);

window.addEventListener("resize", resize);

// Scrolling moves the spacer, not the canvas: re-pick the visible slice and
// recompose it. This is the only per-scroll cost, and it is bounded by the
// frame, not the board.
boardWrap.addEventListener("scroll", () => {
  updateOrigin();
  refreshHover();
  state.boardDirty = true;
  draw();
}, { passive: true });

// Arrow keys walk the keyboard cursor one crossing at a time, Enter or Space
// places, and Shift+arrow pans. Number fields keep their native arrow
// behaviour (stepping the value), so typing a board size is never hijacked.
const ARROW_PAN = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
};

document.addEventListener("keydown", (event) => {
  const pan = ARROW_PAN[event.key];
  if (pan !== undefined) {
    // Fields and browser shortcuts keep their own arrow-key behaviour.
    if (event.target instanceof HTMLInputElement ||
        event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    event.preventDefault();
    if (event.shiftKey) {
      panBoard(pan[0], pan[1]);
    } else {
      moveCursor(pan[0], pan[1]);
    }
    return;
  }

  if (event.key === " " || event.key === "Enter") {
    // A focused control keeps its own activation key.
    if (event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLButtonElement) {
      return;
    }
    event.preventDefault();
    placeAtCursor();
    return;
  }

  if (event.key === "Escape") {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    controlsEl.classList.remove("keep-open");
    for (const [panel, tab] of [
      [controlsEl, controlsTab],
      [scoresEl, scoresTab],
      [historyEl, historyTab],
    ]) {
      panel.classList.remove("open");
      tab.setAttribute("aria-expanded", "false");
    }
    return;
  }

  const editing = event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLTextAreaElement ||
    (event.target instanceof HTMLElement && event.target.isContentEditable);
  const undoCombo = !editing && !event.shiftKey &&
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === "z";
  if (undoCombo) {
    event.preventDefault();
    undo();
  }
});

startGame(state.playerCount, state.dim);
