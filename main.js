"use strict";

/* Board: dim x dim grid of boxes; stones sit on line crossings.

   Players: 2 to 48, chosen in the floating toolbar. Board size: any whole
   number of crossings from BOARD_SIZE_MIN to BOARD_SIZE_MAX (5 to 94,000,000
   by default; edit the constants below to change the cap). Changing either
   starts a fresh game. Cell size stays fixed and the board scrolls; only the
   visible slice is ever drawn, so board size costs no pixels or dense grids.

   Rules: a closed ring of one colour owns everything inside it, no matter
   how many empty crossings (liberties) stay open. Enclosed opponent stones
   are eaten (removed), and the whole interior is painted with the ring
   colour. Bigger ring beats smaller ring. Diagonal stones count as
   touching, so a diagonal wall is closed too. Nobody may place a stone
   inside a region that is already sealed.

   Performance: stones live in per-row sorted indexes, and an enclosure is a
   flood over row gaps rather than over every crossing. An empty row is one
   gap, so a ring is sealed in time proportional to its wall and the rows it
   spans, not to the board area. Territory is cached as per-player rectangle
   bands and combined into owner bands for rendering and scoring. A stone that
   closes no cycle in its colour's wall graph cannot seal anything, so its
   move skips the flood completely. Undo stores one move delta, the visible
   frame is cached until the stones or scroll position change, stones are
   batched into one path per player, and territory is painted as merged unit
   faces inside the walls, out to the wall lines. */

// ---- config ----------------------------------------------------------

const BOARD_SIZE_DEFAULT = 13; // default crossings per row and column
const BOARD_SIZE_MIN = 5;      // smallest selectable board
// Largest selectable board. Stones and territory are stored sparsely, and
// rendering is viewport-only, so neither memory nor draw cost grows with the
// board area. 94,000,000 crossings per row is 8.8e15 potential crossings, but
// only played stones and sealed bands are allocated. The cap is arithmetic, not
// layout: a crossing is the flat index y*dim+x, and integers above
// 2^53 = 9.007e15 stop being exact, so dim*dim must stay below it. 94M^2 is
// 8.836e15; the exact ceiling is 94,906,265, and 94M keeps a small margin.
// The scroll spacer is virtual (4 M px) and all drawing is frame-local, so the
// board's 3.0 G px size never reaches a browser layout or canvas-precision
// limit.
const BOARD_SIZE_MAX = 94000000;

// A sealed region needs a wall all the way round, and the smallest closed
// wall is the four crossings around a single cell. Fewer stones cannot
// enclose anything, so the floods below skip them.
const MIN_RING_STONES = 4;
// After a removal the sealed cache is rebuilt. Below this bbox height one
// flood is cheaper than walking every stone to group components.
const SEALED_SCAN_ROWS = 4096;
const CELL_MIN_CSS = 32;       // preferred smallest cell; big boards scroll
const CELL_MAX_CSS = 64;       // largest cell, so tiny boards do not balloon
const PADDING_CSS = 28;        // board margin, css pixels
// The scroll spacer is capped so no browser layout limit is ever reached.
// Board coordinates are mapped onto this virtual range; a 1M-crossing board
// (32M css px) still scrolls on every browser.
const SCROLL_MAX_CSS = 4000000;
const DOT_RADIUS_RATIO = 0.40; // stone radius, fraction of spacing
const LINE_WIDTH_CSS = 0.8;    // grid line thickness, in css pixels
const LINK_WIDTH_RATIO = 0.10; // link thickness, fraction of spacing
const DRAG_TOLERANCE_PX = 8;   // press-to-release drift before it is a drag
const DRAG_TOLERANCE_SQ = DRAG_TOLERANCE_PX * DRAG_TOLERANCE_PX;
const ARROW_STEP_CELLS = 3;    // cells panned per pan-key press
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
const LINK_DX = [1, 0, 1, 1];
const LINK_DY = [0, 1, 1, -1];

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
// 8-way wall adjacency, stored flat so the connectWall loop allocates nothing.
const WALL_DX = [-1, 0, 1, -1, 1, -1, 0, 1];
const WALL_DY = [-1, -1, -1, 0, 0, 1, 1, 1];
// The first four directions point at a stone earlier in row-major order, so a
// rebuild that walks stones in row-major order visits every edge exactly once.
const WALL_EARLIER = 4;
// Union-find nodes are per insertion, not per cell, so a re-used cell never
// inherits the wall of a stone that was removed from it. A node is only put on
// the free list once no live stone's parent chain can reach it, so reusing the
// id cannot attach a new stone to an old wall.
let nextWallNode = 1;
let freeWallNodes = new Int32Array(0);
let freeWallCount = 0;

function pushFreeWallNode(node) {
  if (freeWallCount === freeWallNodes.length) {
    const next = new Int32Array(freeWallNodes.length === 0
      ? 1024 : freeWallNodes.length * 2);
    next.set(freeWallNodes);
    freeWallNodes = next;
  }
  freeWallNodes[freeWallCount] = node;
  freeWallCount += 1;
}

function popFreeWallNode() {
  if (freeWallCount === 0) {
    return 0;
  }
  freeWallCount -= 1;
  return freeWallNodes[freeWallCount];
}

function clearFreeWallNodes() {
  freeWallCount = 0;
}

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
const prefsOpenBtn = document.getElementById("prefs-open");
const prefsDialog = document.getElementById("prefs");
const prefsResetBtn = document.getElementById("prefs-reset");
const prefsError = document.getElementById("prefs-error");
const themeSystemNote = document.getElementById("theme-system-note");

// The visible frame, composed (grid, territory, links, stones). It is the
// size of the canvas, not the board. Hovering only blits this layer and draws
// the ghost stone on top; scrolling or a stone change recomposes it.
const boardLayer = document.createElement("canvas");
const boardCtx = boardLayer.getContext("2d");
invariant(boardCtx !== null, "2d context unavailable for board layer");

// The ghost and cursor fit in one cell, so they are composed on a tiny
// scratch canvas and blitted into place. That keeps the second full-frame
// layer out of memory (a 4K dpr2 frame would cost 126 MiB).
const ghostLayer = document.createElement("canvas");
const ghostCtx = ghostLayer.getContext("2d");
invariant(ghostCtx !== null, "2d context unavailable for ghost layer");

// ---- territory -------------------------------------------------------

// Territory is painted from merged owner bands on the visible slice. No
// per-board bitmap: the sweep costs O(bands + runs), and visible faces are
// bounded by the frame just like every other draw pass.

// ---- state -----------------------------------------------------------

const state = {
  viewW: 0,    // canvas size in device pixels (the visible frame)
  viewH: 0,
  viewCssW: 0, // same frame in css pixels, for scroll mapping
  viewCssH: 0,
  boardPx: 0,  // full board size in device pixels (includes the margin)
  boardCss: 0, // full board size in css pixels (may exceed browser limits)
  spacerCssW: 0, // virtual scroll content size in css pixels
  spacerCssH: 0,
  originX: 0,  // board device pixel shown at the canvas top-left
  originY: 0,
  hudBand: 0,  // reserved HUD height, device pixels
  hudInset: 0, // top scroll inset that keeps a scrolled board below the HUD
  hudInsetCss: 0,
  dpr: 1,
  pad: 0,      // board margin in device pixels
  spacing: 0,  // distance between crossings in device pixels
  rows: new Map(), // y -> { xs: number[], players: number[] }, sorted by x
  // Undo history is packed into typed columns: one slot per move plus a flat
  // pool of captured stones. A JS record per move cost ~106 B; this is ~13 B
  // plus 5 B per captured stone. Columns are arrays of fixed-size chunks, so
  // a long game does not pay the doubling slack of one giant typed array.
  historyIndex: [],
  historyPlayer: [],
  historyRemovedStart: [],
  historyRemovedCount: [],
  historyRemovedIndex: [],
  historyRemovedPlayer: [],
  historyLength: 0,
  historyRemovedLength: 0,
  // A move index fits in 24 bits while dim <= 4096 (4096^2 = 2^24), so small
  // boards store three bytes per move and huge boards fall back to four.
  historyIndexNarrow: true,
  historyRevision: 0, // bumped whenever the move list changes, for the panel
  dim: BOARD_SIZE_DEFAULT,  // crossings per row and column
  playerCount: 2,
  turn: 1,
  hover: null,       // { x, y } or null
  cursor: null,      // { x, y } keyboard cursor, null until an arrow key
  territoryDirty: true,
  boardDirty: true,   // visible slice needs recomposing
  analysis: null,    // { scores, ownerBands } cached for current stones
  // The analysis object survives invalidation so the next analyse() can reuse
  // its owner bands. ownerDirty says a player's sealed cache changed, so the
  // merged bands must be rebuilt before the next draw.
  ownerCache: null,
  ownerDirty: false,

  // Int32, not Int16: a single player can own more than 32767 stones on a
  // large board, and a silent wrap would disable captures and crash undo.
  stoneCounts: new Int32Array(MAX_PLAYERS + 1),
  // Live stones across all players. Used to decide when the wall union-find
  // has accumulated enough stale entries to be worth rebuilding.
  stoneTotal: 0,

  // Per-player enclosure cache. A player's sealed region only changes when
  // that player's own stones change, and only a stone that closes a wall
  // cycle can change it. playerDirty marks a cache that must be rebuilt;
  // otherwise analyse() reuses it, skipping the whole flood. The cache is a
  // list of bands: a band is a run of consecutive rows with identical
  // horizontal runs, i.e. a set of rectangles. A simple ring is one band, so
  // both memory and the owner merge scale with rectangles, not rows.
  playerDirty: new Uint8Array(MAX_PLAYERS + 1),
  // Set when a removal may have opened a sealed region. An addition can only
  // grow the sealed set, so a cycle-close may union its flood into the cache;
  // a removal must rebuild the whole player instead.
  playerSealedStale: new Uint8Array(MAX_PLAYERS + 1),
  playerSealed: new Array(MAX_PLAYERS + 1).fill(null), // band list, or null
  // Sealed bands per cyclic wall component, keyed by the current wall root.
  // A component's flood sees only that component's stones, so removing a stone
  // invalidates one component instead of every ring the player owns.
  componentSealed: Array.from({ length: MAX_PLAYERS + 1 }, () => new Map()),
  playerBox: new Array(MAX_PLAYERS + 1).fill(null),    // stone bounding box
  playerBoxStale: new Uint8Array(MAX_PLAYERS + 1),

  // Per-crossing union-find over each player's touching stones. A new stone
  // that closes no cycle cannot seal a new region, so its move skips the
  // flood. Entries are dense typed arrays indexed by node id: node ids are
  // assigned per insertion, so a removed stone's slot can stay stale until a
  // sweep. wallBox is four ints per node (minX, maxX, minY, maxY); only roots
  // carry size and box, but the arrays stay dense so a lookup is an index.
  wallParent: new Uint32Array(0),
  wallSize: new Uint32Array(0),
  wallBox: new Int32Array(0),
  // Roots that have ever closed a cycle. A tree cannot enclose ground, so a
  // whole-player rebuild only has to flood these components.
  wallCycle: new Uint8Array(0),
  // Player that owns each live wall root. A sweep uses it to drop the cycle
  // and sealed-cache entries of a component with no live stones.
  wallRootPlayer: new Uint8Array(0),
  // Number of node ids with a parent entry, live or stale. The typed arrays
  // cannot report a Map-style size, so cleanup thresholds use this counter.
  wallEntries: 0,
  // The same roots, split by player. A rebuild walks one player's components
  // instead of every stone on the board, so undo stays flat as stones grow.
  playerCycles: Array.from({ length: MAX_PLAYERS + 1 }, () => new Set()),
  lastCycleRoot: -1, // root of the component that closed the latest cycle
  lastCycleBox: null, // bbox of the just-closed cycle, or null for the whole box
};

// ---- helpers ---------------------------------------------------------

function invariant(condition, message) {
  if (!condition) {
    throw new Error(`invariant: ${message}`);
  }
}

// Binary search a sorted row of stone x positions. Returns -1 when absent.
function findStone(row, x) {
  const xs = row.xs;
  let lo = 0;
  let hi = row.n - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const value = xs[mid];
    if (value === x) {
      return mid;
    }
    if (value < x) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return -1;
}

// A row starts as three small JS arrays: most rows hold one or two stones, and
// a typed array per row costs more in object overhead than it saves. Once a row
// reaches ROW_TYPED_MIN stones it converts to typed columns, where 9 bytes per
// stone beats 24 plus boxing. `n` is the live length for both forms.
const ROW_TYPED_MIN = 8;

function convertRow(row) {
  const capacity = row.n * 2;
  const xs = new Uint32Array(capacity);
  xs.set(row.xs);
  const players = new Uint8Array(capacity);
  players.set(row.players);
  const nodes = new Uint32Array(capacity);
  nodes.set(row.nodes);
  row.xs = xs;
  row.players = players;
  row.nodes = nodes;
}

function growRow(row, need) {
  invariant(!Array.isArray(row.xs), "growRow on a JS row");
  const capacity = row.xs.length;
  if (need <= capacity) {
    return;
  }
  let next = capacity === 0 ? 1 : capacity;
  while (next < need) {
    next *= 2;
  }
  const xs = new Uint32Array(next);
  xs.set(row.xs.subarray(0, row.n));
  const players = new Uint8Array(next);
  players.set(row.players.subarray(0, row.n));
  const nodes = new Uint32Array(next);
  nodes.set(row.nodes.subarray(0, row.n));
  row.xs = xs;
  row.players = players;
  row.nodes = nodes;
}

// Player id at a crossing, or 0 when empty. This replaces the old dense
// playerAt grid; rows only hold played stones.
function stoneAt(x, y) {
  const row = state.rows.get(y);
  if (row === undefined) {
    return 0;
  }
  const index = findStone(row, x);
  return index === -1 ? 0 : row.players[index];
}

// Insert a stone into its row, keeping x sorted. Rows are short in practice;
// a shift is cheaper and simpler than a tree, and the survey's fallback to a
// sparse bitset is only needed for pathologically packed rows.
function insertStone(x, y, player) {
  invariant(player >= 1 && player <= MAX_PLAYERS, "bad stone player");

  // Prefer a node that cleanup proved unreachable, otherwise take a fresh id.
  // A cell can be emptied and later filled by another player, so the cell
  // index is not a safe node id: reusing it would attach the new stone to the
  // removed stone's old wall.
  let node = popFreeWallNode();
  if (node === 0) {
    node = nextWallNode;
    nextWallNode += 1;
  }
  invariant(node < 0xffffffff, "wall node id overflow");
  ensureWallCapacity(node);
  let row = state.rows.get(y);
  if (row === undefined) {
    state.rows.set(y, {
      xs: [x], players: [player], nodes: [node], n: 1,
    });
    return node;
  }

  let lo = 0;
  let hi = row.n;
  const xs = row.xs;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < x) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  invariant(lo === row.n || xs[lo] !== x, "duplicate row entry");
  if (!Array.isArray(row.xs)) {
    growRow(row, row.n + 1);
    const players = row.players;
    const nodes = row.nodes;
    const targetXs = row.xs;
    targetXs.copyWithin(lo + 1, lo, row.n);
    players.copyWithin(lo + 1, lo, row.n);
    nodes.copyWithin(lo + 1, lo, row.n);
    targetXs[lo] = x;
    players[lo] = player;
    nodes[lo] = node;
  } else {
    row.xs.splice(lo, 0, x);
    row.players.splice(lo, 0, player);
    row.nodes.splice(lo, 0, node);
    if (row.n + 1 >= ROW_TYPED_MIN) {
      row.n += 1;
      convertRow(row);
      return node;
    }
  }
  row.n += 1;
  return node;
}

// Remove a stone from its row. Returns its player and union-find node.
function eraseStone(x, y) {
  const row = state.rows.get(y);
  invariant(row !== undefined, "stone row missing");
  const index = findStone(row, x);
  invariant(index !== -1, "stone not in row");

  const player = row.players[index];
  const node = row.nodes[index];
  if (!Array.isArray(row.xs)) {
    row.xs.copyWithin(index, index + 1, row.n);
    row.players.copyWithin(index, index + 1, row.n);
    row.nodes.copyWithin(index, index + 1, row.n);
  } else {
    row.xs.splice(index, 1);
    row.players.splice(index, 1);
    row.nodes.splice(index, 1);
  }
  row.n -= 1;
  if (row.n === 0) {
    state.rows.delete(y);
  }
  return { player, node };
}

// Bounding box of one player's stones. The box is maintained on insert and
// only rebuilt after a removal touches an edge, so most moves are O(1).
function recomputePlayerBox(player) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const [y, row] of state.rows) {
    const players = row.players;
    for (let i = 0; i < row.n; i += 1) {
      if (players[i] !== player) {
        continue;
      }
      const x = row.xs[i];
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }

  return minX === Infinity ? null : { minX, maxX, minY, maxY };
}

function playerBoxOf(player) {
  if (state.playerBoxStale[player] !== 0) {
    state.playerBox[player] = recomputePlayerBox(player);
    state.playerBoxStale[player] = 0;
  }
  return state.playerBox[player];
}

function growPlayerBox(player, x, y) {
  const box = state.playerBox[player];
  if (box === null) {
    state.playerBox[player] = { minX: x, maxX: x, minY: y, maxY: y };
    return;
  }
  box.minX = Math.min(box.minX, x);
  box.maxX = Math.max(box.maxX, x);
  box.minY = Math.min(box.minY, y);
  box.maxY = Math.max(box.maxY, y);
}

function shrinkPlayerBox(player, x, y) {
  const box = state.playerBox[player];
  if (box === null) {
    return;
  }
  if (x === box.minX || x === box.maxX || y === box.minY || y === box.maxY) {
    state.playerBoxStale[player] = 1;
  }
}

// Flat index for a crossing: row-major, x fastest.
function cellIndex(x, y) {
  invariant(x >= 0 && x < state.dim, "cell x off board");
  invariant(y >= 0 && y < state.dim, "cell y off board");
  return y * state.dim + x;
}

function cellX(index) {
  invariant(Number.isInteger(index) && index >= 0 &&
    index < state.dim * state.dim, "cell index off board");
  return index % state.dim;
}

function cellY(index) {
  invariant(Number.isInteger(index) && index >= 0 &&
    index < state.dim * state.dim, "cell index off board");
  const x = index % state.dim;
  return (index - x) / state.dim;
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

// Clear every sparse board structure for a new game. There is no dim*dim
// allocation any more: memory is proportional to played stones and runs.
function resetBoardState() {
  invariant(MAX_PLAYERS < 128, "player id must fit a signed byte");
  invariant(state.dim > 0, "board must have at least one crossing");
  state.rows.clear();
  nextWallNode = 1;
  clearFreeWallNodes();
  freeWallNodes = new Int32Array(0); // do not carry a huge old free list
  state.wallParent = new Uint32Array(0);
  state.wallSize = new Uint32Array(0);
  state.wallBox = new Int32Array(0);
  state.wallCycle = new Uint8Array(0);
  state.wallRootPlayer = new Uint8Array(0);
  state.wallEntries = 0;
  for (const roots of state.playerCycles) {
    roots.clear();
  }
  state.lastCycleRoot = -1;
  state.lastCycleBox = null;
  state.stoneCounts.fill(0);
  state.stoneTotal = 0;
  state.playerDirty.fill(1);
  state.playerSealedStale.fill(0);
  state.playerSealed.fill(null);
  for (const cache of state.componentSealed) {
    cache.clear();
  }
  state.playerBox.fill(null);
  state.playerBoxStale.fill(0);
  state.analysis = null;
  state.ownerCache = null;
  state.ownerDirty = true;
  releaseFloodScratch();
}

// ---- enclosure -------------------------------------------------------

/* Union the new stone with its same-colour neighbours in the 8-way wall
   graph. Returns { cycle, root }: `cycle` is true when the union closes a
   cycle, and `root` is the component the stone ended up in. The component's
   stone bounding box is kept in wallBox so the seal flood can be scoped to
   that component instead of the player's whole bbox.

   A wall with no cycle is a tree: it cannot cut the grid in two, so the
   player's reachable set (and therefore their enclosure) is unchanged. That
   lets setStone skip marking the player dirty and resolveCaptures skip its
   flood on most moves. Captures and undo leave stale parent links behind, but
   stale links only ever over-connect, so a real cycle is still found; the cost
   is at worst a needless (and larger-box) flood. */
/* Reused connectWall result. Every caller reads it before the next call, so a
   per-stone { cycle, root } object is unnecessary in the hot path. */
const wallResult = { cycle: false, root: 0, cycleBox: null };
// Same-player neighbours of the stone being connected, and the BFS scratch
// used to recover the cycle path. A cycle close is rare, so the scratch is
// reused instead of allocated per move.
const wallNeighbors = [];
const wallNeighborRoots = [];
const wallNeighborNodes = [];
const cyclePrev = new Map();
const cycleQueue = [];
// The path search is only a shortcut for a small new cycle attached to a big
// component. A ring's path is its whole perimeter, so a long search would cost
// more than the component-box flood it is trying to avoid. Keep the budget
// short and let long cycles fall back to the component box, which for a ring is
// the same bbox anyway.
const CYCLE_SEARCH_BUDGET = 1 << 8;

// Add one stone's coordinates to a bbox, creating it when null.
function growBox(box, x, y) {
  if (box === null) {
    return { minX: x, maxX: x, minY: y, maxY: y };
  }
  if (x < box.minX) box.minX = x;
  if (x > box.maxX) box.maxX = x;
  if (y < box.minY) box.minY = y;
  if (y > box.maxY) box.maxY = y;
  return box;
}

function mergeBox(box, other) {
  if (box === null) {
    return { minX: other.minX, maxX: other.maxX,
      minY: other.minY, maxY: other.maxY };
  }
  if (other.minX < box.minX) box.minX = other.minX;
  if (other.maxX > box.maxX) box.maxX = other.maxX;
  if (other.minY < box.minY) box.minY = other.minY;
  if (other.maxY > box.maxY) box.maxY = other.maxY;
  return box;
}

/* Bbox of a shortest wall path from `from` to `to`, ignoring `skip` (the new
   stone). The search stops as soon as `to` is reached, so it costs the path's
   neighbourhood, not the whole component. null means the target was not
   reachable within the budget. */
function cyclePathBetween(player, from, to, skip) {
  const prev = cyclePrev;
  const queue = cycleQueue;
  const dim = state.dim;
  const rows = state.rows;
  prev.clear();
  queue.length = 0;
  prev.set(from, -1);
  queue.push(from);
  let head = 0;
  while (head < queue.length) {
    if (queue.length > CYCLE_SEARCH_BUDGET) {
      return null;
    }
    const node = queue[head];
    head += 1;
    if (node === to) {
      break;
    }
    const x = cellX(node);
    const y = cellY(node);
    for (let d = 0; d < WALL_DX.length; d += 1) {
      const nx = x + WALL_DX[d];
      const ny = y + WALL_DY[d];
      if (nx < 0 || nx >= dim || ny < 0 || ny >= dim) {
        continue;
      }
      const row = rows.get(ny);
      if (row === undefined) {
        continue;
      }
      const at = findStone(row, nx);
      if (at === -1 || row.players[at] !== player) {
        continue;
      }
      const next = ny * dim + nx;
      if (next === skip || prev.has(next)) {
        continue;
      }
      prev.set(next, node);
      queue.push(next);
    }
  }
  if (!prev.has(to)) {
    return null;
  }
  let box = null;
  let cur = to;
  for (;;) {
    box = growBox(box, cellX(cur), cellY(cur));
    const up = prev.get(cur);
    if (up === -1) {
      break;
    }
    cur = up;
  }
  return box;
}

/* Grow the wall arrays so `node` is addressable. Node ids are dense and grow
   with insertions; doubling keeps the copies amortised while stale slots stay
   cheap. Called before any array read of a fresh id. */
function ensureWallCapacity(node) {
  if (node < state.wallParent.length) {
    return;
  }
  let capacity = state.wallParent.length === 0
    ? 1024
    : state.wallParent.length;
  while (capacity <= node) {
    capacity *= 2;
  }
  const parent = new Uint32Array(capacity);
  parent.set(state.wallParent);
  const size = new Uint32Array(capacity);
  size.set(state.wallSize);
  const box = new Int32Array(capacity * 4);
  box.set(state.wallBox);
  const cycle = new Uint8Array(capacity);
  cycle.set(state.wallCycle);
  const rootPlayer = new Uint8Array(capacity);
  rootPlayer.set(state.wallRootPlayer);
  state.wallParent = parent;
  state.wallSize = size;
  state.wallBox = box;
  state.wallCycle = cycle;
  state.wallRootPlayer = rootPlayer;
}

// Bbox of one wall root. Only roots have a live size and box.
function wallBoxAt(node) {
  const box = state.wallBox;
  const at = node * 4;
  return {
    minX: box[at],
    maxX: box[at + 1],
    minY: box[at + 2],
    maxY: box[at + 3],
  };
}

function connectWall(index, player, node, earlierOnly = false) {
  invariant(Number.isInteger(index) && index >= 0, "bad wall index");
  invariant(player >= 1 && player <= MAX_PLAYERS, "bad wall player");
  invariant(Number.isInteger(node) && node >= 0, "bad wall node");

  const rows = state.rows;
  const dim = state.dim;
  const last = dim - 1;
  const x = cellX(index);
  const y = cellY(index);

  // Growing the arrays replaces them; read them only after this call.
  ensureWallCapacity(node);
  const parent = state.wallParent;
  const size = state.wallSize;
  const box = state.wallBox;
  if (parent[node] === 0) {
    parent[node] = node;
    size[node] = 1;
    const at = node * 4;
    box[at] = x;
    box[at + 1] = x;
    box[at + 2] = y;
    box[at + 3] = y;
    state.wallRootPlayer[node] = player;
    state.wallEntries += 1;
  }

  const cycleRoots = state.wallCycle;
  const playerRoots = state.playerCycles[player];
  const count = earlierOnly ? WALL_EARLIER : WALL_DX.length;

  // Every wall neighbour lies in the row above, the same row, or the row
  // below, so the three rows are fetched once instead of per neighbour.
  const rowUp = y > 0 ? rows.get(y - 1) : undefined;
  const rowMid = rows.get(y);
  const rowDown = y < last ? rows.get(y + 1) : undefined;

  // Gather same-player neighbours once. Their roots are read before any
  // union so the cycle-path groups below see the original components.
  wallNeighbors.length = 0;
  wallNeighborRoots.length = 0;
  wallNeighborNodes.length = 0;
  for (let d = 0; d < count; d += 1) {
    const nx = x + WALL_DX[d];
    const ny = y + WALL_DY[d];
    if (nx < 0 || nx > last || ny < 0 || ny > last) {
      continue;
    }
    const row = ny < y ? rowUp : (ny > y ? rowDown : rowMid);
    if (row === undefined) {
      continue;
    }
    const at = findStone(row, nx);
    if (at === -1 || row.players[at] !== player) {
      continue;
    }
    const neighbour = ny * dim + nx;
    wallNeighbors.push(neighbour);
    wallNeighborNodes.push(row.nodes[at]);
    wallNeighborRoots.push(wallRootOf(row.nodes[at]));
  }

  // Bbox of the new cycle(s), or null when the whole component box is needed.
  // A tree has unique paths, so the new faces lie inside the bbox of the
  // paths between its neighbours. A component that already had a cycle can
  // take the same shortcut only when its sealed set is cached: the flood's
  // union then keeps the old ground that the new bbox excludes. A harness
  // that builds cycles with setStone has no cache yet, so it falls back and
  // recomputes everything.
  let cycleBox = null;
  if (!earlierOnly && wallNeighbors.length >= 2) {
    const sealedCache = state.componentSealed[player];
    let allowed = true;
    for (let i = 0; i < wallNeighborRoots.length; i += 1) {
      const root = wallNeighborRoots[i];
      if (state.wallCycle[root] !== 0 && !sealedCache.has(root)) {
        allowed = false;
        break;
      }
    }
    if (allowed) {
      for (let i = 0; i < wallNeighbors.length; i += 1) {
        const root = wallNeighborRoots[i];
        for (let j = i + 1; j < wallNeighbors.length; j += 1) {
          if (wallNeighborRoots[j] !== root) {
            continue;
          }
          const part = cyclePathBetween(player, wallNeighbors[i],
            wallNeighbors[j], index);
          if (part === null) {
            allowed = false;
            break;
          }
          cycleBox = mergeBox(cycleBox, part);
        }
        if (!allowed) {
          break;
        }
      }
    }
    if (!allowed) {
      cycleBox = null;
    } else if (cycleBox !== null) {
      cycleBox = growBox(cycleBox, x, y);
    }
  }

  // The root of `node` only changes when its component is merged into a
  // larger one, and then it is exactly the surviving root `a`. Walking it
  // once per stone instead of once per neighbour saves most of the Map hops.
  let a = wallRootOf(node);
  let aSize = size[a];
  let aMinX = box[a * 4];
  let aMaxX = box[a * 4 + 1];
  let aMinY = box[a * 4 + 2];
  let aMaxY = box[a * 4 + 3];
  invariant(aSize > 0, "wall component missing size");

  let cycle = false;
  for (let k = 0; k < wallNeighbors.length; k += 1) {
    let b = wallRootOf(wallNeighborNodes[k]);
    if (a === b) {
      cycle = true; // two already-connected neighbours
      cycleRoots[a] = 1;
      playerRoots.add(a);
      continue;
    }

    let bSize = size[b];
    let bMinX = box[b * 4];
    let bMaxX = box[b * 4 + 1];
    let bMinY = box[b * 4 + 2];
    let bMaxY = box[b * 4 + 3];
    invariant(bSize > 0, "wall component missing size");
    if (aSize < bSize) {
      let swap = a;
      a = b;
      b = swap;
      swap = aSize;
      aSize = bSize;
      bSize = swap;
      swap = aMinX;
      aMinX = bMinX;
      bMinX = swap;
      swap = aMaxX;
      aMaxX = bMaxX;
      bMaxX = swap;
      swap = aMinY;
      aMinY = bMinY;
      bMinY = swap;
      swap = aMaxY;
      aMaxY = bMaxY;
      bMaxY = swap;
    }
    // Two components become one; their cached sealed sets merge under the
    // surviving root. A missing cache stays missing, to be rebuilt lazily.
    const sealedCache = state.componentSealed[player];
    const bBands = sealedCache.get(b);
    if (bBands !== undefined) {
      sealedCache.delete(b);
      const aBands = sealedCache.get(a);
      sealedCache.set(a, aBands === undefined
        ? bBands
        : unionBands(aBands, bBands));
    }
    parent[b] = a;
    state.wallRootPlayer[b] = 0;
    if (cycleRoots[b] !== 0) {
      cycleRoots[a] = 1; // the cycle now belongs to the surviving root
      cycleRoots[b] = 0;
      playerRoots.delete(b);
      playerRoots.add(a);
    }

    if (bMinX < aMinX) {
      aMinX = bMinX;
    }
    if (bMaxX > aMaxX) {
      aMaxX = bMaxX;
    }
    if (bMinY < aMinY) {
      aMinY = bMinY;
    }
    if (bMaxY > aMaxY) {
      aMaxY = bMaxY;
    }
    aSize += bSize;
    size[b] = 0;
    box[b * 4] = 0;
    box[b * 4 + 1] = 0;
    box[b * 4 + 2] = 0;
    box[b * 4 + 3] = 0;
  }

  size[a] = aSize;
  box[a * 4] = aMinX;
  box[a * 4 + 1] = aMaxX;
  box[a * 4 + 2] = aMinY;
  box[a * 4 + 3] = aMaxY;

  wallResult.cycle = cycle;
  wallResult.root = a;
  wallResult.cycleBox = cycle ? cycleBox : null;
  return wallResult;
}

// Merge two existing wall roots. Used by the batch restore path after it has
// rebuilt the restored stones' internal components; connectWall keeps its own
// inlined copy because it runs per stone and already has the sizes in hand.
function mergeWallRoots(a, b, player) {
  if (a === b) {
    return a;
  }
  const size = state.wallSize;
  const box = state.wallBox;
  let aSize = size[a];
  let bSize = size[b];
  let aMinX = box[a * 4];
  let aMaxX = box[a * 4 + 1];
  let aMinY = box[a * 4 + 2];
  let aMaxY = box[a * 4 + 3];
  let bMinX = box[b * 4];
  let bMaxX = box[b * 4 + 1];
  let bMinY = box[b * 4 + 2];
  let bMaxY = box[b * 4 + 3];
  invariant(aSize > 0 && bSize > 0,
    "wall merge on a missing component");
  if (aSize < bSize) {
    let swap = a;
    a = b;
    b = swap;
    swap = aSize;
    aSize = bSize;
    bSize = swap;
    swap = aMinX;
    aMinX = bMinX;
    bMinX = swap;
    swap = aMaxX;
    aMaxX = bMaxX;
    bMaxX = swap;
    swap = aMinY;
    aMinY = bMinY;
    bMinY = swap;
    swap = aMaxY;
    aMaxY = bMaxY;
    bMaxY = swap;
  }
  const sealedCache = state.componentSealed[player];
  const bBands = sealedCache.get(b);
  if (bBands !== undefined) {
    sealedCache.delete(b);
    const aBands = sealedCache.get(a);
    sealedCache.set(a, aBands === undefined
      ? bBands
      : unionBands(aBands, bBands));
  }
  state.wallParent[b] = a;
  state.wallRootPlayer[b] = 0;
  if (state.wallCycle[b] !== 0) {
    state.wallCycle[a] = 1;
    state.wallCycle[b] = 0;
  }
  const playerRoots = state.playerCycles[player];
  if (playerRoots.delete(b)) {
    playerRoots.add(a);
  }
  if (bMinX < aMinX) aMinX = bMinX;
  if (bMaxX > aMaxX) aMaxX = bMaxX;
  if (bMinY < aMinY) aMinY = bMinY;
  if (bMaxY > aMaxY) aMaxY = bMaxY;
  size[a] = aSize + bSize;
  size[b] = 0;
  box[a * 4] = aMinX;
  box[a * 4 + 1] = aMaxX;
  box[a * 4 + 2] = aMinY;
  box[a * 4 + 3] = aMaxY;
  box[b * 4] = 0;
  box[b * 4 + 1] = 0;
  box[b * 4 + 2] = 0;
  box[b * 4 + 3] = 0;
  return a;
}

function markWallCycle(root, player) {
  state.wallCycle[root] = 1;
  state.playerCycles[player].add(root);
}

// Root of one stone's wall component, with path halving. Stale links left by
// removals are harmless: they only over-connect, so the flood scope is larger
// than it needs to be, never wrong.
function wallRootOf(node) {
  const parent = state.wallParent;
  let current = node;
  let up = parent[current];
  invariant(up !== 0, "wall parent chain broken");
  while (up !== current) {
    const grand = parent[up];
    invariant(grand !== 0, "wall parent chain broken");
    parent[current] = grand; // path halving
    current = grand;
    up = parent[current];
  }
  return current;
}

// Rebuild the wall union-find from the live stones. Captures and undo leave
// entries behind, and stale links only ever over-connect, so they are safe but
// grow with total moves. Rebuilding drops them and re-unions the exact graph;
// it runs only when stale entries outnumber live stones by a wide margin, so
// its cost is amortised to O(1) per move. compactWalls() prefers the cheaper
// sweepWalls() when enough live stones remain.
function rebuildWalls() {
  invariant(state.wallEntries >= state.stoneTotal,
    "fewer wall entries than live stones");
  // Renumber live stones densely. Node ids otherwise grow with every insertion
  // ever played, and the typed arrays would keep a slot for each one. Rebuild
  // already walks every live stone, so assigning fresh ids here is free and
  // lets the arrays drop to the live count.
  state.wallParent = new Uint32Array(0);
  state.wallSize = new Uint32Array(0);
  state.wallBox = new Int32Array(0);
  state.wallCycle = new Uint8Array(0);
  state.wallRootPlayer = new Uint8Array(0);
  state.wallEntries = 0;
  nextWallNode = 1;
  clearFreeWallNodes();
  for (const roots of state.playerCycles) {
    roots.clear();
  }
  for (const cache of state.componentSealed) {
    cache.clear();
  }

  const dim = state.dim;
  // Row-major order means every edge is seen once, from its later endpoint, so
  // each neighbour already has a union entry and no false cycle is detected.
  // The rows map is ordered by insertion, not y, so sort its keys first.
  const ys = Array.from(state.rows.keys());
  ys.sort((a, b) => a - b);
  for (let k = 0; k < ys.length; k += 1) {
    const y = ys[k];
    const row = state.rows.get(y);
    for (let i = 0; i < row.n; i += 1) {
      const node = nextWallNode;
      nextWallNode += 1;
      row.nodes[i] = node;
      connectWall(y * dim + row.xs[i], row.players[i], node, true);
    }
  }
  invariant(state.wallEntries === state.stoneTotal,
    "wall rebuild missed a stone");

  state.lastCycleRoot = -1;
  state.lastCycleBox = null;
  // The cached seals were built under the over-connected graph, which can only
  // have added ground. Rebuild every player before the next draw.
  for (let player = 1; player <= state.playerCount; player += 1) {
    state.playerDirty[player] = 1;
    state.playerSealedStale[player] = 1;
  }
  state.analysis = null;
  state.ownerDirty = true;
}

/* Drop wall entries that no live stone can reach, without re-unioning the
   graph. Every live stone's parent chain is marked, then unreachable entries
   are cleared. Live components keep their root ids, so their sealed caches stay
   valid; a global rebuild clears every cache instead. */
function sweepWalls() {
  const parent = state.wallParent;
  if (state.wallEntries === 0) {
    return;
  }
  // Node ids grow with every insertion, not just live stones. A very long game
  // can make the mark array larger than the live entries it is meant to
  // shrink; rebuild from the live stones instead in that rare case.
  if (nextWallNode > state.stoneTotal * 32 + (1 << 24)) {
    rebuildWalls();
    return;
  }
  const reach = new Uint8Array(nextWallNode);
  for (const row of state.rows.values()) {
    const nodes = row.nodes;
    for (let i = 0; i < row.n; i += 1) {
      let node = nodes[i];
      while (reach[node] === 0) {
        reach[node] = 1;
        const up = parent[node];
        invariant(up !== 0, "sweep hit a broken wall chain");
        if (up === node) {
          break;
        }
        node = up;
      }
    }
  }

  const size = state.wallSize;
  const box = state.wallBox;
  const cycle = state.wallCycle;
  const rootPlayer = state.wallRootPlayer;
  for (let node = 1; node < nextWallNode; node += 1) {
    const up = parent[node];
    if (up === 0) {
      continue;
    }
    if (reach[node] === 0) {
      parent[node] = 0;
      size[node] = 0;
      box[node * 4] = 0;
      box[node * 4 + 1] = 0;
      box[node * 4 + 2] = 0;
      box[node * 4 + 3] = 0;
      cycle[node] = 0;
      const player = rootPlayer[node];
      rootPlayer[node] = 0;
      state.wallEntries -= 1;
      pushFreeWallNode(node);
      if (up !== node) {
        continue;
      }
      if (player !== 0) {
        state.playerCycles[player].delete(node);
        state.componentSealed[player].delete(node);
      } else {
        for (let p = 1; p <= state.playerCount; p += 1) {
          state.playerCycles[p].delete(node);
          state.componentSealed[p].delete(node);
        }
      }
    } else if (up !== node) {
      // Only a root's size and box are read. Non-root copies are leftovers from
      // before the union and would otherwise keep one entry per stone.
      size[node] = 0;
      box[node * 4] = 0;
      box[node * 4 + 1] = 0;
      box[node * 4 + 2] = 0;
      box[node * 4 + 3] = 0;
      cycle[node] = 0;
      rootPlayer[node] = 0;
    }
  }

  state.lastCycleRoot = -1;
  state.lastCycleBox = null;
  state.analysis = null;
  state.ownerDirty = true;
}

// A mass capture that leaves few live stones is cheaper to rebuild from those
// stones than to sweep a huge stale set. Measured sweep costs ~0.3–0.4 µs per
// entry and rebuild ~3 µs per live stone, so the crossover sits near 10x.
function compactWalls() {
  if (state.stoneTotal * 10 < state.wallEntries) {
    rebuildWalls();
  } else {
    sweepWalls();
    // A sweep recycles node ids, so only stale entries can justify the more
    // expensive rebuild. Checking wallsAreStale() here would rebuild right
    // after every successful sweep on a high-id undo/redo cycle.
    if (state.wallEntries > state.stoneTotal * 2 + 256) {
      rebuildWalls();
    }
  }
}

// Threshold for wall cleanup. Stale entries may be twice the live stone count
// plus a small floor, so a tiny board does not sweep every few captures. Node
// ids also count: an undo/redo cycle can re-add every captured stone without
// changing `wallEntries`, and without this check `nextWallNode` (and the
// backing arrays) would grow forever. Free ids are subtracted because sweep
// turns dead ids into reusable nodes; without that, every later cleanup would
// trigger again on the same high id even though nothing needs to grow.
function wallsAreStale() {
  return state.wallEntries > state.stoneTotal * 2 + 256 ||
    nextWallNode - freeWallCount > state.stoneTotal * 2 + 4096;
}

// First index in a sorted row whose x is at least `value`.
function lowerBound(row, value) {
  const xs = row.xs;
  let lo = 0;
  let hi = row.n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < value) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

// Reused flood buffers. A flood can span millions of rows; allocating seven
// typed arrays per call was the largest remaining transient cost. Floods never
// nest, so one scratch set is enough. After a top-level flood the buffers are
// trimmed to the largest use since the last trim, so a one-off giant wall does
// not pin its scratch for the rest of the session.
let floodOffsets = new Int32Array(0);
let floodGapStart = new Int32Array(0);
let floodGapEnd = new Int32Array(0);
let floodOpponentRows = new Uint8Array(0);
let floodReached = new Uint8Array(0);
let floodQueueRow = new Int32Array(0);
let floodQueueGap = new Int32Array(0);
const FLOOD_KEEP_ROWS = 1 << 14; // ~64 KiB per int row buffer
const FLOOD_KEEP_GAPS = 1 << 14;
// A one-off giant wall is not worth pinning megabytes of scratch for. Above
// this many rows or gaps the buffers are released after the top-level flood;
// the next small flood reallocates only what it needs.
const FLOOD_RELEASE_ROWS = 1 << 17;
const FLOOD_RELEASE_GAPS = 1 << 17;
let floodDepth = 0;
let floodPeakRows = 0;
let floodPeakGaps = 0;

function beginFloodScope() {
  invariant(floodDepth >= 0, "negative flood depth");
  if (floodDepth === 0) {
    floodPeakRows = 0;
    floodPeakGaps = 0;
  }
  floodDepth += 1;
}

function trimFloodScratch() {
  invariant(floodDepth === 0, "flood scratch trimmed inside a flood");
  if (floodPeakRows > FLOOD_RELEASE_ROWS ||
      floodPeakGaps > FLOOD_RELEASE_GAPS) {
    releaseFloodScratch();
    return;
  }
  const keepRows = Math.max(FLOOD_KEEP_ROWS,
    floodPeakRows + (floodPeakRows >> 2) + 1024);
  const keepGaps = Math.max(FLOOD_KEEP_GAPS,
    floodPeakGaps + (floodPeakGaps >> 2) + 1024);
  if (floodOffsets.length > keepRows) {
    floodOffsets = new Int32Array(keepRows + 1);
  }
  if (floodGapStart.length > keepGaps) {
    floodGapStart = new Int32Array(keepGaps);
    floodGapEnd = new Int32Array(keepGaps);
  }
  if (floodOpponentRows.length > keepRows) {
    floodOpponentRows = new Uint8Array(keepRows);
  }
  if (floodReached.length > keepGaps) {
    floodReached = new Uint8Array(keepGaps);
    floodQueueRow = new Int32Array(keepGaps);
    floodQueueGap = new Int32Array(keepGaps);
  }
}

function releaseFloodScratch() {
  floodOffsets = new Int32Array(0);
  floodGapStart = new Int32Array(0);
  floodGapEnd = new Int32Array(0);
  floodOpponentRows = new Uint8Array(0);
  floodReached = new Uint8Array(0);
  floodQueueRow = new Int32Array(0);
  floodQueueGap = new Int32Array(0);
  floodPeakRows = 0;
  floodPeakGaps = 0;
}

function endFloodScope() {
  invariant(floodDepth > 0, "flood scope underflow");
  floodDepth -= 1;
  if (floodDepth === 0) {
    trimFloodScratch();
  }
}

// Reused scratch for the per-player rebuild walk. Cleared, never reallocated.
const sealedScratch = {
  seen: new Set(),
  roots: [],
  bandLists: [],
  trapped: new Map(),
};

// Shared "nothing sealed" result. Callers only read it, so one frozen record
// avoids allocating an object and an empty array per player per rebuild.
const EMPTY_SEALED = Object.freeze({
  bands: null,
  trapped: Object.freeze([]),
});

// Mark a gap reached and append it to the BFS queue. Returns the new tail.
function seedGap(reached, queueRow, queueGap, offsets, tail, r, g) {
  const id = offsets[r] + g;
  if (reached[id] !== 0) {
    return tail;
  }
  reached[id] = 1;
  queueRow[tail] = r;
  queueGap[tail] = g;
  return tail + 1;
}

// Append every enemy stone inside `runs` to `trapped`.
function scanTrapped(rows, runs, y, dim, player, trapped) {
  const row = rows.get(y);
  if (row === undefined) {
    return;
  }
  for (let k = 0; k < runs.length; k += 1) {
    const a = runs[k][0];
    const b = runs[k][1];
    let i = lowerBound(row, a);
    for (; i < row.n && row.xs[i] <= b; i += 1) {
      const occupant = row.players[i];
      if (occupant !== player) {
        trapped.push({ index: y * dim + row.xs[i], player: occupant });
      }
    }
  }
}

// True when a band still holds a stone inside one of its runs. After a capture
// removes trapped stones, a band that was unclean only because of them can be
// marked clean again, so later owner merges emit it as one rectangle.
function bandHasStoneInRuns(band) {
  const rows = state.rows;
  const runs = band.runs;
  if (runs.length === 0) {
    return false;
  }
  const first = runs[0][0];
  const last = runs[runs.length - 1][1];
  for (let y = band.y0; y <= band.y1; y += 1) {
    const row = rows.get(y);
    if (row === undefined) {
      continue;
    }
    let i = lowerBound(row, first);
    if (i >= row.n || row.xs[i] > last) {
      continue;
    }
    for (; i < row.n && row.xs[i] <= last; i += 1) {
      const x = row.xs[i];
      for (let r = 0; r < runs.length; r += 1) {
        if (x >= runs[r][0] && x <= runs[r][1]) {
          return true;
        }
      }
    }
  }
  return false;
}

/* Flood one player's wall through row gaps inside `scope` (a stone bounding
   box), or inside the player's whole bbox when scope is omitted. A gap is a
   maximal passable horizontal run, so reaching one cell reaches the whole run.
   Only the player's own stones block the flood; other players' stones sit
   inside gaps and are captured if the gap is sealed.

   The bbox boundary is a valid seed line: no stone of this player lies
   outside the box, so every passable boundary run reaches the board border.
   That is why a ring is found in O(rows + gaps in its box), not O(dim^2).
   A cycle-close passes the component box, so a far-away stone of the same
   player does not inflate the flood.

   With `wallRoot`, only stones in that wall component block the flood. Other
   stones of the same player are passable, so each component's result depends
   only on its own stones and can be cached independently.

   Returns:
     bands   - list of { y0, y1, runs }, or null. Rows y0..y1 all have the
               same horizontal runs [[x0, x1], ...], i.e. one rectangle set.
     trapped - opponent stones inside those runs, as { index, player } */
function computeSealed(player, scope, wallRoot) {
  beginFloodScope();
  const result = computeSealedInner(player, scope, wallRoot);
  endFloodScope();
  return result;
}

function computeSealedInner(player, scope, wallRoot) {
  invariant(Number.isInteger(player), "player id must be an integer");
  invariant(player >= 1 && player <= MAX_PLAYERS, "bad player id");

  const empty = EMPTY_SEALED;
  if (state.stoneCounts[player] < MIN_RING_STONES) {
    return empty;
  }

  const box = scope === undefined ? playerBoxOf(player) : scope;
  if (box === null || box === undefined ||
      box.minX === box.maxX || box.minY === box.maxY) {
    return empty;
  }
  invariant(box.minX <= box.maxX && box.minY <= box.maxY,
    "seal scope is not a box");

  const { minX, maxX, minY, maxY } = box;
  const height = maxY - minY + 1;
  const rows = state.rows;

  // One pass over the rows counts and fills the gaps. The buffers start at
  // one gap per row, the common shape (an empty interior has one gap), and
  // double only when a stone-heavy row needs more. That replaces the old
  // count pass plus fill pass, so a row is read once, not twice.
  if (floodOffsets.length < height + 1) {
    floodOffsets = new Int32Array(height + 1);
  }
  const offsets = floodOffsets;
  let capacity = Math.max(height, 1);
  if (floodGapStart.length < capacity) {
    floodGapStart = new Int32Array(capacity);
    floodGapEnd = new Int32Array(capacity);
  }
  let gapStart = floodGapStart;
  let gapEnd = floodGapEnd;
  capacity = gapStart.length;
  if (floodOpponentRows.length < height) {
    floodOpponentRows = new Uint8Array(height);
  }
  const opponentRows = floodOpponentRows;
  opponentRows.fill(0, 0, height);
  let gapCount = 0;

  for (let r = 0; r < height; r += 1) {
    offsets[r] = gapCount;
    const row = rows.get(minY + r);
    let start = minX;
    if (row !== undefined) {
      const xs = row.xs;
      const players = row.players;
      const nodes = row.nodes;
      const rowCount = row.n;
      let i = lowerBound(row, minX);
      for (; i < rowCount && xs[i] <= maxX; i += 1) {
        const occupant = players[i];
        const isWall = occupant === player &&
          (wallRoot === undefined ||
            wallRootOf(nodes[i]) === wallRoot);
        if (!isWall) {
          // Any passable stone sits inside a run, so the run is not pure
          // ground and the owner merge must split around it. With `wallRoot`
          // this includes the player's other components, which are passable
          // for connectivity but still occupy cells.
          opponentRows[r] = 1;
          continue;
        }
        if (xs[i] > start) {
          if (gapCount === capacity) {
            capacity *= 2;
            const starts = new Int32Array(capacity);
            starts.set(gapStart);
            gapStart = floodGapStart = starts;
            const ends = new Int32Array(capacity);
            ends.set(gapEnd);
            gapEnd = floodGapEnd = ends;
          }
          gapStart[gapCount] = start;
          gapEnd[gapCount] = xs[i] - 1;
          gapCount += 1;
        }
        start = xs[i] + 1;
      }
    }
    if (start <= maxX) {
      if (gapCount === capacity) {
        capacity *= 2;
        const starts = new Int32Array(capacity);
        starts.set(gapStart);
        gapStart = floodGapStart = starts;
        const ends = new Int32Array(capacity);
        ends.set(gapEnd);
        gapEnd = floodGapEnd = ends;
      }
      gapStart[gapCount] = start;
      gapEnd[gapCount] = maxX;
      gapCount += 1;
    }
    offsets[r + 1] = gapCount;
  }
  if (height > floodPeakRows) {
    floodPeakRows = height;
  }
  if (gapCount > floodPeakGaps) {
    floodPeakGaps = gapCount;
  }
  if (gapCount === 0) {
    return empty;
  }

  if (floodReached.length < gapCount) {
    floodReached = new Uint8Array(gapCount);
    floodQueueRow = new Int32Array(gapCount);
    floodQueueGap = new Int32Array(gapCount);
  }
  const reached = floodReached;
  const queueRow = floodQueueRow;
  const queueGap = floodQueueGap;
  reached.fill(0, 0, gapCount);
  let head = 0;
  let tail = 0;

  // Seed every boundary gap. Top and bottom rows have no rows beyond them in
  // the box; any gap touching the left or right box edge is also outside.
  for (let g = 0; g < offsets[1]; g += 1) {
    tail = seedGap(reached, queueRow, queueGap, offsets, tail, 0, g);
  }
  if (height > 1) {
    const lastRow = height - 1;
    for (let g = offsets[lastRow]; g < offsets[height]; g += 1) {
      tail = seedGap(reached, queueRow, queueGap, offsets, tail, lastRow,
        g - offsets[lastRow]);
    }
  }
  for (let r = 0; r < height; r += 1) {
    const base = offsets[r];
    for (let g = base; g < offsets[r + 1]; g += 1) {
      if (gapStart[g] === minX || gapEnd[g] === maxX) {
        tail = seedGap(reached, queueRow, queueGap, offsets, tail, r, g - base);
      }
    }
  }

  // BFS over gap nodes. Adjacent rows connect when their x intervals overlap.
  while (head < tail) {
    const r = queueRow[head];
    const g = queueGap[head];
    head += 1;
    const id = offsets[r] + g;
    const a = gapStart[id];
    const b = gapEnd[id];

    for (let dr = -1; dr <= 1; dr += 2) {
      const nr = r + dr;
      if (nr < 0 || nr >= height) {
        continue;
      }
      const end = offsets[nr + 1];
      // First gap in the neighbour row whose end is at or past `a`.
      let lo = offsets[nr];
      let hi = end;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (gapEnd[mid] < a) {
          lo = mid + 1;
        } else {
          hi = mid;
        }
      }
      for (let ng = lo; ng < end && gapStart[ng] <= b; ng += 1) {
        tail = seedGap(reached, queueRow, queueGap, offsets, tail, nr,
          ng - offsets[nr]);
      }
    }
  }

  // Collect sealed gaps row by row, coalescing consecutive rows with the
  // same runs into one band. A simple ring's interior is one band, so the
  // owner merge below touches rectangles, not thousands of rows. A row that
  // matches the open band is compared in place, so an unchanged interior row
  // allocates nothing.
  let bands = null;
  let open = null;
  const trapped = [];
  const dim = state.dim;

  for (let r = 0; r < height; r += 1) {
    const y = minY + r;
    const rowClean = opponentRows[r] === 0;

    if (open !== null && open.y1 === y - 1) {
      let k = 0;
      let same = true;
      for (let g = offsets[r]; g < offsets[r + 1]; g += 1) {
        if (reached[g] !== 0) {
          continue;
        }
        const run = open.runs[k];
        if (run === undefined || run[0] !== gapStart[g] ||
            run[1] !== gapEnd[g]) {
          same = false;
          break;
        }
        k += 1;
      }
      if (same && k === open.runs.length) {
        if (!rowClean) {
          scanTrapped(rows, open.runs, y, dim, player, trapped);
        }
        open.y1 = y;
        open.clean = open.clean && rowClean;
        continue;
      }
    }

    let rowRuns = null;
    for (let g = offsets[r]; g < offsets[r + 1]; g += 1) {
      if (reached[g] !== 0) {
        continue;
      }
      if (rowRuns === null) {
        rowRuns = [];
      }
      rowRuns.push([gapStart[g], gapEnd[g]]);
    }

    // A row with no enemy stone cannot trap one, so the common sealed row
    // skips the stone scan entirely.
    if (rowRuns !== null && !rowClean) {
      scanTrapped(rows, rowRuns, y, dim, player, trapped);
    }

    if (rowRuns === null) {
      if (open !== null) {
        if (bands === null) {
          bands = [];
        }
        bands.push(open);
        open = null;
      }
      continue;
    }
    if (open !== null) {
      if (bands === null) {
        bands = [];
      }
      bands.push(open);
    }
    open = { y0: y, y1: y, runs: rowRuns, clean: rowClean };
  }
  if (open !== null) {
    if (bands === null) {
      bands = [];
    }
    bands.push(open);
  }

  return { bands, trapped };
}

// Keep the old enclosure name for the benchmark and differential harness.
function enclosure(player) {
  invariant(Number.isInteger(player), "player id must be an integer");
  invariant(player >= 1 && player <= MAX_PLAYERS, "bad player id");
  return computeSealed(player);
}

/* Rebuild one player's whole sealed cache after a removal. A removal can only
   open regions, never close one, so the cached bands cannot be patched; they
   are recomputed. Two strategies, picked by cost:

   - Flood each component that ever closed a cycle and union the results. A
     tree cannot enclose ground, so every other component is skipped. This
     keeps a stone in each far corner cheap: the flood follows each small
     component, not the million-row board bbox.
   - Flood the player's bbox once. That wins when the components together span
     about as many rows as the bbox anyway, as with many small regions.

   The components are listed per player, so this walk costs the player's cycle
   count, not the board's stone count. A stale bbox is never rebuilt here: the
   flood scope can over-approximate, so the component path simply runs instead
   of paying a full scan to tighten it.

   Trapped stones are deduplicated: a nested component's flood reports the same
   interior that the outer component's flood reports. */
function computeSealedPlayer(player) {
  beginFloodScope();
  const result = computeSealedPlayerInner(player);
  endFloodScope();
  return result;
}

function computeSealedPlayerInner(player) {
  invariant(Number.isInteger(player) && player >= 1, "bad player id");

  const empty = EMPTY_SEALED;
  if (state.stoneCounts[player] < MIN_RING_STONES) {
    return empty;
  }
  const owned = state.playerCycles[player];
  if (owned.size === 0) {
    return empty; // no cycle, so no enclosed ground
  }

  const box = state.playerBoxStale[player] === 0
    ? state.playerBox[player]
    : null;
  const cache = state.componentSealed[player];
  const seen = sealedScratch.seen;
  seen.clear();
  const roots = sealedScratch.roots;
  roots.length = 0;
  let cached = 0;

  for (const stored of owned) {
    const root = wallRootOf(stored);
    if (seen.has(root) || state.wallCycle[root] === 0) {
      continue;
    }
    seen.add(root);
    roots.push(root);
    if (cache.has(root)) {
      cached += 1;
    }
  }

  if (roots.length === 0) {
    return empty; // no live cycle, so no enclosed ground
  }
  // No component has a cache yet, and the player's bbox is short enough for
  // the old whole-bbox flood to beat per-component setup. This keeps the
  // first analysis of bench-built many-ring boards fast. Real play caches
  // each ring when it closes, so it takes the component path below.
  if (cached === 0 && box !== null &&
      box.maxY - box.minY + 1 <= SEALED_SCAN_ROWS) {
    return computeSealed(player);
  }

  const trappedByIndex = sealedScratch.trapped;
  trappedByIndex.clear();
  const bandLists = sealedScratch.bandLists;
  bandLists.length = 0;

  for (let r = 0; r < roots.length; r += 1) {
    const root = roots[r];
    let bands = cache.get(root);
    if (bands === undefined) {
      const scope = wallBoxAt(root);
      invariant(state.wallSize[root] > 0, "cycle component missing its box");
      const spot = computeSealed(player, scope, root);
      bands = spot.bands;
      cache.set(root, bands);
      for (let t = 0; t < spot.trapped.length; t += 1) {
        const stone = spot.trapped[t];
        trappedByIndex.set(stone.index, stone);
      }
    }
    if (bands !== null) {
      bandLists.push(bands);
    }
  }

  const trapped = Array.from(trappedByIndex.values());
  trappedByIndex.clear();
  return { bands: unionAllBandLists(bandLists), trapped };
}

// Append a span to a sorted run list, coalescing touching or overlapping
// spans. Kept outside mergeRunLists so a merge allocates no closure.
function pushRun(out, a, b) {
  const last = out[out.length - 1];
  if (last !== undefined && a <= last[1] + 1) {
    if (b > last[1]) {
      last[1] = b;
    }
    return;
  }
  out.push([a, b]);
}

// Merge two sorted run lists, coalescing touching or overlapping spans.
// Sealed runs of one player are a union, so overlapping entries from two
// components of the same player collapse into one.
function mergeRunLists(left, right) {
  const out = [];
  let i = 0;
  let j = 0;

  while (i < left.length || j < right.length) {
    let next;
    if (j >= right.length ||
        (i < left.length && left[i][0] <= right[j][0])) {
      next = left[i];
      i += 1;
    } else {
      next = right[j];
      j += 1;
    }
    pushRun(out, next[0], next[1]);
  }
  return out;
}

// Same runs in both lists. Bands are read-only once built, so sharing a run
// array between bands is safe. Owner runs carry a player as a third element,
// sealed bands only x0/x1, so every present element is compared.
function runsEqual(left, right) {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i];
    const b = right[i];
    if (a.length !== b.length) {
      return false;
    }
    for (let k = 0; k < a.length; k += 1) {
      if (a[k] !== b[k]) {
        return false;
      }
    }
  }
  return true;
}

/* Union two band lists. Additions to a player's sealed set are monotonic, so
   a new flood is merged into the cache instead of replacing it. Cut both
   lists at every band boundary, union the runs of each slice, then coalesce
   identical neighbouring slices back into bands. A ring's 16,000 rows stay
   one band through this, which is why it replaced the per-row merge. */
function unionBands(left, right) {
  if (left === null || left === undefined) {
    return right === undefined ? null : right;
  }
  if (right === null || right === undefined) {
    return left;
  }

  const cuts = [];
  for (let i = 0; i < left.length; i += 1) {
    cuts.push(left[i].y0, left[i].y1 + 1);
  }
  for (let i = 0; i < right.length; i += 1) {
    cuts.push(right[i].y0, right[i].y1 + 1);
  }
  cuts.sort((a, b) => a - b);

  const out = [];
  let li = 0;
  let ri = 0;
  let open = null;
  for (let c = 0; c + 1 < cuts.length; c += 1) {
    const y = cuts[c];
    if (cuts[c + 1] === y) {
      continue;
    }
    const next = cuts[c + 1];
    while (li < left.length && left[li].y1 < y) {
      li += 1;
    }
    while (ri < right.length && right[ri].y1 < y) {
      ri += 1;
    }
    const leftBand = li < left.length && left[li].y0 <= y ? left[li] : null;
    const rightBand = ri < right.length && right[ri].y0 <= y
      ? right[ri] : null;
    let runs;
    let clean;
    if (leftBand === null) {
      runs = rightBand === null ? null : rightBand.runs;
      clean = rightBand === null || rightBand.clean;
    } else if (rightBand === null) {
      runs = leftBand.runs;
      clean = leftBand.clean;
    } else {
      runs = mergeRunLists(leftBand.runs, rightBand.runs);
      clean = leftBand.clean && rightBand.clean;
    }
    if (runs === null || runs.length === 0) {
      // `open`, when present, is already in `out`; just stop extending it.
      open = null;
      continue;
    }
    if (open !== null && open.y1 === y - 1 && runsEqual(open.runs, runs)) {
      open.y1 = next - 1;
      open.clean = open.clean && clean;
    } else {
      open = { y0: y, y1: next - 1, runs, clean };
      out.push(open);
    }
  }
  return out.length === 0 ? null : out;
}

// Union many sorted band lists. Pairwise balanced merging keeps the total
// copied bands at O(n log n); folding left-to-right would be O(n^2) for a
// board with thousands of separate rings.
function unionAllBandLists(lists) {
  invariant(Array.isArray(lists), "band lists must be an array");
  if (lists.length === 0) {
    return null;
  }
  let level = lists;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const right = i + 1 < level.length ? level[i + 1] : null;
      next.push(unionBands(level[i], right));
    }
    level = next;
  }
  return level[0];
}

// Union a component's sealed bands into the player's cache. Additions can
// only grow a player's sealed set, so old bands never need to be dropped here;
// a removal goes through the whole-player rebuild instead.
function addSealedBands(player, bands) {
  if (bands === null || bands === undefined) {
    return;
  }
  state.playerSealed[player] = unionBands(state.playerSealed[player], bands);
}

// Cache one component's flood result under its current root. Additions are
// monotonic, so a newer flood of the same component unions with the old one.
function addComponentSealed(player, root, bands) {
  invariant(Number.isInteger(root) && root >= 0, "bad sealed component root");
  invariant(player >= 1 && player <= MAX_PLAYERS, "bad sealed component player");
  const cache = state.componentSealed[player];
  const old = cache.get(root);
  if (old === undefined) {
    cache.set(root, bands === undefined ? null : bands);
  } else {
    cache.set(root, unionBands(old, bands));
  }
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

  let spot;
  if (state.playerSealedStale[player] !== 0) {
    // A removal may have opened a region, so the cached bands cannot be
    // trusted. Rebuild the player component by component; this is the
    // undo/capture path.
    spot = computeSealedPlayer(player);
    state.playerSealed[player] = spot.bands;
    state.playerSealedStale[player] = 0;
  } else {
    // A fresh cycle can only add sealed ground, and it can only be enclosed
    // by the wall component that just closed. Flood that component's box and
    // union the result, so a stone on the far side of the board is free.
    const root = state.lastCycleRoot;
    invariant(root >= 0, "cycle close without a component root");
    let scope = state.lastCycleBox;
    if (scope === null) {
      scope = wallBoxAt(root);
      invariant(state.wallSize[root] > 0, "cycle component missing its box");
    }
    spot = computeSealed(player, scope, root);
    addSealedBands(player, spot.bands);
    addComponentSealed(player, root, spot.bands);
  }
  state.playerDirty[player] = 0;
  state.ownerDirty = true;

  const captured = spot.trapped.length;
  for (let i = 0; i < captured; i += 1) {
    const trapped = spot.trapped[i];
    invariant(trapped.player > 0, "trapped crossing without stone");
    removed.push(trapped); // the flood result is discarded after this call
  }
  if (captured === 0) {
    return;
  }
  removeStones(spot.trapped);

  // A band was unclean because an opponent stone sat in one of its runs. That
  // stone is gone now, so recheck the mover's unclean bands and let the owner
  // merge emit them as single rectangles again instead of scanning every row.
  // ownerDirty is already set above, so the merge will pick up the change.
  const bands = state.playerSealed[player];
  if (bands !== null && bands !== undefined) {
    for (let i = 0; i < bands.length; i += 1) {
      const band = bands[i];
      if (!band.clean && !bandHasStoneInRuns(band)) {
        band.clean = true;
      }
    }
  }
}

/* Reused sweep scratch. `cuts` is truncated and refilled, the active list is
   refilled from a pool of { player, runs } slots, and the per-player cursor
   array is cleared. None of these escape rebuildOwnerBands. */
const sweepCuts = [];
const sweepActivePool = [];
const sweepActive = [];
let sweepNext = new Int32Array(0);

/* Merge every player's sealed bands into owner bands. A band is a range of
   rows with identical owner runs, so a ring's whole interior is one entry
   instead of one entry per row. Between two consecutive band boundaries the
   set of active sealed runs is constant; that slice is merged once and split
   only where a stone sits inside a run. Stones are rare inside sealed ground
   (they are captured), so the split is normally skipped. */

// Owner runs for one row slice, highest player id winning. `active` holds
// { player, runs } for every sealed band covering the slice.
// Reused per-slice active-player counts.
let mergeCounts = new Int32Array(0);
// Reused event objects and work list. The event count changes per slice, so
// the list is truncated and refilled from the pool instead of reallocated.
const mergeEventPool = [];
const mergeEventWork = [];

function pushMergeEvent(events, x, player, delta) {
  const i = events.length;
  let event = mergeEventPool[i];
  if (event === undefined) {
    event = { x: 0, player: 0, delta: 0 };
    mergeEventPool[i] = event;
  }
  event.x = x;
  event.player = player;
  event.delta = delta;
  events.push(event);
}

function mergeActiveRuns(active, playerCount) {
  const events = mergeEventWork;
  events.length = 0;
  for (let i = 0; i < active.length; i += 1) {
    const runs = active[i].runs;
    const player = active[i].player;
    for (let r = 0; r < runs.length; r += 1) {
      pushMergeEvent(events, runs[r][0], player, 1);
      pushMergeEvent(events, runs[r][1] + 1, player, -1);
    }
  }
  if (events.length === 0) {
    return null;
  }
  events.sort((a, b) => a.x - b.x);

  if (mergeCounts.length < playerCount + 1) {
    mergeCounts = new Int32Array(playerCount + 1);
  }
  const counts = mergeCounts;
  counts.fill(0, 0, playerCount + 1);
  const out = [];
  let maxActive = 0;
  let cursor = events[0].x;
  let i = 0;

  while (i < events.length) {
    const x = events[i].x;
    if (x > cursor && maxActive > 0) {
      out.push([cursor, x - 1, maxActive]);
    }
    while (i < events.length && events[i].x === x) {
      const event = events[i];
      counts[event.player] += event.delta;
      if (event.delta > 0 && event.player > maxActive) {
        maxActive = event.player;
      }
      i += 1;
    }
    while (maxActive > 0 && counts[maxActive] === 0) {
      maxActive -= 1;
    }
    cursor = x;
  }
  if (maxActive > 0 && cursor <= state.dim - 1) {
    out.push([cursor, state.dim - 1, maxActive]);
  }
  return out.length === 0 ? null : out;
}

// Split owner runs around stones in one row. Returns the same array when the
// row has no stone inside the band's x range, which is the normal case: a
// sealed crossing holding a stone is a wall, not ground, so it is not owned.
function splitRunsAroundStones(runs, row) {
  if (row === undefined) {
    return runs;
  }
  const xs = row.xs;
  const first = lowerBound(row, runs[0][0]);
  if (first >= row.n || xs[first] > runs[runs.length - 1][1]) {
    return runs;
  }

  const out = [];
  for (let r = 0; r < runs.length; r += 1) {
    const a = runs[r][0];
    const b = runs[r][1];
    const player = runs[r][2];
    let start = a;
    let i = lowerBound(row, a);
    for (; i < row.n && xs[i] <= b; i += 1) {
      if (xs[i] > start) {
        out.push([start, xs[i] - 1, player]);
      }
      start = xs[i] + 1;
    }
    if (start <= b) {
      out.push([start, b, player]);
    }
  }
  return out;
}

// Append owner bands for rows y0..y1 whose merged sealed runs are `runs`.
// Consecutive rows with the same owner runs coalesce into one band. A clean
// slice has no stone inside any active sealed band, so every row is the same
// and the whole slice is emitted and scored at once.
function emitOwnerSlice(ownerBands, scores, y0, y1, runs, clean) {
  if (runs === null) {
    return;
  }
  if (clean) {
    const height = y1 - y0 + 1;
    for (let r = 0; r < runs.length; r += 1) {
      const run = runs[r];
      scores[run[2] - 1].points += height * (run[1] - run[0] + 1);
    }
    ownerBands.push({ y0, y1, runs });
    return;
  }
  let open = null;
  for (let y = y0; y <= y1; y += 1) {
    const rowRuns = splitRunsAroundStones(runs, state.rows.get(y));
    if (rowRuns.length === 0) {
      if (open !== null) {
        ownerBands.push(open);
        open = null;
      }
      continue;
    }
    if (open !== null && open.y1 === y - 1 && runsEqual(open.runs, rowRuns)) {
      open.y1 = y;
    } else {
      if (open !== null) {
        ownerBands.push(open);
      }
      open = { y0: y, y1: y, runs: rowRuns };
    }
    for (let r = 0; r < rowRuns.length; r += 1) {
      scores[rowRuns[r][2] - 1].points += rowRuns[r][1] - rowRuns[r][0] + 1;
    }
  }
  if (open !== null) {
    ownerBands.push(open);
  }
}

function rebuildOwnerBands(analysis) {
  const playerCount = state.playerCount;
  let scores = analysis.scores;
  if (scores.length !== playerCount) {
    scores = new Array(playerCount);
    for (let i = 0; i < playerCount; i += 1) {
      scores[i] = { player: i + 1, points: 0 };
    }
    analysis.scores = scores;
  } else {
    for (let i = 0; i < playerCount; i += 1) {
      scores[i].points = 0;
    }
  }

  const cuts = sweepCuts;
  cuts.length = 0;
  for (let player = 1; player <= playerCount; player += 1) {
    const bands = state.playerSealed[player];
    if (bands === null || bands === undefined) {
      continue;
    }
    for (let i = 0; i < bands.length; i += 1) {
      cuts.push(bands[i].y0, bands[i].y1 + 1);
    }
  }

  const ownerBands = analysis.ownerBands;
  ownerBands.length = 0;
  if (cuts.length === 0) {
    return;
  }
  cuts.sort((a, b) => a - b);

  // One cursor per player, advanced as the sweep rises. A player's bands are
  // sorted and never overlap, so at most one of them covers a row.
  if (sweepNext.length < playerCount + 1) {
    sweepNext = new Int32Array(playerCount + 1);
  }
  const next = sweepNext;
  next.fill(0, 0, playerCount + 1);
  const active = sweepActive;
  active.length = 0;
  for (let c = 0; c + 1 < cuts.length; c += 1) {
    const y = cuts[c];
    if (cuts[c + 1] === y) {
      continue; // duplicate boundary; the next slice starts here
    }
    const end = cuts[c + 1] - 1;
    active.length = 0;
    let clean = true;
    for (let player = 1; player <= playerCount; player += 1) {
      const bands = state.playerSealed[player];
      if (bands === null || bands === undefined) {
        continue;
      }
      let i = next[player];
      while (i < bands.length && bands[i].y1 < y) {
        i += 1;
      }
      next[player] = i;
      if (i < bands.length && bands[i].y0 <= y) {
        let slot = sweepActivePool[active.length];
        if (slot === undefined) {
          slot = { player: 0, runs: null };
          sweepActivePool[active.length] = slot;
        }
        slot.player = player;
        slot.runs = bands[i].runs;
        active.push(slot);
        if (!bands[i].clean) {
          clean = false;
        }
      }
    }
    emitOwnerSlice(ownerBands, scores, y, end,
      mergeActiveRuns(active, playerCount), clean);
  }

  analysis.scores = scores;
  analysis.ownerBands = ownerBands;
}

// Analysis cache: owner bands and scores, rebuilt when a sealed cache changes.
// A player's sealed region depends only on that player's own stones, so the
// enclosure of an untouched player is reused instead of re-flooded.
function emptyAnalysis() {
  const scores = [];
  for (let player = 1; player <= state.playerCount; player += 1) {
    scores.push({ player, points: 0 });
  }
  return { scores, ownerBands: [] };
}

// Recompute the players whose sealed cache changed, then rebuild the merged
// owner bands once. The sweep touches band boundaries, not every player row,
// and coalesces identical rows, so a ring is a single band.
function updateOwnerBands(analysis) {
  let changed = state.ownerDirty;
  for (let player = 1; player <= state.playerCount; player += 1) {
    if (state.playerDirty[player] === 0) {
      continue;
    }
    state.playerDirty[player] = 0;
    changed = true;

    if (state.stoneCounts[player] < MIN_RING_STONES) {
      state.playerSealed[player] = null; // too few stones to close a wall
      state.playerSealedStale[player] = 0;
      continue;
    }

    const spot = computeSealedPlayer(player);
    state.playerSealed[player] = spot.bands;
    state.playerSealedStale[player] = 0;
  }
  state.ownerDirty = false;

  if (changed) {
    rebuildOwnerBands(analysis);
  }
}

function analyse() {
  if (state.analysis !== null) {
    return state.analysis;
  }

  if (state.ownerCache === null) {
    state.ownerCache = emptyAnalysis();
    // First analysis of this board: there is no earlier owner map to reuse,
    // so every cached sealed band has to be merged.
    state.ownerDirty = true;
  }

  updateOwnerBands(state.ownerCache);
  state.analysis = state.ownerCache;
  return state.analysis;
}

// Band containing row y, or null. Bands are sorted and never overlap.
function bandAt(bands, y) {
  let lo = 0;
  let hi = bands.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const band = bands[mid];
    if (y < band.y0) {
      hi = mid - 1;
    } else if (y > band.y1) {
      lo = mid + 1;
    } else {
      return band;
    }
  }
  return null;
}

// A clean band claims it holds no stone, which lets the owner merge skip its
// rows. A direct stone insertion can break that claim (undo restore, tests);
// a normal move cannot, because isBlocked refuses sealed ground.
function dirtyBandsAt(x, y) {
  for (let player = 1; player <= state.playerCount; player += 1) {
    const bands = state.playerSealed[player];
    if (bands === null || bands === undefined) {
      continue;
    }
    const band = bandAt(bands, y);
    if (band === null) {
      continue;
    }
    const runs = band.runs;
    let lo = 0;
    let hi = runs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const run = runs[mid];
      if (x < run[0]) {
        hi = mid - 1;
      } else if (x > run[1]) {
        lo = mid + 1;
      } else {
        if (band.clean) {
          band.clean = false;
          state.ownerDirty = true;
        }
        // A stone placed directly inside a cached sealed band was not in the
        // flood that produced it (undo restore or the test harness). Drop this
        // player's component caches so the next analysis re-floods with it.
        // A batch restore calls this once per stone; after the first stone in
        // the band the cache is empty and the flags are already set, so the
        // repeated work is skipped.
        const cache = state.componentSealed[player];
        if (cache.size !== 0) {
          cache.clear();
        }
        if (state.playerDirty[player] === 0) {
          state.playerDirty[player] = 1;
        }
        if (state.playerSealedStale[player] === 0) {
          state.playerSealedStale[player] = 1;
        }
        break;
      }
    }
  }
}

// Owner of a crossing, or 0 when it is empty ground. Binary search the band
// covering the row, then the run covering x; a stone crossing is never inside
// a run.
function ownerAt(x, y) {
  const band = bandAt(analyse().ownerBands, y);
  if (band === null) {
    return 0;
  }
  const runs = band.runs;
  let lo = 0;
  let hi = runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const run = runs[mid];
    if (x < run[0]) {
      hi = mid - 1;
    } else if (x > run[1]) {
      lo = mid + 1;
    } else {
      return run[2];
    }
  }
  return 0;
}

// A crossing sealed by any wall is owned already: no stone may go there.
function isBlocked(point) {
  invariant(point !== null, "blocked check without a point");
  invariant(Number.isInteger(point.x) && Number.isInteger(point.y),
    "blocked check needs integer coordinates");
  return ownerAt(point.x, point.y) !== 0;
}

// Territory points per player. Later players paint over earlier ones, so
// the later enclosure owns a shared cell, matching the on-board colours.
function computeScores() {
  return analyse().scores;
}

let renderedScores = null;

// The leader header is always on screen, even when the score rows behind it
// are collapsed, so it is updated from the territory pass as well.
function updateLeader(scores) {
  const ranked = scores.toSorted(
    (a, b) => b.points - a.points || a.player - b.player,
  );
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
  return ranked;
}

function renderScores(scores) {
  // Points usually do not move on a quiet move; compare the numbers directly
  // instead of allocating a key string.
  if (renderedScores !== null && renderedScores.length === scores.length) {
    let same = true;
    for (let i = 0; i < scores.length; i += 1) {
      if (renderedScores[i] !== scores[i].points) {
        same = false;
        break;
      }
    }
    if (same) {
      return;
    }
  }
  renderedScores = new Array(scores.length);
  for (let i = 0; i < scores.length; i += 1) {
    renderedScores[i] = scores[i].points;
  }

  const ranked = updateLeader(scores);
  const best = ranked[0];

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

// The header is always on screen; the rows behind it are not.
function updateHistoryLine() {
  const count = state.historyLength;
  if (count === 0) {
    historyLine.textContent = "No moves";
    return;
  }
  const last = count - 1;
  const index = historyMoveIndex(last);
  historyLine.textContent =
    `${playerName(historyMovePlayer(last))} · ` +
    `${coordX(index)}, ${coordY(index)}`;
}

// One history row: newest first, so the recent placements are visible without
// scrolling.
function historyRow(index, player, i) {
  const x = coordX(index);
  const y = coordY(index);

  const row = document.createElement("li");
  row.title = `Move ${i + 1}: ${playerName(player)} at x ${x}, y ${y}`;

  const dot = document.createElement("span");
  dot.classList.add("score-dot");
  if (isCross(player)) {
    dot.classList.add("cross");
  }
  dot.style.setProperty("--dot", colorOf(player));

  const name = document.createElement("span");
  name.className = "history-name";
  name.textContent = playerName(player);

  const coord = document.createElement("span");
  coord.className = "history-coord";
  coord.textContent = `${x}, ${y}`;

  row.append(dot, name, coord);
  return row;
}

function historyMoreRow(earlier) {
  const more = document.createElement("li");
  more.className = "history-more";
  more.textContent = `${earlier} earlier moves`;
  return more;
}

// Keep the newest HISTORY_ROWS rows plus the "earlier moves" tail.
function trimHistory(total) {
  const children = historyList.children;
  let count = children.length;
  while (count > HISTORY_ROWS) {
    children[count - 1].remove();
    count -= 1;
  }

  const earlier = total - Math.min(total, HISTORY_ROWS);
  const last = count > 0 ? children[count - 1] : undefined;
  if (earlier === 0) {
    if (last !== undefined && last.className === "history-more") {
      last.remove();
    }
    return;
  }
  if (last !== undefined && last.className === "history-more") {
    last.textContent = `${earlier} earlier moves`;
  } else {
    historyList.append(historyMoreRow(earlier));
  }
}

let renderedHistoryCount = 0;
let renderedHistoryRevision = -1;

function renderHistory() {
  const moves = state.historyLength;
  // One new move appends one row; rebuild only when the list changed shape
  // (undo, clear, or a hidden panel catching up on several moves). The length
  // check alone is not enough: a hidden undo followed by a new move keeps the
  // length rising while the rows no longer match.
  if (moves > 0 &&
      moves === renderedHistoryCount + 1 &&
      state.historyRevision === renderedHistoryRevision + 1) {
    const last = moves - 1;
    historyList.prepend(historyRow(
      historyMoveIndex(last), historyMovePlayer(last), last));
    renderedHistoryCount = moves;
    renderedHistoryRevision = state.historyRevision;
    trimHistory(moves);
    return;
  }

  const shown = Math.min(moves, HISTORY_ROWS);
  const rows = new Array(shown + (moves > shown ? 1 : 0));
  let at = 0;
  for (let i = moves - 1; i >= moves - shown; i -= 1) {
    rows[at] = historyRow(historyMoveIndex(i), historyMovePlayer(i), i);
    at += 1;
  }
  if (moves > shown) {
    rows[at] = historyMoreRow(moves - shown);
  }
  historyList.replaceChildren(...rows);
  renderedHistoryCount = moves;
  renderedHistoryRevision = state.historyRevision;
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

// The spacer is a virtual scroll range: it is capped at SCROLL_MAX_CSS, while
// boardCss may be far larger. These helpers map between the two, so the last
// crossing is still reachable on every browser.
function boardSpanX() {
  return Math.max(0, state.boardCss - state.viewCssW);
}

function scrollSpanX() {
  return Math.max(0, state.spacerCssW - state.viewCssW);
}

function boardSpanY() {
  return Math.max(0, state.boardCss + state.hudInsetCss - state.viewCssH);
}

function scrollSpanY() {
  return Math.max(0, state.spacerCssH - state.viewCssH);
}

function boardToScrollX(x) {
  const board = boardSpanX();
  const scroll = scrollSpanX();
  return board > 0 && scroll > 0 ? (x / board) * scroll : 0;
}

function boardToScrollY(y) {
  const board = boardSpanY();
  const scroll = scrollSpanY();
  return board > 0 && scroll > 0
    ? ((y + state.hudInsetCss) / board) * scroll
    : 0;
}

function scrollToBoardX(value) {
  const board = boardSpanX();
  const scroll = scrollSpanX();
  return scroll > 0 ? (value / scroll) * board : 0;
}

function scrollToBoardY(value) {
  const board = boardSpanY();
  const scroll = scrollSpanY();
  return scroll > 0 ? (value / scroll) * board - state.hudInsetCss : 0;
}

// Put a board-space origin at the top-left of the frame, clamped to the
// virtual scroll range.
function scrollToBoardOrigin(x, y) {
  invariant(Number.isFinite(x) && Number.isFinite(y), "bad scroll target");
  const scrollX = boardToScrollX(x);
  const scrollY = boardToScrollY(y);
  boardWrap.scrollLeft = Math.min(scrollSpanX(), Math.max(0, scrollX));
  boardWrap.scrollTop = Math.min(scrollSpanY(), Math.max(0, scrollY));
}

function resize() {
  resizePending = false; // a direct call satisfies a queued resize
  const dpr = Math.min(window.devicePixelRatio || 1, DPR_MAX);
  const rect = boardWrap.getBoundingClientRect();
  // A hidden container can report a zero-size frame. Fall back to a 1px
  // layout instead of throwing, so the game survives being hidden and shown.
  const frameW = Math.max(1, rect.width);
  const frameH = Math.max(1, rect.height);

  // Remember the board point at the frame origin, so a window resize keeps
  // the same slice visible instead of jumping back to the top-left.
  const hadLayout = state.boardPx > 0;
  const prevOriginX = state.dpr > 0 ? state.originX / state.dpr : 0;
  const prevOriginY = state.dpr > 0 ? state.originY / state.dpr : 0;

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

  // The spacer is capped so no browser layout limit is reached. It is
  // invisible and gets pointer-events: none.
  state.boardCss = boardCss;
  state.spacerCssW = Math.min(boardCss, SCROLL_MAX_CSS);
  state.spacerCssH = state.spacerCssW;
  boardSpacer.style.width = `${state.spacerCssW}px`;
  boardSpacer.style.height = `${state.spacerCssH}px`;

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
  state.viewCssW = viewW / dpr;
  state.viewCssH = viewH / dpr;
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
  state.hudInsetCss = state.hudInset / dpr;
  state.spacerCssH = Math.min(boardCss + state.hudInsetCss, SCROLL_MAX_CSS);
  boardSpacer.style.height = `${state.spacerCssH}px`;

  invariant(state.spacing > 0, "board spacing must be positive");
  invariant(state.boardPx > 2 * state.pad, "board wider than its margin");
  state.territoryDirty = true;
  state.boardDirty = true;
  // Keep the current slice on a window resize; only a fresh game resets it
  // (startGame re-centres the board on 0, 0). Layout does not affect
  // ownership, so the cached analysis stays valid.
  if (hadLayout) {
    scrollToBoardOrigin(prevOriginX, prevOriginY);
  }
  updateOrigin();
  frameCache = null; // canvas size or page position may have changed
  hoverDirty = true;
  draw();
}

// Recompute which slice of the board the frame shows and keep the canvas
// pinned to the frame while the virtual spacer scrolls underneath it.
function updateOrigin() {
  const { dpr, boardPx, viewW, viewH, hudBand, hudInset } = state;

  if (boardPx <= viewW) {
    state.originX = (boardPx - viewW) / 2; // centre a board that fits
  } else {
    state.originX = scrollToBoardX(boardWrap.scrollLeft) * dpr;
  }

  const band = Math.min(hudBand, viewH / 4);
  if (hudInset === 0 && boardPx <= viewH - band * 2) {
    // Board top sits half the spare space below the HUD band.
    state.originY = (boardPx - (viewH - band * 2)) / 2 - band;
  } else if (hudInset === 0 && boardPx <= viewH) {
    state.originY = (boardPx - viewH) / 2;
  } else {
    state.originY = scrollToBoardY(boardWrap.scrollTop) * dpr;
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

// Coordinate text is nine characters at the 94M cap ("-47,000,000") but only
// two on a small board. Size the fields to the current board so the pill stays
// compact without ever clipping a digit. The CSS width is the fallback.
function fitCoordFields(center, dim) {
  const widest = Math.max(String(-center).length,
    String(dim - 1 - center).length);
  const width = `${Math.max(3, widest) + 0.5}ch`;
  coordXInput.style.width = width;
  coordYInput.style.width = width;
}

function updateCoord() {
  if (coordFocused) {
    return; // leave the field being typed in alone
  }
  syncCoordFields();
}

// ---- drawing ---------------------------------------------------------

// Stones are circles for the first colour set and plus signs for the
// second, so two players can share a colour and still be told apart.
function drawStone(target, x, y, radius, color, alpha, player) {
  const cx = state.pad + x * state.spacing - state.originX;
  const cy = state.pad + y * state.spacing - state.originY;

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
// instead of the whole board, which is what keeps a 94,000,000x94,000,000
// board cheap.
function visibleCells() {
  const { originX, originY, viewW, viewH, pad, spacing, dim } = state;
  visibleRange.x0 = Math.max(0, Math.floor((originX - pad) / spacing) - 1);
  visibleRange.x1 = Math.min(dim - 1,
    Math.ceil((originX + viewW - pad) / spacing) + 1);
  visibleRange.y0 = Math.max(0, Math.floor((originY - pad) / spacing) - 1);
  visibleRange.y1 = Math.min(dim - 1,
    Math.ceil((originY + viewH - pad) / spacing) + 1);
  return visibleRange;
}

// Copy the visible slice's owner and stone ids into small flat buffers once
// per composed frame. Every draw pass then reads an array, like the old dense
// grid, instead of doing a map lookup and binary search per corner.
// Reused visible-slice buffers: two Int8Arrays the size of the frame, cleared
// and refilled each composition instead of reallocated. The range and view
// records are reused too; both live only for the current composed frame.
const visibleRange = { x0: 0, x1: 0, y0: 0, y1: 0 };
const visibleView = {
  x0: 0,
  y0: 0,
  w: 0,
  h: 0,
  owner: null,
  stone: null,
};
let viewOwner = new Int8Array(0);
let viewStone = new Int8Array(0);

function visibleWindow() {
  const range = visibleCells();
  const w = range.x1 - range.x0 + 1;
  const h = range.y1 - range.y0 + 1;
  const cells = w * h;
  if (viewOwner.length < cells) {
    viewOwner = new Int8Array(cells);
    viewStone = new Int8Array(cells);
  }
  const owner = viewOwner;
  const stone = viewStone;
  owner.fill(0, 0, cells);
  stone.fill(0, 0, cells);
  const { ownerBands } = analyse();

  for (let y = range.y0; y <= range.y1; y += 1) {
    const base = (y - range.y0) * w;
    const band = bandAt(ownerBands, y);
    if (band !== null) {
      const runs = band.runs;
      for (let i = 0; i < runs.length; i += 1) {
        const run = runs[i];
        const a = Math.max(run[0], range.x0);
        const b = Math.min(run[1], range.x1);
        if (a <= b) {
          owner.fill(run[2], base + a - range.x0, base + b - range.x0 + 1);
        }
      }
    }

    const row = state.rows.get(y);
    if (row !== undefined) {
      let i = lowerBound(row, range.x0);
      for (; i < row.n && row.xs[i] <= range.x1; i += 1) {
        stone[base + row.xs[i] - range.x0] = row.players[i];
      }
    }
  }

  visibleView.x0 = range.x0;
  visibleView.y0 = range.y0;
  visibleView.w = w;
  visibleView.h = h;
  visibleView.owner = owner;
  visibleView.stone = stone;
  return visibleView;
}

function drawGrid(target, lineWidth) {
  const { pad, spacing, originX, originY, viewW, viewH, dim } = state;
  const boardEnd = pad + spacing * (dim - 1);
  // Grid lines are drawn in frame space, clamped to the canvas. This keeps
  // every canvas coordinate small even when the board itself is 32M px wide.
  const left = Math.max(0, pad - originX);
  const right = Math.min(viewW, boardEnd - originX);
  const top = Math.max(0, pad - originY);
  const bottom = Math.min(viewH, boardEnd - originY);

  const cx0 = Math.max(0, Math.floor((originX - pad) / spacing));
  const cx1 = Math.min(dim - 1, Math.ceil((originX + viewW - pad) / spacing));
  const cy0 = Math.max(0, Math.floor((originY - pad) / spacing));
  const cy1 = Math.min(dim - 1, Math.ceil((originY + viewH - pad) / spacing));

  target.strokeStyle = COLOR_LINE;
  target.lineWidth = lineWidth;
  target.beginPath();

  for (let i = cx0; i <= cx1; i += 1) {
    const p = crisp(pad + i * spacing - originX, lineWidth);
    target.moveTo(p, top);
    target.lineTo(p, bottom);
  }
  for (let i = cy0; i <= cy1; i += 1) {
    const p = crisp(pad + i * spacing - originY, lineWidth);
    target.moveTo(left, p);
    target.lineTo(right, p);
  }

  target.stroke();
}

// One segment per same-colour neighbouring pair, drawn under the stones.
// Only visible crossings are queried, so this stays bounded by the frame.
// Reused per-frame Path2D slot arrays. A Path2D cannot be reset, so each frame
// builds fresh paths but allocates no arrays.
const linkPaths = new Array(MAX_PLAYERS + 1).fill(null);

function drawLinks(target, view) {
  invariant(state.spacing > 0, "link pass before layout");
  invariant(view.w > 0 && view.h > 0, "empty visible window");

  const { pad, spacing } = state;
  const dim = state.dim;
  const last = dim - 1;
  const paths = linkPaths;
  paths.fill(null, 0, state.playerCount + 1);
  const w = view.w;
  const xLast = view.x0 + w - 1;
  const yLast = view.y0 + view.h - 1;

  for (let y = view.y0; y <= yLast; y += 1) {
    const rowBase = (y - view.y0) * w - view.x0;
    for (let x = view.x0; x <= xLast; x += 1) {
      const player = view.stone[rowBase + x];
      if (player === 0) {
        continue;
      }

      const x0 = pad + x * spacing - state.originX;
      const y0 = pad + y * spacing - state.originY;

      for (let d = 0; d < 4; d += 1) {
        const nx = x + LINK_DX[d];
        const ny = y + LINK_DY[d];
        if (nx < 0 || nx > last || ny < 0 || ny > last) {
          continue;
        }
        if (nx < view.x0 || nx > xLast || ny < view.y0 || ny > yLast) {
          continue; // just outside the composed slice, so off screen
        }
        if (view.stone[rowBase + (ny - y) * w + nx] !== player) {
          continue;
        }

        let path = paths[player];
        if (path === null) {
          path = new Path2D();
          paths[player] = path;
        }
        path.moveTo(x0, y0);
        path.lineTo(pad + nx * spacing - state.originX,
          pad + ny * spacing - state.originY);
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
function drawTerritory(target, view) {
  invariant(state.viewW > 0, "territory pass before layout");
  invariant(view.w > 0 && view.h > 0, "empty visible window");
  const scores = analyse().scores; // build or reuse the owner bands

  if (state.territoryDirty) {
    state.territoryDirty = false;
    scoresStale = true;
    updateLeader(scores); // header is visible even when the panel is folded
  }

  drawTerritoryFaces(target, view);
}

function drawTerritoryFaces(target, view) {
  invariant(state.viewW > 0, "territory pass before layout");
  invariant(state.spacing > 0, "territory before layout");
  invariant(state.dim >= 2, "board too small for faces");

  drawFullFaces(target, view);
  drawSplitFaces(target, view);
}

// Faces that no wall line cuts: every corner is a stone or owned crossing.
// Adjacent faces are merged into horizontal runs, so a straight wall becomes
// one solid rectangle out to the wall line.
function drawFullFaces(target, view) {
  invariant(state.spacing > 0, "faces before layout");
  invariant(state.dim >= 2, "board too small for faces");
  invariant(view.w > 1 && view.h > 1, "visible window too small for faces");

  const { pad, spacing, dim } = state;
  const bleed = 1; // device pixel of overlap hides antialias seams
  const w = view.w;
  const xLast = view.x0 + w - 1;
  const yLast = view.y0 + view.h - 1;

  // Face (x, y) spans crossings (x, y) to (x + 1, y + 1).
  const x0 = Math.max(0, view.x0);
  const x1 = Math.min(dim - 2, xLast - 1);
  const y0 = Math.max(0, view.y0);
  const y1 = Math.min(dim - 2, yLast - 1);

  for (let y = y0; y <= y1; y += 1) {
    const rowBase = (y - view.y0) * w - view.x0;
    let runPlayer = 0;
    let runStart = 0;

    for (let x = x0; x <= x1 + 1; x += 1) {
      let player = 0;
      if (x <= x1) {
        const i = rowBase + x;
        const a = view.owner[i];
        const b = view.owner[i + 1];
        const c = view.owner[i + w];
        const d = view.owner[i + w + 1];
        const stoneA = view.stone[i] !== 0;
        const stoneB = view.stone[i + 1] !== 0;
        const stoneC = view.stone[i + w] !== 0;
        const stoneD = view.stone[i + w + 1] !== 0;
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
          pad + runStart * spacing - state.originX,
          pad + y * spacing - state.originY,
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
//
// Paths are cached per player and rebuilt each frame (a Path2D cannot be
// reset), while the arrays are reused so a frame allocates no array.
const splitPaths = new Array(MAX_PLAYERS + 1).fill(null);
const stoneCircles = new Array(MAX_PLAYERS + 1).fill(null);
const stoneCrosses = new Array(MAX_PLAYERS + 1).fill(null);

function paintHalf(paths, corner, player, bx, by, spacing) {
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

function drawSplitFaces(target, view) {
  invariant(state.spacing > 0, "split faces before layout");
  invariant(state.dim >= 2, "board too small for faces");
  invariant(view.w > 1 && view.h > 1, "visible window too small for faces");

  const { pad, spacing, dim, playerCount } = state;
  const w = view.w;
  const xLast = view.x0 + w - 1;
  const yLast = view.y0 + view.h - 1;

  const x0 = Math.max(0, view.x0);
  const x1 = Math.min(dim - 2, xLast - 1);
  const y0 = Math.max(0, view.y0);
  const y1 = Math.min(dim - 2, yLast - 1);

  const paths = splitPaths;
  paths.fill(null, 0, playerCount + 1);

  for (let y = y0; y <= y1; y += 1) {
    const rowBase = (y - view.y0) * w - view.x0;
    for (let x = x0; x <= x1; x += 1) {
      const i = rowBase + x;
      const a = view.owner[i];
      const b = view.owner[i + 1];
      const c = view.owner[i + w];
      const d = view.owner[i + w + 1];
      const stoneA = view.stone[i] !== 0;
      const stoneB = view.stone[i + 1] !== 0;
      const stoneC = view.stone[i + w] !== 0;
      const stoneD = view.stone[i + w + 1] !== 0;

      const bx = pad + x * spacing - state.originX;
      const by = pad + y * spacing - state.originY;

      if (stoneB && stoneC) {
        if (a !== 0) {
          paintHalf(paths, 0, a, bx, by, spacing);
        }
        if (d !== 0) {
          paintHalf(paths, 3, d, bx, by, spacing);
        }
      }
      if (stoneA && stoneD) {
        if (b !== 0) {
          paintHalf(paths, 1, b, bx, by, spacing);
        }
        if (c !== 0) {
          paintHalf(paths, 2, c, bx, by, spacing);
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
function drawStones(target, view) {
  invariant(view.w > 0 && view.h > 0, "empty visible window");
  const radius = state.spacing * DOT_RADIUS_RATIO;
  const outline = Math.max(1, radius * 0.09);
  const circles = stoneCircles;
  const crosses = stoneCrosses;
  circles.fill(null, 0, state.playerCount + 1);
  crosses.fill(null, 0, state.playerCount + 1);
  const w = view.w;
  const xLast = view.x0 + w - 1;
  const yLast = view.y0 + view.h - 1;

  for (let y = view.y0; y <= yLast; y += 1) {
    const rowBase = (y - view.y0) * w - view.x0;
    const cy = state.pad + y * state.spacing - state.originY;
    for (let x = view.x0; x <= xLast; x += 1) {
      const player = view.stone[rowBase + x];
      if (player === 0) {
        continue;
      }

      const cx = state.pad + x * state.spacing - state.originX;

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

  // Clear in frame space; every draw pass works in frame space too, so a
  // 32M px board never becomes a large canvas coordinate.
  boardCtx.setTransform(1, 0, 0, 1, 0, 0);
  boardCtx.clearRect(0, 0, state.viewW, state.viewH);

  drawGrid(boardCtx, lineWidth);
  const view = visibleWindow();
  drawTerritory(boardCtx, view);
  drawLinks(boardCtx, view);
  drawStones(boardCtx, view);
}

function isPlaceable(point) {
  return stoneAt(point.x, point.y) === 0 && !isBlocked(point);
}

function drawGhost(target, point) {
  if (!isPlaceable(point)) {
    return;
  }

  const radius = state.spacing * DOT_RADIUS_RATIO;
  drawStone(target, point.x, point.y, radius, colorOf(state.turn), 0.35,
    state.turn);
}

// The cursor is a ghost stone on a legal crossing, and a ring only on a
// sealed empty one, so a blocked crossing still shows where it is. A
// crossing holding a stone is its own marker, so nothing is stacked on it.
function drawCursor(target, point) {
  if (stoneAt(point.x, point.y) !== 0) {
    return;
  }
  if (isPlaceable(point)) {
    drawGhost(target, point);
    return;
  }

  const radius = state.spacing * DOT_RADIUS_RATIO;
  const cx = state.pad + point.x * state.spacing - state.originX;
  const cy = state.pad + point.y * state.spacing - state.originY;

  target.save();
  target.beginPath();
  target.arc(cx, cy, radius * 1.4, 0, Math.PI * 2);
  target.lineWidth = Math.max(2, state.spacing * 0.05);
  target.strokeStyle = colorOf(state.turn);
  target.stroke();
  target.restore();
}

// Compose one ghost or cursor on the small scratch canvas, then blit it where
// it belongs. The marker fits in 1.8 cells; anything outside that is clipped
// by the scratch canvas.
function drawOverlay(point, cursor) {
  const size = Math.max(8, Math.ceil(state.spacing * 1.8));
  if (ghostLayer.width !== size || ghostLayer.height !== size) {
    ghostLayer.width = size;
    ghostLayer.height = size;
  }

  const cx = state.pad + point.x * state.spacing - state.originX;
  const cy = state.pad + point.y * state.spacing - state.originY;

  ghostCtx.setTransform(1, 0, 0, 1, 0, 0);
  ghostCtx.clearRect(0, 0, size, size);
  ghostCtx.setTransform(1, 0, 0, 1, size / 2 - cx, size / 2 - cy);
  if (cursor) {
    drawCursor(ghostCtx, point);
  } else {
    drawGhost(ghostCtx, point);
  }
  ghostCtx.setTransform(1, 0, 0, 1, 0, 0);

  ctx.drawImage(ghostLayer, Math.round(cx - size / 2),
    Math.round(cy - size / 2));
}

let renderedTurn = 0; // last turn whose status text was written to the DOM
let renderedMoves = -1; // last move count whose button state was written
let renderedHistory = -1; // last history revision painted into the panel
let pendingDraw = 0;
let resizePending = false;

// Pointer moves can fire several times per frame. Coalesce them into one
// repaint; scroll and stone changes still draw immediately.
function onAnimationFrame() {
  pendingDraw = 0;
  if (resizePending) {
    resizePending = false;
    resize(); // lays out and draws
    return;
  }
  draw();
}

function scheduleDraw() {
  if (pendingDraw !== 0) {
    return;
  }
  pendingDraw = requestAnimationFrame(onAnimationFrame);
}

// A window drag fires resize far faster than the display can paint. Defer the
// layout reads and canvas realloc to the next frame, like pointer moves.
function scheduleResize() {
  resizePending = true;
  scheduleDraw();
}

function draw() {
  invariant(state.spacing > 0, "draw called before layout");

  if (scrollDirty) {
    scrollDirty = false;
    updateOrigin(); // one DOM read per frame, not per scroll event
  }
  resolveHover();
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
    drawOverlay(state.hover, false);
  }
  if (state.cursor !== null) {
    drawOverlay(state.cursor, true);
  }

  const moves = state.historyLength;
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
    updateHistoryLine();
    historyStale = true;
  }
  updateCoord();
  flushPanels();
}

// ---- input -----------------------------------------------------------

// Pointer position in board device pixels: canvas-local, plus the slice
// origin so a scrolled board maps clicks to the right crossings. Writes into
// `out` so the per-frame pick allocates nothing.
function pointAt(clientX, clientY, out) {
  const frame = canvasFrame();
  invariant(frame !== null, "board has zero width");
  out.x = (clientX - frame.left) * frame.scale + state.originX;
  out.y = (clientY - frame.top) * frame.scale + state.originY;
  return out;
}

// Canvas rect and backing-store scale, cached until the next layout. Pointer
// moves fire several times per frame, and getBoundingClientRect() forces a
// layout, so reading it per event is the expensive part of a hover. Returns
// null while the canvas has no width (hidden container).
let frameCache = null;

function canvasFrame() {
  if (frameCache === null) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0) {
      return null;
    }
    frameCache = {
      left: rect.left,
      top: rect.top,
      scale: canvas.width / rect.width,
    };
  }
  return frameCache;
}

// Nearest crossing to a point, or null when the point is off the board.
// Snaps within half a cell, so a click between crossings still lands on the
// closest one instead of doing nothing. Writes into `out` when it hits.
function intersectionAt(point, out) {
  const { pad, spacing, dim } = state;

  const gx = Math.round((point.x - pad) / spacing);
  const gy = Math.round((point.y - pad) / spacing);

  if (gx < 0 || gx >= dim || gy < 0 || gy >= dim) {
    return null;
  }

  out.x = gx;
  out.y = gy;
  return out;
}

// Last mouse position in client px, so scrolling or a resize can remap the
// ghost without waiting for another pointermove. `hasPointer` is false while
// off the board. Two plain numbers, so a pointermove allocates nothing.
let hasPointer = false;
let lastClientX = 0;
let lastClientY = 0;
// Set when the pointer, the scroll offset, or the layout moved. draw() resolves
// the hover once, so idle frames do no hit-testing at all.
let hoverDirty = false;
let scrollDirty = false;

// Scratch for the per-frame pick. Reused because the result is retained as
// state.hover/state.cursor; both always point at the last resolved crossing.
const pickPoint = { x: 0, y: 0 };
const hoverPoint = { x: 0, y: 0 };

// Re-resolve the pointer against the board after its origin moved, or after a
// coalesced pointermove. Called once per draw, never per event.
function resolveHover() {
  if (!hoverDirty) {
    return;
  }
  hoverDirty = false;
  if (!hasPointer) {
    return;
  }

  const frame = canvasFrame();
  if (frame === null || frame.scale <= 0 ||
      state.viewW <= 0 || state.viewH <= 0) {
    return; // hidden frame
  }

  const hit = intersectionAt(pointAt(lastClientX, lastClientY, pickPoint),
    hoverPoint);
  state.hover = hit;
  if (hit !== null) {
    state.cursor = hit;
  }
  const cursor = hit !== null && isBlocked(hit) ? "not-allowed" : "crosshair";
  if (cursor !== renderedCursor) {
    renderedCursor = cursor;
    canvas.style.cursor = cursor;
  }
}

let renderedCursor = "";

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
  const width = state.viewCssW;
  const height = state.viewCssH;
  const hud = Math.min(state.hudBand / state.dpr, height / 4);
  const x = (state.pad + state.cursor.x * state.spacing) / state.dpr;
  const y = (state.pad + state.cursor.y * state.spacing) / state.dpr;

  let originX = scrollToBoardX(boardWrap.scrollLeft);
  let originY = scrollToBoardY(boardWrap.scrollTop);

  if (x < originX + margin) {
    originX = x - margin;
  } else if (x > originX + width - margin) {
    originX = x - width + margin;
  }

  if (y < originY + hud + margin) {
    originY = y - hud - margin;
  } else if (y > originY + height - margin) {
    originY = y - height + margin;
  }

  scrollToBoardOrigin(originX, originY);
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
  const y = (state.pad + state.cursor.y * state.spacing - state.viewH / 2) /
    state.dpr;

  scrollToBoardOrigin(x, y);
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
  hasPointer = false;
  centerOnCursor();
  syncCoordFields(true);
}

function moveCursor(dx, dy) {
  ensureCursor();
  state.hover = null; // keyboard takes over from the pointer ghost
  hasPointer = false;
  const last = state.dim - 1;
  state.cursor = {
    x: Math.min(last, Math.max(0, state.cursor.x + dx)),
    y: Math.min(last, Math.max(0, state.cursor.y + dy)),
  };
  revealCursor();
}

function panBoard(dx, dy) {
  hasPointer = false;
  const step = (state.spacing / state.dpr) * ARROW_STEP_CELLS;
  const boardX = boardSpanX();
  const boardY = boardSpanY();
  const scaleX = boardX > 0 ? scrollSpanX() / boardX : 0;
  const scaleY = boardY > 0 ? scrollSpanY() / boardY : 0;
  boardWrap.scrollLeft = Math.min(scrollSpanX(), Math.max(0,
    boardWrap.scrollLeft + dx * step * scaleX));
  boardWrap.scrollTop = Math.min(scrollSpanY(), Math.max(0,
    boardWrap.scrollTop + dy * step * scaleY));
}

function placeAtCursor() {
  ensureCursor();
  invariant(state.cursor !== null, "cursor not set");

  const point = state.cursor;
  if (stoneAt(point.x, point.y) !== 0 || isBlocked(point)) {
    return;
  }
  place(point);
  revealCursor();
}

// ---- moves -----------------------------------------------------------

// Add a stone to the sparse row index and update its player's wall state.
function setStone(index, player) {
  invariant(player >= 1 && player <= MAX_PLAYERS, "bad stone player");

  const x = cellX(index);
  const y = cellY(index);
  // insertStone rejects a duplicate crossing; repeating the row lookup here
  // would double the per-stone search on mass restore.
  const node = insertStone(x, y, player);
  dirtyBandsAt(x, y);
  state.stoneCounts[player] += 1;
  state.stoneTotal += 1;
  growPlayerBox(player, x, y);
  // Only a cycle can seal a new region. A dangling wall leaves the player's
  // reachable set exact as cached, so the flood can be skipped.
  const wall = connectWall(index, player, node);
  state.lastCycleRoot = -1;
  state.lastCycleBox = null;
  if (wall.cycle) {
    state.playerDirty[player] = 1;
    state.lastCycleRoot = wall.root;
    state.lastCycleBox = wall.cycleBox;
  }
  state.analysis = null;
  state.territoryDirty = true;
}

// Remove a stone from its row. Returns the player that owned it. A mass
// capture goes through removeStones instead.
function removeStone(index) {
  const x = cellX(index);
  const y = cellY(index);
  // eraseStone rejects a missing crossing, so no second row lookup here.
  const { player, node } = eraseStone(x, y);
  state.stoneCounts[player] -= 1;
  state.stoneTotal -= 1;
  invariant(state.stoneCounts[player] >= 0, "negative stone count");
  // Removing one stone can only shrink that component's sealed set. Drop its
  // cache; every other component's flood is independent of this stone.
  const sealedCache = state.componentSealed[player];
  const root = state.wallParent[node] === node ? node : wallRootOf(node);
  if (sealedCache.size !== 0) {
    sealedCache.delete(root);
  }
  // An isolated root has no children and no live stone in its component, so
  // its id can be reused at once. Nodes inside a larger component stay until
  // sweepWalls proves that no live chain reaches them.
  if (root === node && state.wallSize[node] === 1) {
    state.wallParent[node] = 0;
    state.wallSize[node] = 0;
    const at = node * 4;
    state.wallBox[at] = 0;
    state.wallBox[at + 1] = 0;
    state.wallBox[at + 2] = 0;
    state.wallBox[at + 3] = 0;
    state.wallCycle[node] = 0;
    state.wallRootPlayer[node] = 0;
    state.wallEntries -= 1;
    pushFreeWallNode(node);
  }
  if (wallsAreStale()) {
    compactWalls();
  }
  shrinkPlayerBox(player, x, y);
  state.playerDirty[player] = 1; // its walls changed too
  state.playerSealedStale[player] = 1; // a removal may have opened a region
  state.analysis = null;
  state.territoryDirty = true;
  return player;
}

// Remove many stones with one row rebuild each. A capture can remove a whole
// sealed region, so splicing each stone would move its row arrays once per
// victim. Grouping the removals by row keeps each row's arrays allocated once.
// Per-stone bookkeeping matches removeStone; the stale-wall check runs once for
// the whole batch.
function removeStones(stones) {
  invariant(Array.isArray(stones), "batch of stones must be an array");
  const count = stones.length;
  if (count === 0) {
    return;
  }
  for (let i = 0; i < count; i += 1) {
    const stone = stones[i];
    invariant(Number.isInteger(stone.index) && stone.index >= 0,
      "bad batch stone index");
    invariant(stone.player >= 1 && stone.player <= MAX_PLAYERS,
      "bad batch stone player");
  }

  // Row-major index order groups every row, and sorts each row's x positions,
  // so one forward merge can drop the marked entries. A single flood already
  // collects trapped stones in that order, so only an unordered multi-component
  // result pays the sort.
  let sorted = true;
  for (let i = 1; i < count; i += 1) {
    if (stones[i - 1].index > stones[i].index) {
      sorted = false;
      break;
    }
  }
  if (!sorted) {
    stones.sort((left, right) => left.index - right.index);
  }
  const dim = state.dim;
  const rows = state.rows;
  let i = 0;
  while (i < count) {
    const first = stones[i].index;
    const y = (first - (first % dim)) / dim;
    const row = rows.get(y);
    invariant(row !== undefined, "batch stone row missing");
    const xs = row.xs;
    const players = row.players;
    const nodes = row.nodes;
    const rowCount = row.n;
    let read = 0;
    let write = 0;

    while (i < count && stones[i].index < (y + 1) * dim) {
      const index = stones[i].index;
      const x = index % dim;
      while (read < rowCount && xs[read] < x) {
        if (write !== read) {
          xs[write] = xs[read];
          players[write] = players[read];
          nodes[write] = nodes[read];
        }
        write += 1;
        read += 1;
      }
      invariant(read < rowCount && xs[read] === x,
        "batch stone not in row");
      const player = players[read];
      const node = nodes[read];
      invariant(player === stones[i].player, "batch stone player mismatch");
      state.stoneCounts[player] -= 1;
      invariant(state.stoneCounts[player] >= 0, "negative stone count");
      state.stoneTotal -= 1;
      const sealedCache = state.componentSealed[player];
      if (sealedCache.size !== 0) {
        sealedCache.delete(wallRootOf(node));
      }
      shrinkPlayerBox(player, x, y);
      state.playerDirty[player] = 1; // its walls changed too
      state.playerSealedStale[player] = 1; // it may have opened a region
      read += 1;
      i += 1;
    }

    while (read < rowCount) {
      if (write !== read) {
        xs[write] = xs[read];
        players[write] = players[read];
        nodes[write] = nodes[read];
      }
      write += 1;
      read += 1;
    }
    if (!Array.isArray(xs)) {
      row.n = write;
    } else {
      xs.length = write;
      players.length = write;
      nodes.length = write;
      row.n = write;
    }
    if (write === 0) {
      rows.delete(y);
    }
  }

  state.analysis = null;
  state.territoryDirty = true;
  if (wallsAreStale()) {
    compactWalls();
  }
}

// Restore many captured stones with one row merge each. Undo used to call
// setStone once per victim, and every call spliced its row's parallel arrays.
// Grouping by row lets one merge place every stone in that row, which is the
// same trade removeStones makes for capture. Wall nodes are still fresh per
// insertion, and connectWall still runs per stone because each stone can close
// a cycle; only the row splicing and repeated band scans are batched.
function restoreStones(stones) {
  invariant(Array.isArray(stones), "batch of stones must be an array");
  const count = stones.length;
  if (count === 0) {
    return;
  }
  for (let i = 0; i < count; i += 1) {
    const stone = stones[i];
    invariant(Number.isInteger(stone.index) && stone.index >= 0,
      "bad batch stone index");
    invariant(stone.player >= 1 && stone.player <= MAX_PLAYERS,
      "bad batch stone player");
  }

  let sorted = true;
  for (let i = 1; i < count; i += 1) {
    if (stones[i - 1].index > stones[i].index) {
      sorted = false;
      break;
    }
  }
  if (!sorted) {
    stones.sort((left, right) => left.index - right.index);
  }

  const dim = state.dim;
  const rows = state.rows;
  // Restored nodes come from the free list first, then from fresh ids. Free
  // ids are only published after cleanup proved no live chain reaches them,
  // so reuse cannot attach a restored stone to an old wall. `localNodes[k]`
  // is the node id used by stones[k].
  const reused = Math.min(freeWallCount, count);
  const localNodes = new Int32Array(count);
  for (let k = 0; k < reused; k += 1) {
    localNodes[k] = popFreeWallNode();
  }
  if (reused < count) {
    const base = nextWallNode;
    nextWallNode += count - reused;
    invariant(nextWallNode - 1 < 0xffffffff, "wall node id overflow");
    for (let k = reused; k < count; k += 1) {
      localNodes[k] = base + (k - reused);
    }
  }
  ensureWallCapacity(nextWallNode - 1);
  const parent = state.wallParent;
  const sizes = state.wallSize;
  const boxes = state.wallBox;
  const cycles = state.wallCycle;
  const rootPlayers = state.wallRootPlayer;
  // The high bit marks a node inside this restore batch. Player ids are below
  // 128, so the marker cannot collide with a live root's player.
  const RESTORED = 0x80;
  for (let k = 0; k < count; k += 1) {
    const index = stones[k].index;
    const x = index % dim;
    const y = (index - x) / dim;
    const node = localNodes[k];
    parent[node] = node;
    sizes[node] = 1;
    boxes[node * 4] = x;
    boxes[node * 4 + 1] = x;
    boxes[node * 4 + 2] = y;
    boxes[node * 4 + 3] = y;
    cycles[node] = 0;
    rootPlayers[node] = stones[k].player | RESTORED;
  }

  const affectedRows = [];
  let i = 0;
  while (i < count) {
    const first = stones[i].index;
    const y = (first - (first % dim)) / dim;
    const rowEnd = (y + 1) * dim;
    let end = i + 1;
    while (end < count && stones[end].index < rowEnd) {
      end += 1;
    }
    affectedRows.push(y);
    const added = end - i;
    const row = rows.get(y);
    const oldXs = row === undefined ? null : row.xs;
    const oldPlayers = row === undefined ? null : row.players;
    const oldNodes = row === undefined ? null : row.nodes;
    const oldCount = row === undefined ? 0 : row.n;
    const capacity = oldCount + added;
    const typed = capacity >= ROW_TYPED_MIN;
    const xs = typed ? new Uint32Array(capacity) : new Array(capacity);
    const players = typed ? new Uint8Array(capacity) : new Array(capacity);
    const nodes = typed ? new Uint32Array(capacity) : new Array(capacity);
    let read = 0;
    let write = 0;

    for (; i < end; i += 1) {
      const stone = stones[i];
      const x = stone.index % dim;
      while (read < oldCount && oldXs[read] < x) {
        xs[write] = oldXs[read];
        players[write] = oldPlayers[read];
        nodes[write] = oldNodes[read];
        read += 1;
        write += 1;
      }
      invariant(read >= oldCount || oldXs[read] !== x,
        "batch restore duplicates a stone");
      const player = stone.player;
      const node = localNodes[i];
      xs[write] = x;
      players[write] = player;
      nodes[write] = node;
      write += 1;
      state.stoneCounts[player] += 1;
      state.stoneTotal += 1;
      growPlayerBox(player, x, y);
      dirtyBandsAt(x, y);
    }
    while (read < oldCount) {
      xs[write] = oldXs[read];
      players[write] = oldPlayers[read];
      nodes[write] = oldNodes[read];
      read += 1;
      write += 1;
    }
    if (!typed) {
      xs.length = write;
      players.length = write;
      nodes.length = write;
    }
    rows.set(y, { xs, players, nodes, n: write });
  }

  // Local union-find over just the restored stones, stored directly in the
  // global wall arrays. Restoring a captured interior used to call connectWall
  // per stone, and every call paid several Map lookups on the global
  // union-find. Adjacent restored stones are unioned here; only edges to
  // stones that were already live touch an old component.
  function localRoot(node) {
    let root = node;
    while (parent[root] !== root) {
      parent[root] = parent[parent[root]];
      root = parent[root];
    }
    return root;
  }

  function unionLocal(a, b) {
    let ra = localRoot(a);
    let rb = localRoot(b);
    if (ra === rb) {
      cycles[ra] = 1;
      return;
    }
    if (sizes[ra] < sizes[rb]) {
      const swap = ra;
      ra = rb;
      rb = swap;
    }
    parent[rb] = ra;
    sizes[ra] += sizes[rb];
    cycles[ra] |= cycles[rb];
    if (boxes[rb * 4] < boxes[ra * 4]) boxes[ra * 4] = boxes[rb * 4];
    if (boxes[rb * 4 + 1] > boxes[ra * 4 + 1]) {
      boxes[ra * 4 + 1] = boxes[rb * 4 + 1];
    }
    if (boxes[rb * 4 + 2] < boxes[ra * 4 + 2]) {
      boxes[ra * 4 + 2] = boxes[rb * 4 + 2];
    }
    if (boxes[rb * 4 + 3] > boxes[ra * 4 + 3]) {
      boxes[ra * 4 + 3] = boxes[rb * 4 + 3];
    }
  }

  const boundaryLocal = [];
  const boundaryExternal = [];
  const boundaryPlayer = [];

  function addEdge(nodeA, playerA, nodeB, playerB) {
    if (playerA !== playerB) {
      return;
    }
    const aRestored = (rootPlayers[nodeA] & RESTORED) !== 0;
    const bRestored = (rootPlayers[nodeB] & RESTORED) !== 0;
    if (!aRestored && !bRestored) {
      return;
    }
    if (aRestored && bRestored) {
      unionLocal(nodeA, nodeB);
    } else if (aRestored) {
      boundaryLocal.push(nodeA);
      boundaryExternal.push(nodeB);
      boundaryPlayer.push(playerA);
    } else {
      boundaryLocal.push(nodeB);
      boundaryExternal.push(nodeA);
      boundaryPlayer.push(playerA);
    }
  }

  // Same-row edges, then vertical/diagonal edges to the next row. Scanning
  // the merged row arrays costs one pass per affected row, not eight lookups
  // per restored stone.
  for (let r = 0; r < affectedRows.length; r += 1) {
    const y = affectedRows[r];
    const row = rows.get(y);
    const xs = row.xs;
    const players = row.players;
    const nodes = row.nodes;
    for (let k = 0; k + 1 < row.n; k += 1) {
      if (xs[k + 1] - xs[k] <= 1) {
        addEdge(nodes[k], players[k], nodes[k + 1], players[k + 1]);
      }
    }
    const below = rows.get(y + 1);
    if (below === undefined) {
      continue;
    }
    const bxs = below.xs;
    const bplayers = below.players;
    const bnodes = below.nodes;
    let j = 0;
    for (let k = 0; k < row.n; k += 1) {
      const x = xs[k];
      while (j < below.n && bxs[j] < x - 1) {
        j += 1;
      }
      for (let m = j; m < below.n && bxs[m] <= x + 1; m += 1) {
        addEdge(nodes[k], players[k], bnodes[m], bplayers[m]);
      }
    }
  }
  // The first restored row also has a live row above it, which the next-row
  // scan never visits.
  const firstY = affectedRows[0];
  const above = rows.get(firstY - 1);
  if (above !== undefined) {
    const firstRow = rows.get(firstY);
    const axs = above.xs;
    const aplayers = above.players;
    const anodes = above.nodes;
    const bxs = firstRow.xs;
    const bplayers = firstRow.players;
    const bnodes = firstRow.nodes;
    let j = 0;
    for (let k = 0; k < above.n; k += 1) {
      const x = axs[k];
      while (j < firstRow.n && bxs[j] < x - 1) {
        j += 1;
      }
      for (let m = j; m < firstRow.n && bxs[m] <= x + 1; m += 1) {
        addEdge(anodes[k], aplayers[k], bnodes[m], bplayers[m]);
      }
    }
  }

  state.wallEntries += count;

  // Attach each restored component to the live components it touches. Most
  // restored components have no boundary at all; a dense captured interior
  // usually has one. Boundary roots are resolved before any merge so the
  // grouping key stays a local root.
  const boundaryRoots = new Int32Array(boundaryLocal.length);
  for (let k = 0; k < boundaryLocal.length; k += 1) {
    boundaryRoots[k] = localRoot(boundaryLocal[k]);
  }
  const attached = new Map();
  for (let k = 0; k < boundaryLocal.length; k += 1) {
    const root = boundaryRoots[k];
    const external = wallRootOf(boundaryExternal[k]);
    const current = attached.get(root);
    if (current === undefined) {
      attached.set(root, external);
    } else if (current === external) {
      markWallCycle(external, boundaryPlayer[k]);
    } else {
      attached.set(root, mergeWallRoots(current, external, boundaryPlayer[k]));
    }
  }

  // Publish one global entry per restored node. Non-roots point at the
  // surviving root and drop their temporary size, box and cycle. A root also
  // clears the restore marker and attaches to any live root it touches.
  for (let k = 0; k < count; k += 1) {
    const node = localNodes[k];
    const root = localRoot(node);
    if (root !== node) {
      parent[node] = root;
      sizes[node] = 0;
      boxes[node * 4] = 0;
      boxes[node * 4 + 1] = 0;
      boxes[node * 4 + 2] = 0;
      boxes[node * 4 + 3] = 0;
      cycles[node] = 0;
      rootPlayers[node] = 0;
      continue;
    }
    const player = stones[k].player;
    const external = attached.get(node);
    const hadCycle = cycles[node] !== 0;
    let finalRoot = node;
    if (external !== undefined) {
      finalRoot = mergeWallRoots(node, external, player);
    }
    if (hadCycle) {
      markWallCycle(finalRoot, player);
    }
    rootPlayers[finalRoot] = player;
  }

  state.lastCycleRoot = -1;
  state.lastCycleBox = null;
  state.analysis = null;
  state.territoryDirty = true;
}

// A move that closed no cycle and captured nothing leaves every enclosure
// exactly as cached.
function anyPlayerDirty() {
  for (let player = 1; player <= state.playerCount; player += 1) {
    if (state.playerDirty[player] !== 0) {
      return true;
    }
  }
  return false;
}

// Undo history lives in typed columns split into fixed-size chunks. A chunked
// column costs at most one partial chunk of slack, while a single doubling
// array could reserve almost twice the live length. Accessors below are the
// only place that translates a live index into chunk + offset.
const HISTORY_CHUNK_SHIFT = 12;
const HISTORY_CHUNK_SIZE = 1 << HISTORY_CHUNK_SHIFT;
const HISTORY_CHUNK_MASK = HISTORY_CHUNK_SIZE - 1;
// 4096^2 = 2^24, the first board side whose largest flat index no longer fits
// in three bytes.
const HISTORY_NARROW_MAX_DIM = 4096;
const EMPTY_HISTORY_REMOVED = Object.freeze([]);

function ensureHistoryMoveChunk(at) {
  const slot = at >>> HISTORY_CHUNK_SHIFT;
  if (state.historyIndex[slot] !== undefined) {
    return slot;
  }
  state.historyIndex[slot] = state.historyIndexNarrow
    ? new Uint8Array(HISTORY_CHUNK_SIZE * 3)
    : new Uint32Array(HISTORY_CHUNK_SIZE);
  state.historyPlayer[slot] = new Uint8Array(HISTORY_CHUNK_SIZE);
  state.historyRemovedStart[slot] = new Uint32Array(HISTORY_CHUNK_SIZE);
  state.historyRemovedCount[slot] = new Uint32Array(HISTORY_CHUNK_SIZE);
  return slot;
}

function ensureHistoryRemovedChunk(at) {
  const slot = at >>> HISTORY_CHUNK_SHIFT;
  if (state.historyRemovedIndex[slot] !== undefined) {
    return slot;
  }
  state.historyRemovedIndex[slot] = new Uint32Array(HISTORY_CHUNK_SIZE);
  state.historyRemovedPlayer[slot] = new Uint8Array(HISTORY_CHUNK_SIZE);
  return slot;
}

function historyMoveIndex(at) {
  const chunk = state.historyIndex[at >>> HISTORY_CHUNK_SHIFT];
  const off = at & HISTORY_CHUNK_MASK;
  if (!state.historyIndexNarrow) {
    return chunk[off];
  }
  const p = off * 3;
  return chunk[p] | (chunk[p + 1] << 8) | (chunk[p + 2] << 16);
}

function setHistoryMoveIndex(at, value) {
  const slot = at >>> HISTORY_CHUNK_SHIFT;
  const off = at & HISTORY_CHUNK_MASK;
  const chunk = state.historyIndex[slot];
  if (!state.historyIndexNarrow) {
    chunk[off] = value;
    return;
  }
  const p = off * 3;
  chunk[p] = value & 0xff;
  chunk[p + 1] = (value >>> 8) & 0xff;
  chunk[p + 2] = (value >>> 16) & 0xff;
}

function historyMovePlayer(at) {
  return state.historyPlayer[at >>> HISTORY_CHUNK_SHIFT][at & HISTORY_CHUNK_MASK];
}

function historyRemovedStartAt(at) {
  return state.historyRemovedStart[at >>> HISTORY_CHUNK_SHIFT][at & HISTORY_CHUNK_MASK];
}

function historyRemovedCountAt(at) {
  return state.historyRemovedCount[at >>> HISTORY_CHUNK_SHIFT][at & HISTORY_CHUNK_MASK];
}

function historyRemovedIndexAt(at) {
  return state.historyRemovedIndex[at >>> HISTORY_CHUNK_SHIFT][at & HISTORY_CHUNK_MASK];
}

function historyRemovedPlayerAt(at) {
  return state.historyRemovedPlayer[at >>> HISTORY_CHUNK_SHIFT][at & HISTORY_CHUNK_MASK];
}

// Undo keeps the chunk high-water mark, exactly like the flat arrays did.
// Trimming trailing chunks on every pop made place/undo churn reallocate a
// 4-chunk block per cycle, which was far more expensive than the memory kept.

// Copy one completed move into the packed columns. The temporary record is
// discarded, so no JS object or removed-stone object survives the call.
function pushHistory(record) {
  const at = state.historyLength;
  const slot = ensureHistoryMoveChunk(at);
  const off = at & HISTORY_CHUNK_MASK;
  const removed = record.removed;
  const count = removed.length;
  const start = state.historyRemovedLength;
  let removedSlot = -1;
  let removedIndex = null;
  let removedPlayer = null;
  for (let i = 0; i < count; i += 1) {
    const pos = start + i;
    const s = pos >>> HISTORY_CHUNK_SHIFT;
    if (s !== removedSlot) {
      removedSlot = ensureHistoryRemovedChunk(pos);
      removedIndex = state.historyRemovedIndex[s];
      removedPlayer = state.historyRemovedPlayer[s];
    }
    const stone = removed[i];
    const o = pos & HISTORY_CHUNK_MASK;
    removedIndex[o] = stone.index;
    removedPlayer[o] = stone.player;
  }
  setHistoryMoveIndex(at, record.index);
  state.historyPlayer[slot][off] = record.player;
  state.historyRemovedStart[slot][off] = start;
  state.historyRemovedCount[slot][off] = count;
  state.historyLength = at + 1;
  state.historyRemovedLength = start + count;
}

// Materialize the last record for undo. Captures are rare and one record at a
// time, so the temporary objects cost less than keeping them for the whole
// game.
function popHistory() {
  const at = state.historyLength - 1;
  if (at < 0) {
    return null;
  }
  const slot = at >>> HISTORY_CHUNK_SHIFT;
  const off = at & HISTORY_CHUNK_MASK;
  const start = state.historyRemovedStart[slot][off];
  const count = state.historyRemovedCount[slot][off];
  let removed = EMPTY_HISTORY_REMOVED;
  if (count > 0) {
    removed = new Array(count);
    let removedSlot = -1;
    let removedIndex = null;
    let removedPlayer = null;
    for (let i = 0; i < count; i += 1) {
      const pos = start + i;
      const s = pos >>> HISTORY_CHUNK_SHIFT;
      if (s !== removedSlot) {
        removedSlot = s;
        removedIndex = state.historyRemovedIndex[s];
        removedPlayer = state.historyRemovedPlayer[s];
      }
      const o = pos & HISTORY_CHUNK_MASK;
      removed[i] = { index: removedIndex[o], player: removedPlayer[o] };
    }
  }
  const record = {
    index: historyMoveIndex(at),
    player: state.historyPlayer[slot][off],
    removed,
  };
  state.historyLength = at;
  state.historyRemovedLength = start;
  return record;
}

function resetHistory() {
  state.historyLength = 0;
  state.historyRemovedLength = 0;
  if (state.historyIndex.length > 0) {
    state.historyIndex = [];
    state.historyPlayer = [];
    state.historyRemovedStart = [];
    state.historyRemovedCount = [];
    state.historyRemovedIndex = [];
    state.historyRemovedPlayer = [];
  }
}

function place(intersection) {
  const index = cellIndex(intersection.x, intersection.y);
  invariant(stoneAt(intersection.x, intersection.y) === 0,
    "stone already placed here");
  invariant(!isBlocked(intersection), "cannot place inside sealed ground");

  // Undo only needs this move: the stone added, the stones it captured.
  const record = { index, player: state.turn, removed: [] };

  const mover = state.turn;
  const cached = state.analysis; // setStone/removeStone drop it
  setStone(index, mover);
  state.turn = nextPlayer(mover);

  // setStone flags the mover when the new stone closes a wall cycle; that
  // flag is consumed again by resolveCaptures, so remember it here to know
  // whether the cached analysis still holds.
  const closedCycle = state.playerDirty[mover] !== 0;
  resolveCaptures(mover, record.removed);
  pushHistory(record);
  state.historyRevision += 1;

  if (closedCycle || record.removed.length > 0 || anyPlayerDirty()) {
    state.analysis = null;
  } else if (cached !== null && !state.ownerDirty) {
    state.analysis = cached; // every enclosure is unchanged
  }
  state.territoryDirty = true;
  state.boardDirty = true;
  draw();
}

function undo() {
  const record = popHistory();
  if (record === null) {
    return;
  }
  state.historyRevision += 1;

  removeStone(record.index);
  restoreStones(record.removed);
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
  state.historyIndexNarrow = dim <= HISTORY_NARROW_MAX_DIM;
  resetHistory();
  state.historyRevision += 1;
  state.turn = 1;
  state.hover = null;
  state.cursor = null;
  resetBoardState();
  state.territoryDirty = true;
  canvas.style.cursor = "";
  renderedCursor = "";
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
  fitCoordFields(center, dim);
  // Start the cursor on the board centre and centre the view on it, so the
  // bottom-left fields read 0, 0.
  state.boardPx = 0; // fresh layout: do not restore the previous game's slice
  hasPointer = false; // no pointer on this fresh game until it moves again
  boardWrap.scrollLeft = 0;
  boardWrap.scrollTop = 0;
  resize(); // lays out, updates the origin, and draws
  state.cursor = { x: center, y: center };
  state.hover = null;
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
    return; // finger drags scroll the frame natively, no ghost
  }

  // A mouse drag pans the board once it passes the click tolerance. The
  // scroll handler coalesces the repaint, so only the scroll writes happen
  // per event. Squared distance avoids Math.hypot.
  if (pressed) {
    const dx = event.clientX - pressX;
    const dy = event.clientY - pressY;
    if (!dragging && dx * dx + dy * dy > DRAG_TOLERANCE_SQ) {
      dragging = true;
      dragX = pressX;
      dragY = pressY;
    }
    if (dragging) {
      boardWrap.scrollLeft -= event.clientX - dragX;
      boardWrap.scrollTop -= event.clientY - dragY;
      dragX = event.clientX;
      dragY = event.clientY;
      hasPointer = false;
      state.hover = null;
      scrollDirty = true;
      state.boardDirty = true;
      scheduleDraw();
      return;
    }
  }

  // Coalesce: draw() resolves the hover once per frame. Hit-testing and
  // writing the cursor style per event would force layout several times a
  // frame for the same result.
  lastClientX = event.clientX;
  lastClientY = event.clientY;
  hasPointer = true;
  hoverDirty = true;
  scheduleDraw();
});

canvas.addEventListener("pointerleave", () => {
  hasPointer = false;
  hoverDirty = false;
  if (state.hover === null) {
    return;
  }
  state.hover = null;
  renderedCursor = "";
  canvas.style.cursor = "";
  scheduleDraw();
});

// Place on release, not press, so dragging still scrolls a big board. All
// press state is plain numbers so an event allocates nothing.
let pressed = false;
let pressX = 0;
let pressY = 0;
let dragging = false;
let dragX = 0;
let dragY = 0;

canvas.addEventListener("pointerdown", (event) => {
  // Only the primary pointer's left button places. Right/middle clicks and
  // extra fingers must not drop a stone.
  if (!event.isPrimary || event.button !== 0) {
    pressed = false;
    dragging = false;
    return;
  }
  pressed = true;
  dragging = false;
  pressX = event.clientX;
  pressY = event.clientY;
  if (event.pointerType === "mouse" && canvas.setPointerCapture) {
    canvas.setPointerCapture(event.pointerId);
  }
});

canvas.addEventListener("pointercancel", () => {
  pressed = false;
  dragging = false;
});

canvas.addEventListener("pointerup", (event) => {
  const wasPressed = pressed;
  const wasDragging = dragging;
  const originX = pressX;
  const originY = pressY;
  pressed = false;
  dragging = false;

  if (!event.isPrimary || event.button !== 0) {
    return;
  }

  if (event.pointerType !== "mouse") {
    state.hover = null;
    hasPointer = false; // do not resurrect the ghost on the next resize
  }

  if (!wasPressed || wasDragging) {
    return; // a drag that returned near its origin is still a drag
  }
  const dx = event.clientX - originX;
  const dy = event.clientY - originY;
  if (dx * dx + dy * dy > DRAG_TOLERANCE_SQ) {
    return;
  }

  const hit = intersectionAt(
    pointAt(event.clientX, event.clientY, pickPoint), hoverPoint);
  if (hit === null) {
    return;
  }
  state.cursor = hit;
  if (stoneAt(hit.x, hit.y) !== 0) {
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
// Track focus without reading document.activeElement on every draw.
let coordFocused = false;
for (const input of [coordXInput, coordYInput]) {
  input.addEventListener("focus", () => {
    coordFocused = true;
  });
  input.addEventListener("blur", () => {
    coordFocused = false;
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.isComposing || event.keyCode === 229) {
        return; // Enter confirmed an IME candidate, not the coordinate
      }
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
// Panels start collapsed: their bodies are display:none until hovered, pinned
// or focused. Rebuilding those rows while they are hidden is pure waste (a
// 200-row history plus the score list is ~800 nodes per move), so the rows are
// painted lazily: a move only marks the panel stale, and the first time it
// becomes visible it is painted once.
const hoveredPanels = new Set();
let historyStale = false;
let scoresStale = false;

function panelVisible(panel) {
  return panel.classList.contains("open") ||
    panel.classList.contains("keep-open") ||
    hoveredPanels.has(panel);
}

function flushPanels() {
  if (!historyStale && !scoresStale) {
    return; // no DOM class reads on a frame that changed nothing
  }
  if (historyStale && panelVisible(historyEl)) {
    historyStale = false;
    renderHistory();
  }
  if (scoresStale && panelVisible(scoresEl)) {
    scoresStale = false;
    renderScores(computeScores());
  }
}

for (const panel of [controlsEl, scoresEl, historyEl]) {
  panel.addEventListener("pointerenter", () => {
    hoveredPanels.add(panel);
    flushPanels();
  });
  panel.addEventListener("pointerleave", () => {
    hoveredPanels.delete(panel);
  });
}

function bindPanel(panel, tab) {
  tab.addEventListener("click", () => {
    const open = panel.classList.toggle("open");
    tab.setAttribute("aria-expanded", String(open));
    flushPanels();
  });
}

bindPanel(controlsEl, controlsTab);
bindPanel(scoresEl, scoresTab);
bindPanel(historyEl, historyTab);

window.addEventListener("resize", scheduleResize);

// Scrolling moves the spacer, not the canvas: re-pick the visible slice and
// recompose it. Scroll fires several times per frame, so coalesce it like
// pointer moves; draw() itself remaps the hover and re-renders the board.
boardWrap.addEventListener("scroll", () => {
  scrollDirty = true;
  hoverDirty = true;
  state.boardDirty = true;
  scheduleDraw();
}, { passive: true });

// ---- preferences -----------------------------------------------------

const STORAGE_THEME = "dotdot.theme";
const STORAGE_BINDINGS = "dotdot.keybindings.v1";
const KEY_ACTIONS = [
  "up", "down", "left", "right",
  "pan-up", "pan-down", "pan-left", "pan-right",
  "place", "undo",
];
const MOVE_ACTIONS = ["up", "down", "left", "right"];
const MOVE_DELTA = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};
const PAN_ACTIONS = ["pan-up", "pan-down", "pan-left", "pan-right"];
const PAN_DELTA = {
  "pan-up": [0, -1],
  "pan-down": [0, 1],
  "pan-left": [-1, 0],
  "pan-right": [1, 0],
};
const ACTION_LABELS = {
  up: "Move up",
  down: "Move down",
  left: "Move left",
  right: "Move right",
  "pan-up": "Pan up",
  "pan-down": "Pan down",
  "pan-left": "Pan left",
  "pan-right": "Pan right",
  place: "Place stone",
  undo: "Undo",
};
const MODIFIER_KEYS = new Set([
  "Alt", "AltGraph", "CapsLock", "Control", "Fn", "Meta", "OS", "Shift",
]);

function makeBinding(key, ctrl = false, meta = false, alt = false,
  shift = false) {
  return { key, ctrl, meta, alt, shift };
}

const DEFAULT_BINDINGS = {
  up: makeBinding("ArrowUp"),
  down: makeBinding("ArrowDown"),
  left: makeBinding("ArrowLeft"),
  right: makeBinding("ArrowRight"),
  "pan-up": makeBinding("ArrowUp", false, false, false, true),
  "pan-down": makeBinding("ArrowDown", false, false, false, true),
  "pan-left": makeBinding("ArrowLeft", false, false, false, true),
  "pan-right": makeBinding("ArrowRight", false, false, false, true),
  place: makeBinding(" "),
  undo: makeBinding("z", true, true),
};

function cloneBinding(source) {
  return makeBinding(source.key, source.ctrl, source.meta, source.alt,
    source.shift);
}

// localStorage can throw in private mode or a sandbox; settings still apply.
function readStored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Applying the setting matters more than persisting it.
  }
}

function removeStored(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Same as writeStored.
  }
}

const themeMeta = document.querySelector?.('meta[name="color-scheme"]') ??
  null;
const systemDark = window.matchMedia?.("(prefers-color-scheme: dark)") ??
  null;
const themeRadios = ["theme-system", "theme-light", "theme-dark"]
  .map((id) => document.getElementById(id))
  .filter((radio) => radio !== null);

let theme = "system";
let bindings = {};

function normalizeTheme(value) {
  return value === "light" || value === "dark" ? value : "system";
}

function syncThemeControls() {
  for (const radio of themeRadios) {
    radio.checked = radio.value === theme;
  }
  if (themeSystemNote === null) {
    return;
  }
  if (systemDark === null || theme !== "system") {
    themeSystemNote.textContent = "";
  } else {
    themeSystemNote.textContent = systemDark.matches
      ? "System is currently dark."
      : "System is currently light.";
  }
}

function applyTheme(next) {
  theme = normalizeTheme(next);
  if (theme === "system") {
    removeStored(STORAGE_THEME);
  } else {
    writeStored(STORAGE_THEME, theme);
  }
  if (themeMeta !== null) {
    themeMeta.content = theme === "system" ? "light dark" : theme;
  }
  syncThemeControls();
}

function isBinding(value) {
  return value !== null && typeof value === "object" &&
    typeof value.key === "string" && value.key.length > 0 &&
    typeof value.ctrl === "boolean" &&
    typeof value.meta === "boolean" &&
    typeof value.alt === "boolean" &&
    typeof value.shift === "boolean";
}

function loadBindings() {
  const loaded = {};
  for (const action of KEY_ACTIONS) {
    loaded[action] = cloneBinding(DEFAULT_BINDINGS[action]);
  }
  const raw = readStored(STORAGE_BINDINGS);
  if (raw === null) {
    return loaded;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return loaded;
  }
  if (parsed === null || typeof parsed !== "object") {
    return loaded;
  }
  for (const action of KEY_ACTIONS) {
    if (isBinding(parsed[action])) {
      loaded[action] = cloneBinding(parsed[action]);
    }
  }
  return loaded;
}

function saveBindings() {
  writeStored(STORAGE_BINDINGS, JSON.stringify(bindings));
}

function keyLabel(key) {
  switch (key) {
    case " ":
      return "Space";
    case "ArrowUp":
      return "↑";
    case "ArrowDown":
      return "↓";
    case "ArrowLeft":
      return "←";
    case "ArrowRight":
      return "→";
    default:
      return key.length === 1 ? key.toUpperCase() : key;
  }
}

function bindingLabel(value) {
  const parts = [];
  if (value.ctrl && value.meta) {
    parts.push("Ctrl/Cmd");
  } else {
    if (value.ctrl) {
      parts.push("Ctrl");
    }
    if (value.meta) {
      parts.push("⌘");
    }
  }
  if (value.alt) {
    parts.push("Alt");
  }
  if (value.shift) {
    parts.push("Shift");
  }
  parts.push(keyLabel(value.key));
  return parts.join("+");
}

function bindingMatches(value, event) {
  if (event.key.toLowerCase() !== value.key.toLowerCase()) {
    return false;
  }
  if (value.ctrl && value.meta) {
    if (!event.ctrlKey && !event.metaKey) {
      return false;
    }
  } else if (event.ctrlKey !== value.ctrl || event.metaKey !== value.meta) {
    return false;
  }
  return event.altKey === value.alt && event.shiftKey === value.shift;
}

function bindingSignature(value) {
  return [
    value.key.toLowerCase(),
    value.ctrl || value.meta,
    value.alt,
    value.shift,
  ].join("|");
}

function bindingProblem(action, value) {
  if (value.key === "Escape") {
    return "Esc is reserved for closing.";
  }
  if (value.key === "Tab") {
    return "Tab is reserved for moving focus.";
  }
  if (action !== "place" && value.key === "Enter") {
    return "Enter places stones.";
  }
  if (value.key === "," && (value.ctrl || value.meta)) {
    return "Ctrl/Cmd+, opens Preferences.";
  }
  if (action !== "undo" && (value.ctrl || value.meta || value.alt)) {
    return "Use a key without Ctrl, Cmd or Alt here.";
  }
  const signature = bindingSignature(value);
  for (const other of KEY_ACTIONS) {
    if (other !== action &&
        bindingSignature(bindings[other]) === signature) {
      return `Already used for ${ACTION_LABELS[other]}.`;
    }
  }
  return "";
}

const bindingButtons = new Map(
  KEY_ACTIONS.map((action) => [
    action,
    document.getElementById(`binding-${action}`),
  ]),
);
let capturingAction = null;

function renderBindings() {
  for (const action of KEY_ACTIONS) {
    const button = bindingButtons.get(action);
    if (button === null || button === undefined) {
      continue;
    }
    const capturing = capturingAction === action;
    button.textContent = capturing
      ? "Press keys…"
      : bindingLabel(bindings[action]);
    button.classList.toggle("capturing", capturing);
    button.setAttribute(
      "aria-label",
      capturing
        ? `Press keys for ${ACTION_LABELS[action]}`
        : `Change ${ACTION_LABELS[action]} shortcut, currently ` +
          bindingLabel(bindings[action]),
    );
  }
  canvas.setAttribute(
    "aria-label",
    "Dot placement board. Move with " +
      `${bindingLabel(bindings.up)}, ${bindingLabel(bindings.down)}, ` +
      `${bindingLabel(bindings.left)} and ${bindingLabel(bindings.right)}. ` +
      `Place with ${bindingLabel(bindings.place)} or Enter. Pan with ` +
      `${bindingLabel(bindings["pan-up"])} and the other pan keys. ` +
      `Undo with ${bindingLabel(bindings.undo)}.`,
  );
}

for (const action of KEY_ACTIONS) {
  const button = bindingButtons.get(action);
  if (button === null || button === undefined) {
    continue;
  }
  button.addEventListener("click", () => {
    capturingAction = action;
    prefsError.textContent = "";
    renderBindings();
  });
}

prefsDialog.addEventListener("keydown", (event) => {
  if (capturingAction === null) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  if (event.key === "Escape") {
    capturingAction = null;
    prefsError.textContent = "";
    renderBindings();
    return;
  }
  if (MODIFIER_KEYS.has(event.key)) {
    return;
  }
  const value = makeBinding(event.key, event.ctrlKey, event.metaKey,
    event.altKey, event.shiftKey);
  const problem = bindingProblem(capturingAction, value);
  if (problem !== "") {
    prefsError.textContent = problem;
    return;
  }
  bindings[capturingAction] = value;
  capturingAction = null;
  prefsError.textContent = "";
  saveBindings();
  renderBindings();
});

prefsDialog.addEventListener("close", () => {
  capturingAction = null;
  prefsError.textContent = "";
  renderBindings();
});

function openPreferences() {
  if (typeof prefsDialog.showModal !== "function" || prefsDialog.open) {
    return;
  }
  capturingAction = null;
  prefsError.textContent = "";
  syncThemeControls();
  renderBindings();
  prefsDialog.showModal();
}

prefsOpenBtn.addEventListener("click", openPreferences);
prefsOpenBtn.title = "Preferences (Ctrl/Cmd+,)";
prefsOpenBtn.setAttribute("aria-keyshortcuts", "Control+Comma Meta+Comma");

prefsResetBtn.addEventListener("click", () => {
  for (const action of KEY_ACTIONS) {
    bindings[action] = cloneBinding(DEFAULT_BINDINGS[action]);
  }
  capturingAction = null;
  prefsError.textContent = "";
  saveBindings();
  renderBindings();
});

for (const radio of themeRadios) {
  radio.addEventListener("change", () => {
    if (radio.checked) {
      applyTheme(radio.value);
    }
  });
}

// Safari lacks closedby; keep light dismiss on the backdrop there too.
if (typeof HTMLDialogElement !== "undefined" &&
    !("closedBy" in HTMLDialogElement.prototype)) {
  let pressedOutside = false;
  const outside = (event) => {
    const rect = prefsDialog.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right ||
      event.clientY < rect.top || event.clientY > rect.bottom;
  };
  prefsDialog.addEventListener("pointerdown", (event) => {
    pressedOutside = outside(event);
  });
  prefsDialog.addEventListener("pointerup", (event) => {
    if (pressedOutside && outside(event)) {
      prefsDialog.close();
    }
  });
}

systemDark?.addEventListener?.("change", syncThemeControls);

window.addEventListener("storage", (event) => {
  if (event.key === STORAGE_THEME) {
    theme = normalizeTheme(event.newValue);
    if (themeMeta !== null) {
      themeMeta.content = theme === "system" ? "light dark" : theme;
    }
    syncThemeControls();
    return;
  }
  if (event.key === STORAGE_BINDINGS) {
    bindings = loadBindings();
    renderBindings();
  }
});

bindings = loadBindings();
theme = normalizeTheme(readStored(STORAGE_THEME));
if (themeMeta !== null) {
  themeMeta.content = theme === "system" ? "light dark" : theme;
}
syncThemeControls();
renderBindings();

// Pan keys default to Shift+Arrow; they are rebindable in Preferences.
document.addEventListener("keydown", (event) => {
  if (prefsDialog.open) {
    return; // the modal owns its keys, including Esc and capture
  }

  if (event.key === "," && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    openPreferences();
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

  const onText = event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLTextAreaElement ||
    (event.target instanceof HTMLElement && event.target.isContentEditable);
  const onButton = event.target instanceof HTMLButtonElement;
  if (onText) {
    return; // fields keep arrows, Space, Enter and native undo
  }
  if (onButton && (event.key === " " || event.key === "Enter")) {
    return; // let the focused button activate
  }

  for (const action of PAN_ACTIONS) {
    if (!bindingMatches(bindings[action], event)) {
      continue;
    }
    event.preventDefault();
    const [dx, dy] = PAN_DELTA[action];
    panBoard(dx, dy);
    return;
  }

  for (const action of MOVE_ACTIONS) {
    if (!bindingMatches(bindings[action], event)) {
      continue;
    }
    event.preventDefault();
    const [dx, dy] = MOVE_DELTA[action];
    moveCursor(dx, dy);
    return;
  }

  if (bindingMatches(bindings.place, event) || event.key === "Enter") {
    if (event.isComposing || event.keyCode === 229) {
      return; // Enter belongs to an IME candidate list
    }
    event.preventDefault();
    placeAtCursor();
    return;
  }

  if (bindingMatches(bindings.undo, event)) {
    event.preventDefault();
    undo();
  }
});

startGame(state.playerCount, state.dim);
