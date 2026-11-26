# Row-gap engine: implementation and benchmarks

This is the implementation follow-up to `10000-board-survey.md`. The game now
stores stones and territory sparsely, floods row gaps instead of every
crossing, and raised `BOARD_SIZE_MAX` from 1,000 to 10,000 (and later to
94,000,000; see the update below).

## Update: sparse row-gap follow-up (items 1–6)

Six changes target the costs left after the row-gap rewrite. Every one is
measured against the same dense reference, and `bench/differential.js` still
reports zero mismatches.

| # | change | before | after |
|---:|---|---:|---:|
| 1 | release oversized flood scratch | 20.9 MB retained after a 990k-row flood | 0.1 MB |
| 2 | per-component sealed cache | 400/1,600/4,000 rings: 3.31/13.05/31.64 ms | 0.96/2.61/7.13 ms |
| 3 | cycle-path flood | 990k-row wall close 929.79 ms | 0.29 ms |
| 4 | sweep stale wall map | 100k live + 250k removed: 412.4 ms; 1M + 1.2M: 3,820.9 ms | 197–207 ms; 1,192–1,266 ms |
| 5 | batch capture removal | 100k victims: close 164.8–170.8 ms, removal 126.8–141.2 ms | 54.4–82.9 ms, 38.9–51.0 ms |
| 6 | batch undo restore | 100k victims: undo 453.2–481.2 ms | 88.0–101.6 ms |

### 1. Release oversized flood scratch

`computeSealed` reuses its typed-array scratch between floods. That is good for
repeated floods, but a one-off flood over a 990,000-row wall pinned ~21 MB of
`Int32Array`/`Uint8Array` for the rest of the session. `trimFloodScratch()` now
releases the flood arrays once peak rows or gaps pass `1 << 17`.

Measured after the 990,000-row flood, with forced GC: `arrayBuffers` 20.9 MB →
0.1 MB, and `floodScratch()` reports offsets/gaps/reached 0/0/0. The
release-disabled variant keeps 990,008/990,007/990,005 entries.

### 2. Per-component sealed cache

The sealed cache was one band list per player. Removing a stone from one small
ring invalidated it, so the next `analyse()` re-flooded every ring the player
owned. `state.componentSealed[player]` is now keyed by the cyclic wall root:
`connectWall` merges cached band lists when two components unite, and a removal
invalidates only the root it touched. Tree components have no sealed ground and
are skipped.

`bench/cache.js` builds N separate rings, removes one stone from one ring, then
analyses:

| rings | player-wide cache | per-component cache |
|---:|---:|---:|
| 400 | 3.31 ms | 0.96 ms |
| 1,600 | 13.05 ms | 2.61 ms |
| 4,000 | 31.64 ms | 7.13 ms |

The per-component cost follows the one re-flooded ring; the player-wide cost
follows every sealed ring on the board.

### 3. Cycle-path flood

A cycle close used to flood the whole wall component. `cyclePathBetween()`
walks the newly closed cycle and floods only its bounding box when the involved
components were trees, or when the surviving root already has a cached sealed
set; otherwise it falls back to the component box. `CYCLE_SEARCH_BUDGET` caps
the path walk.

`bench/envelope.js wall` closes a small ring at the top of one connected wall
(the ring body is placed through `place()`, so corner cycles cache the
component; the last stone is the real gap):

| wall rows | component-box flood | cycle-path flood |
|---:|---:|---:|
| 10,000 | 5.96 ms | 0.45 ms |
| 25,000 | 15.10 ms | 0.27 ms |
| 50,000 | 27.26 ms | 0.30 ms |
| 100,000 | 65.58 ms | 0.51 ms |
| 250,000 | 201.38 ms | 0.30 ms |
| 500,000 | 397.49 ms | 0.28 ms |
| 990,000 | 929.79 ms | 0.29 ms |

`bench/envelope.js repeat` closes 20 small rings on the same wall:

| wall rows | component-box total | cycle-path total | cycle-path median |
|---:|---:|---:|---:|
| 10,000 | 85.41 ms | 7.21 ms | 0.344 ms |
| 100,000 | 1,044.20 ms | 8.11 ms | 0.348 ms |
| 990,000 | 18,163.33 ms | 6.97 ms | 0.325 ms |

The second and later closes reuse the component's cached bands, so the cost is
the new cycle's path, not the component's height.

### 4. Sweep the stale wall map

Stale wall entries are safe (they only over-connect), but a long game grew the
maps with every stone ever played. The old cleanup rebuilt the whole graph from
the live stones. `sweepWalls()` marks the parent chain of every live stone and
deletes entries no chain reaches, keeping live root ids and their sealed caches.
`compactWalls()` picks a rebuild when live stones are scarce
(`live * 10 < entries`), otherwise it sweeps. `wallSize` and `wallBox` values
are kept only for component roots; after the typed-array follow-up below, the
arrays have a slot per node but non-root slots stay zero.

`bench/sweep.js`:

| case | rebuild | sweep | `removeStones`, compact |
|---|---:|---:|---:|
| 100k live + 250k removed | 307.7 ms | 99.1 ms | 197–207 ms (was 412.4) |
| 1M live + 1.2M removed | 3,173.2 ms | 674.7 ms | 1,192–1,266 ms (was 3,820.9) |

The compact path leaves `wallParent` at exactly one entry per live stone, and
`wallSize`/`wallBox` at one per component; the sweep alone is cheaper than a
rebuild whenever most stones survive. The crossover is near 10× stale entries
per live stone: at 10× the sweep is 207.8 ms against a 283.5 ms rebuild, and at
15× the rebuild wins (329.8 ms against 415.2 ms).

### 5. Batch capture removal

`removeStones()` sorts the trapped list by flat index, groups it by row, and
compacts each row once. A single flood already emits trapped stones in
row-major order, so the sort is skipped in the normal case.

100,000 victims (319-side ring, 10,000 board, 2 players), per-stone path vs
batch:

| measurement | per stone | batch |
|---|---:|---:|
| whole closing move | 164.8–170.8 ms | 54.4–82.9 ms |
| removal alone (`split`) | 126.8–141.2 ms | 38.9–51.0 ms |

The batch path is 0.39–0.51 µs/victim for removal and 0.54–0.83 µs/victim for
the whole move, against 1.27–1.41 and 1.65–1.71 µs/victim.

### 6. Batch undo restore

`restoreStones()` merges each affected row once, runs a local typed-array
union-find over the restored stones, and only touches the global wall map for
edges to stones that were already live. It shares `mergeWallRoots()` and
`markWallCycle()` with `connectWall`.

Undo of the same 100,000-victim capture: 453.2–481.2 ms (4.53–4.81 µs/stone)
per stone vs 88.0–101.6 ms (0.88–1.02 µs/stone) batched. The batched path
derives each restored node as `base + k`, so it never adds a `node` field to
the undo record's stone objects.

## Update: typed storage (items 7–9)

Three storage changes replace per-stone JS arrays, `Map` entries and per-move
objects. They are measured against the previous sparse build;
`bench/differential.js` still reports zero mismatches.

### 7. Typed row columns

Most rows hold one or two stones, so a typed array per row would cost more in
object overhead than it saves. A row therefore starts as three JS arrays and
converts at `ROW_TYPED_MIN` (8) stones to `Uint32Array` x, `Uint8Array` player
and `Uint32Array` node, with separate capacity and live length. Insert and
remove use `copyWithin` instead of `splice`; the batch capture path compacts
each row once and only truncates the JS form.

Measured, heap + array buffers (typed-array backing is outside `heapUsed`):

| case | before | after | change |
|---|---:|---:|---:|
| 856k stones, 10,000 board | 243.2 MB heap, 357 MB RSS | 8.6 MB heap + 37.1 MB buffers, 123 MB RSS | 81% less |
| 100k scattered, 1M board | 56.4 MB heap, 118 MB RSS | 31.7 MB + 3.4 MB buffers, 104 MB RSS | 38% less |
| 100k played moves | 45.9 MB heap, 428 B/move | 19.3 MB heap, 149 B/move | 65% less |
| 160k-stone 40k ring | 68.4 MB heap, 199 MB RSS | 59.4 MB + 8.6 MB buffers, 189 MB RSS | history-bound |
| 4,000 sealed regions | 13.1 MB heap, 79 MB RSS | 6.4 MB + 4.9 MB buffers, 69 MB RSS | 19% less |

Performance did not regress: 500 acyclic moves went from 29.2 ms to 26.7 ms
(~9% faster), the ring per-move median stayed at 0.030 ms, and capture/undo
stayed inside their previous ranges.

### 8. Typed wall union-find

`wallParent`, `wallSize`, `wallBox`, `wallCycle` and `wallRootPlayer` are now
dense typed arrays indexed by node id, with `wallEntries` as the Map-style
size. `wallBox` stores four ints per node. `rebuildWalls()` renumbers live
stones densely, so node ids do not grow forever and the arrays drop to the live
count; `sweepWalls()` clears dead slots and decrements `wallEntries`.

| case | before | after | change |
|---|---:|---:|---:|
| sweep, 100k live + 250k removed | 70.9 ms, 106 MB heap | 11.1 ms, 23 MB heap | 6.4× faster |
| sweep, 1M live + 1.2M removed | 609.8 ms, 338 MB heap | 73.3 ms, 83 MB heap | 8.3× faster |
| `removeStones` end-to-end, 1M + 1.2M | 1,133.1 ms, 338 MB heap | 517.1 ms, 84 MB heap | 2.2× faster |
| 856k scattered stones, wall maps only | 243.2 MB heap | 33.2 MB heap + 26.1 MB buffers | 76% less total |
| rebuild, 1M live + 1.2M removed | 3,008.6 ms | 2,930.6 ms | unchanged |

The 990,000-row wall case is the one place the dense box is a wash: RSS drops
from 492 MB to 409 MB, but heap + buffers stays near 265–271 MB because one
16-byte box slot per isolated node replaces the old per-root `Map` objects.
Sweep and removal are the wins; the rebuild path is unchanged.

### 9. Packed undo history

`state.history` used one JS object per move plus one object per captured stone:
~106 B/move and ~66 B/captured stone. History is now six typed columns:
index, player, removed start and removed count per move (13 B), plus index and
player per captured stone (5 B). `place()` copies the completed record into the
columns; `undo()` materializes only the last record. The history panel reads the
columns directly, and `startGame()` drops the arrays instead of keeping the old
game's high-water mark.

| case | before | after | change |
|---|---:|---:|---:|
| 100k random moves, history only | 10.03 MB, 105 B/move | 1.66 MB, 17 B/move | 6.0× less |
| 100k-stone capture, history only | 6.36 MB, 66.4 B/stone | 0.65 MB, 6.8 B/stone | 9.8× less |
| 100k moves, whole game | 19.3 MB heap, 149 B/move, 142 MB RSS | 9.3 MB heap, 44 B/move, 108 MB RSS | 52% less heap |
| place 100k moves | 6.06–6.56 s | 6.02–6.04 s | unchanged or faster |
| close 100k-victim capture | 98–115 ms | 89–99 ms | unchanged or faster |
| undo 100k-victim capture | 143–187 ms | 137–191 ms | unchanged within noise |

Capacity doubles, so the measured bytes include slack: 17 B/move and
6.8 B/captured stone at 100k. There is no cap, so undo still reaches every
move; memory grows with the game, just ~6–10× slower. A cap would keep only the
newest N moves, so undo could not pass the oldest kept move; compaction alone
preserves unlimited undo.

## Update: round 2 (chunked history, 3-byte indices, wall recycling)

Three storage changes remove the remaining history slack and stop wall node
ids from growing under undo/redo churn. Replay/checkpoint undo was measured and
rejected. `bench/differential.js` still reports zero mismatches.

### 10. Chunked history

The six history columns are now arrays of 4,096-entry chunks instead of one
doubling typed array each. At a length just above a power of two the old
columns reserved almost twice the live bytes; chunking leaves at most one
partial chunk. The accessors `historyMoveIndex()` and friends translate a live
index to chunk + offset; the history panel and the benchmark harness use them.

| case | flat doubling | chunked | change |
|---|---:|---:|---:|
| 100k random moves, history only | 1.67 MB, 18 B/move | 1.32 MB, 14 B/move | 21% less |
| 1.3M played moves, whole game | 101.7 MB, 82 B/move, 183 MB RSS | 92.1 MB, 74 B/move, 167 MB RSS | 9% less |
| 1M played moves, whole game | 58.4 MB, 61 B/move | 58.1 MB, 61 B/move | 0.6 MB (length is a power of two) |
| 100k-victim capture, history only | 0.60–0.66 MB, 6.4–6.9 B/stone | 0.52–0.58 MB, 5.4–6.0 B/stone | ~12% less |
| place 100k moves | 30.3 µs/move | 30.7 µs/move | unchanged |
| 5M played moves | — | 346 MB, 73 B/move, 423 MB RSS | new scaling point |

Undo keeps the chunk high-water mark, just as the flat arrays did. An earlier
version trimmed trailing chunks on every pop; a place/undo churn then
reallocated a 4-chunk block each cycle and was ~19% slower, so trimming was
removed.

### 11. Three-byte history indices

A flat move index fits in 24 bits while `dim <= 4096` (`4096^2 = 2^24`).
Small boards store three bytes per move; larger boards keep a 32-bit column,
so the 94,000,000 cap is unchanged. The narrow path saves 1 B/move, 7.7% of
the 13 B record.

| case | 32-bit | 24-bit |
|---|---:|---:|
| 100k moves at 1,000 board, history only | 1.32 MB, 14 B/move | 1.23 MB, 13 B/move |
| 100k moves at 1,000 board, timing | 43.1 µs/move | 43.5 µs/move |

Unconditional 3-byte indices would cap the board at 4,096 and save only
1 B/move, so the wide fallback is the useful form.

### 12. Wall-node recycling

A removed stone used to leave its union-find node behind until a later sweep.
Every place/undo cycle therefore grew `nextWallNode` and the backing arrays,
even when the live board did not change. Nodes now go on a free list when
cleanup proves no live stone's parent chain reaches them:

- `removeStone()` frees an isolated root immediately (root of size 1 has no
  children and no live component).
- `sweepWalls()` frees every unreachable node it clears.
- `restoreStones()` takes free ids first, then fresh contiguous ids. The batch
  restore still uses the global wall arrays for its local union-find, with a
  high-bit marker in `wallRootPlayer` to tell restored nodes from live ones.
- `wallsAreStale()` also triggers on `nextWallNode - freeWallCount`, so a
  capture undo/redo cycle that keeps `wallEntries` constant still sweeps and
  recycles ids.

| case | before | after |
|---|---:|---:|
| 100k live + 200k place/undo: wall capacity | 524,288 nodes | 131,072 nodes |
| same: buffer growth / next node id | +9.84 MB, 300,001 | +0.13 MB, 100,002 |
| same: time per place/undo | ~65.5 µs | ~65–66 µs |
| 200k live + 8×(100k-victim close/undo): capacity | 2,097,152 nodes | 524,288 nodes |
| same: buffer growth / next node id | +39.1 MB, 1,105,681 | +2.0 MB, 502,743 |
| same: time per close/undo | 158.9 ms | 169.1 ms (+6%) |
| 100k-victim capture: close / undo | 54–83 / 88–102 ms | 60–88 / 86–109 ms |

The capture close/undo ranges are unchanged within run-to-run noise. The
close/undo churn pays ~6% more time for a 4× smaller wall array and ~20× less
buffer growth, because cleanup now runs often enough to recycle the captured
ids instead of letting them accumulate.

### 13. Replay/checkpoint undo (rejected)

A checkpoint design stores a full board snapshot every K moves and replays up
to K moves to undo. The prototype stores index + player per stone (5 B) plus
the move list (5 B/move); restoring a 50k-stone checkpoint with `setStone`
takes 234 ms, before replay.

| checkpoint every | checkpoint + move list | measured undo |
|---:|---:|---:|
| 100 moves | 239.1 MB | 245.7 ms |
| 500 moves | 48.4 MB | 254.5 ms |
| 1,000 moves | 24.6 MB | 271.7 ms |
| 5,000 moves | 5.5 MB | 395.4 ms |
| 10,000 moves | 3.1 MB | 537.0 ms |

Packed history for the same 100k moves is 1.3 MB and undo is ~0.1 ms for a
normal move, ~90 ms for a 100k-victim capture. Even the smallest checkpoint
interval is ~190× the history memory, and every interval is 245 ms or more per
undo. Rejected: it loses unlimited undo and is worse on both axes.

### Round-2 memory envelope

Measured on the same Node harness, heap + array buffers:

| case | heap + buffers | RSS | time |
|---|---:|---:|---:|
| 100k played moves, 10k board | 11.3 MB | 72 MB | 3.1 s (30.8 µs/move) |
| 1.3M played moves | 92.1 MB (74 B/move) | 167 MB | 40.1 s (30.8 µs/move) |
| 5M played moves | 346.1 MB (73 B/move) | 423 MB | 153.5 s (30.7 µs/move) |
| 856k scattered stones, no history | 45.7 MB (8.6 heap + 37.1 buffers) | 122 MB | — |
| 100k-victim capture | history 0.52–0.58 MB | — | close 60–88 ms, undo 86–109 ms |

Per-move cost settles around 58–74 B/move once the wall and history arrays are
sized for the current game; the wall arrays dominate and step at powers of
two. 5M moves is measured, not extrapolated. A 10M-move game should land near
0.7 GB, 20M near 1.4 GB, and a desktop tab reaches a few GB around 30–50M;
mobile stays around 5–10M. Undo remains unlimited, and the board extent is
still 94,000,000.

## Update: 94,000,000 cap

Four later changes remove the remaining extent limits:

- **Per-component flood scoping.** The wall union-find now keeps a stone
  bounding box per root (`wallBox`). A cycle-close floods the component that
  just closed (later narrowed to the newly closed cycle path; see the follow-up
  above), and unions the result into the player's sealed cache (additions are
  monotonic). A stone on the far side of the board no longer inflates the
  flood: a 1,000-wide ring closed in ~2.5–7 ms at 10k, 100k, 1M, 10M, 30M and
  90M extent (was 14 ms at 100k and 118 ms at 1M). The 4,000-separate-rings
  seal move drops from ~7.7 ms to ~0.2 ms.
- **Component-scoped removal rebuild.** A removal (undo, capture) can open a
  region, so the sealed cache is rebuilt. It now floods only the components
  that ever closed a cycle, listed per player (`playerCycles`), instead of
  walking every stone or the player's whole bbox. Undoing a closing move on a
  1,000,000 board with a far-away stone drops from ~146 ms to ~0.3 ms. Short
  bboxes still take the single fast flood, which avoids a per-component walk
  when thousands of small rings share one corner.
- **Virtual scroll spacer.** The spacer is capped at 4 M CSS px and board
  coordinates are mapped onto it, so a 94,000,000-crossing board (3.0 G px) is
  reachable on every browser instead of hitting the ~17–33 M px layout cap.
- **Frame-local drawing.** Every canvas pass now subtracts the slice origin
  before drawing, so no path coordinate is near the 24-bit precision limit of
  a 3.0 G px board.

`BOARD_SIZE_MAX` is now 94,000,000, which is the arithmetic ceiling rather than
a performance one: a crossing is the flat index `y*dim+x`, and integers above
`2^53 = 9.007e15` stop being exact. `94M^2 = 8.836e15`; the exact largest dim
is 94,906,265. Normal moves and frames stay ~0.1 ms and ~0.08 ms at every
extent; the cost left is real content (a wall's own length, number of sealed
regions).

At 94M the scroll compression is 755:1, so one wheel tick moves ~2,500
crossings. Clicks, keyboard cursor and coordinate entry stay exact; the wheel
and scrollbar thumb are coarse. Use a smaller board for fine wheel panning.

## Update: rectangle bands and flat flood

Two changes attack the last content-bound cost, the closing move of a large
ring. A 16,000-side ring close was ~35 ms in the envelope (and ~60 ms when the
board was built without intermediate draws); it is now ~14 ms.

- **Territory is stored as rectangle bands.** A band is a range of consecutive
  rows with identical horizontal runs, so a simple ring's interior is one
  band instead of 16,000 row entries. `playerSealed` is a band list, and the
  merged owner map is a band list too. The merge groups rows by identical
  runs and sweeps band boundaries, so the per-row run arrays and per-row
  merge entries are gone. A stone-free band carries a `clean` flag and is
  emitted and scored in one step; an unclean band still checks its rows,
  because an interior stone has to split that row.
- **The flood uses flat typed arrays.** Each row's gaps live in shared
  `Int32Array` offsets/start/end buffers instead of one small array per row.
  A 16,000-row flood no longer allocates 16,000 arrays, which was most of its
  cost and garbage. The buffers fill in one row pass and grow only when a
  stone-heavy row needs more than one gap.

Measured closing move, 1M board, 2 players (place every stone,
`bench/envelope.js ring`):

| ring side | before | bands only |
|---:|---:|---:|
| 1,000 | 3.6 ms | 1.7 ms |
| 4,000 | 7.7 ms | 4.3 ms |
| 8,000 | 20.6 ms | 7.4 ms |
| 16,000 | 35.3 ms | 14.0 ms |

### Update: one-pass flood and clean-band merge

The first band pass left two costs on the closing move: the flood read every
row twice, then the band collection read it again to look for trapped stones,
and the owner merge still visited every row of a stone-free band.

- **One flood pass.** Gap offsets and starts/ends fill together. The buffers
  start at one gap per row (the usual shape) and double when needed, so a row
  is read once instead of twice.
- **Enemy-row flags.** While filling gaps, the flood marks rows that hold
  another player's stone. Band collection scans a row for trapped stones only
  when that flag is set; a normal sealed interior has none.
- **Clean bands.** A sealed band records whether it contains any enemy stone.
  The owner merge emits a clean band as one rectangle and multiplies its run
  lengths by the band height, instead of walking its rows. A direct stone
  insertion inside a cached band clears the flag and marks the owner map
  dirty, so undo restores and the test harness stay exact. Normal moves
  cannot do this, because `isBlocked` refuses sealed ground;
  `bench/differential.js` covers the direct-insert path against the dense
  reference.

Measured closing move, 1M board, 2 players (`bench/envelope.js ring`, median
of five runs):

| ring side | bands only | now |
|---:|---:|---:|
| 1,000 | 1.7 ms | 1.0 ms |
| 4,000 | 4.3 ms | 1.7 ms |
| 8,000 | 7.4 ms | 3.9 ms |
| 16,000 | 14.0 ms | 4.4 ms |

The 10,000-board whole-board ring (9,998 per side, 40,000 stones) closes in
2.8 ms. A small ring on a connected wall spanning 990,000 rows now closes in
~0.3 ms (was 1.1 s before the cycle-path flood); the flood follows the newly
closed cycle, not the component's full height. At 4,000 sealed regions the
owner merge drops from 2.2 ms to 0.6 ms and the seal move from ~1.5 ms to
~0.5 ms.

Memory follows the same compression: the 160k-stone 40k-side ring drops from
117 MB to 70 MB heap (280 → 199 MB RSS), and 4,000 sealed regions store 4,000
runs in 63 bands instead of 16,000 runs, cutting their sealed cache from 2.5 MB
to 0.8 MB. The trade is that a seal on a board with thousands of regions now
rebuilds the band list (sub-millisecond at 4,000) instead of patching a few
rows; that is still well inside a frame.

### No-lag envelope (measured at 1,000,000; extent is free)

`bench/envelope.js` measures each axis. Rough thresholds for a 60 fps game
(one frame is 16.7 ms):

| what grows | 1 ms | 5 ms | 16 ms (one frame) |
|---|---|---|---|
| board extent | any | up to 94 M | — (extent is free) |
| ring side | ~100 | ~4,000 | ~10,000 |
| sealed regions on board | ~200 | ~1,500 | ~6,000 |
| undo / capture rebuild | any | up to 94 M | — |

Start, normal move, frame, and undo are flat in extent. What still costs is
the size of the newly closed cycle and the number of sealed regions that a
rebuild has to merge; both are content the player created, not board size.
A small ring on a connected wall spanning 990,000 rows closes in 0.3 ms,
because the flood follows the new cycle path rather than the component's
height.

A whole-board ring is the largest wall a board of side N allows. Closing one
costs ~2.3 ms at N=1,000, ~5.4 ms at N=4,000, ~12 ms at N=10,000 warm and
~20–25 ms cold, ~20–30 ms at N=16,000, and ~95 ms at N=50,000 (200,000
perimeter stones). So ~4,000 per side stays comfortably inside one frame;
~10,000 is the edge; beyond that the closing move visibly stutters.

### Memory envelope

Memory is `O(stones + occupied rows)`, never `O(dim^2)`. The empty 94,000,000
board costs the same as a 20x20 one.

| case | heap | buffers | RSS |
|---|---:|---:|---:|
| empty 1M board | 5.1 MB | 0.1 MB | 50 MB |
| empty 94M board | 5.1 MB | 0.1 MB | 51 MB |
| 100k scattered stones, 1M board | 31.7 MB | 3.4 MB | 104 MB |
| 40k-stone ring (10k side), 1M board | 19.1 MB | 2.2 MB | 109 MB |
| 160k-stone ring (40k side), 1M board | 59.4 MB | 8.6 MB | 189 MB |
| 4,000 sealed regions (80k stones) | 6.4 MB | 4.9 MB | 69 MB |
| 857k scattered stones, 10k board | 8.6 MB | 37.1 MB | 123 MB |

Per stone: ~53 B for dense play on a compact area, ~350 B when the stones
spread over 90k distinct rows (the per-row object still dominates), and
~425 B for ring walls (which pay undo history and sealed bands more than the
stones). 100k played moves cost ~9 MB in total, stones and history included,
44 B/move. A full 1M-side ring would be 4M stones, roughly 1 GB or more, so memory is
still the real ceiling for enormous content, not speed.

Sealed territory is stored as rectangle bands, not cells or rows: 4,000
separate regions cost 4,000 runs in 63 bands, 0.8 MB. A seal covering a whole
1M-row ring is one band, so its cache is O(1) instead of 1M runs. Canvas
backing stores are frame-sized: two view-sized canvases, ~6 MB at 1080p dpr1
and ~25 MB at dpr2, independent of board size.

## What changed

- `state.rows: Map<y, { xs, players }>` replaces the dense `playerAt` grid.
  Each row is sorted by x, so a point lookup is a binary search.
- A player's enclosure is a flood over **gaps**: maximal passable runs in a
  row. The flood is scoped to that player's stone bounding box and seeded from
  the box perimeter. Cost is O(rows + gaps in the box), not O(dim²). Gaps are
  stored in flat `Int32Array` buffers, filled in one row pass and grown only
  when a row needs more than one gap.
- Rows holding an enemy stone are flagged during that pass, so band
  collection only scans those rows for trapped stones.
- Sealed regions are cached per player as rectangle bands
  (`playerSealed`): consecutive rows with identical runs are one band. A
  band also records whether it is `clean` (holds no stone).
- `analyse()` merges every player's sealed bands into owner bands with a
  sweep over band boundaries, highest player id winning, and counts scores
  from the same runs. No dense owner grid and no full-board score scan.
- A clean band is emitted and scored as one rectangle, height times run
  lengths, with no per-row pass. An unclean band is split around its stones.
- The merge rebuilds the band list when any sealed cache changes. A ring is
  one band, so the band bookkeeping and memory follow rectangles, not rows; a
  board with thousands of small regions costs its region count (~0.6 ms at
  4,000).
- The wall union-find is sparse (`Map` keyed by crossing index). The cycle gate
  is unchanged: most moves never flood. Stale entries left by captures and
  undo are swept out once they outnumber live stones; a rebuild is used when
  live stones are scarce.
- Rendering still composes only the visible frame. The visible owner/stone
  slice is copied into two small flat buffers once per frame, so the face and
  stone passes read arrays like the old dense grid instead of doing a map
  lookup per corner.
- Undo stores the same one-move delta. Removing or restoring a stone marks only
  the affected player dirty; owner bands and scores rebuild lazily.

## Correctness checks

`bench/differential.js` loads the old dense engine
(`bench/reference-dense.js`) and the new engine side by side and compares, after
every move:

- stone presence at every crossing;
- owner at every crossing;
- scores;
- turn and move count;
- captured stone lists.

It runs random games (5×5 to 20×20, 2–5 players, random undo) and targeted
shapes: forced rings with captures, diamonds (diagonal walls), edge rings,
nested/overlapping walls, several separate rings with a full undo and re-close,
and undo after capture. All cases pass.

A randomised fuzz runs the same comparison over 40 small boards plus 15
larger ones that mix direct `setStone`/`removeStone` with `place`, undo and
`startGame`. The direct removals push the stale wall entries past the cleanup
threshold, so `sweepWalls()`/`compactWalls()` and the seals after cleanup are
compared against the dense reference as well (4,890 states, all equal).

## Benchmarks

Node v26 on the same machine, fake DOM, canvas calls are no-ops, and the
history/score DOM rows are stubbed. Times are wall clock.

### 1,000 × 1,000, 2 players

| Metric | Dense (old) | Sparse (new) | Change |
|---|---:|---:|---:|
| `startGame` | 4.31 ms, 25 MB typed arrays | 0.47 ms, 0 | ~9× faster, no grid |
| 500 acyclic moves | 99.8 ms | 20.6 ms | ~4.8× faster |
| Ring 100 closing move | 11.22 ms | 0.56 ms | ~20× faster |
| `analyse()` after ring | 6.99 ms | 0.16 ms | ~43× faster |
| Undo closing move | 6.11 ms | 0.48 ms | ~12.7× faster |

The acyclic move used to be the one regression: 0.22 ms per move against the
dense engine's 0.20 ms. It is now 0.04 ms, because the biggest per-move cost
was not the engine at all (see "Hidden panel work" below).

### 10,000 × 10,000, 2 players

| Case | Closing move | `analyse()` | Undo |
|---|---:|---:|---:|
| 1,000-wide ring (4,000 stones) | 2.10 ms | 2.21 ms | 1.89 ms |
| 4,000-wide ring (16,000 stones) | 8.28 ms | 3.76 ms | 9.40 ms |
| 9,998-wide ring (39,992 stones) | 20.68 ms | 14.56 ms | 15.22 ms |

The last case is effectively a whole-board enclosure. The old engine could not
allocate this board at all (≈2.6 GB of typed arrays).

Worst case for the flood is one player whose stones sit at opposite corners, so
their bounding box is the whole board. Closing a small ring then costs 3.4 ms
(200-wide) to 5.8 ms (2,000-wide), because the flood walks rows and gaps, not
crossings.

Memory with spread stones at 10,000 (own process per case, after forced GC):

| Stones | Heap | RSS | Per stone |
|---:|---:|---:|---:|
| 0 | 4.9 MB | 51 MB | — |
| ~10k | 10.2 MB | 65 MB | 560 B (row overhead dominates) |
| ~98k | 35.2 MB | 102 MB | 322 B |
| ~462k | 130.0 MB | 250 MB | 284 B |
| ~857k | 243.0 MB | 353 MB | 292 B |

An empty 10,000 board costs exactly the same as an empty 1,000 board: 4.9 MB
heap, 0.1 MB array buffers. The old dense engine reserved ~25 MB of typed
arrays for 1,000 × 1,000 and would have needed ~2.6 GB at 10,000.

Territory costs more than stones. A closed ring keeps its sealed bands and
owner bands cached:

| Ring | Stones | Heap delta | Per stone |
|---|---:|---:|---:|
| 1,000-wide | 4,000 | +2.0 MB | 518 B |
| 2,000-wide | 8,000 | +3.5 MB | 465 B |
| 4,000-wide | 16,000 | +6.8 MB | 444 B |
| 9,998-wide | 39,992 | +16.6 MB | 434 B |

Player count barely moves it (8 players, 2,000-wide ring: +4.1 MB, same as 2).
Clearing drops the heap back near the empty-board level. The flood scratch
buffers keep their high-water size between games (about a megabyte after a
large board), but that is a fixed ceiling, not growth: ten ring+clear cycles
grow the heap by 0.35 MB total, so nothing accumulates per game.

## Frame cost and panning

`bench/frame.js` measures one composed frame (grid, territory, links, stones)
at realistic windows, on an empty 10,000 board:

| Window | Corners | `renderBoard` | `visibleWindow` |
|---|---:|---:|---:|
| 1080p, DPR 1 | 2,170 | 0.041 ms | 3.1 µs |
| 1080p, DPR 2 | 2,170 | 0.035 ms | 2.1 µs |
| 4K, DPR 1 | 8,418 | 0.094 ms | 6.1 µs |
| 4K, DPR 2 | 8,418 | 0.095 ms | 4.1 µs |

A margin cache (compose a border, blit small pans) was considered and rejected
on this data: it would cut at most ~0.09 ms of JavaScript per frame at 4K, in
exchange for up to 12 MB of extra backing store, seam handling, and recentre
logic. The unmeasured part — real raster cost of the paths — is the only thing
that could justify it, and there is no browser here to test that.

The frame timings move by up to ~50% between runs on the same machine (GC,
other processes), so treat them as an order of magnitude, not a budget.

## Hidden panel work

The largest per-move cost was not the engine. The history panel rebuilt its
newest 200 rows on every move, and the score panel rebuilt every player row on
every move that changed territory, even though both panel bodies are
`display: none` unless hovered, pinned or focused. That is ~800 fresh DOM nodes
and ~400 coordinate conversions per move thrown away unseen.

Now a move only bumps a stale flag and updates the always-visible header line.
The rows are painted once, the first time the panel is actually visible
(`pointerenter`, pin click, or focus). Measured with the fake DOM counting
`createElement` calls:

| Panels | DOM nodes per move |
|---|---:|
| Old (hidden or not) | 809 |
| New, panels closed | 0 |
| New, history open | 4 (one prepended row) |
| New, scores open, points unchanged | 0 |

An open history panel now prepends the new row and drops the oldest, instead
of rebuilding 200 rows. An open score panel compares the point totals and
leaves the DOM alone when they did not move.

Scroll events also compose the frame synchronously, several times per frame
during a fling. The handler now only marks the frame dirty; `draw()` reads the
scroll offset once per frame.

## Flat undo, coalesced input, smaller layers

- **Per-player cycle index.** A removal rebuild used to walk every stone on
  the board to find the mover's cycle components. `playerCycles` keeps those
  roots per player, so the walk costs the player's component count, not the
  stone count. Undoing a closing move next to 500,000 scattered stones drops
  from 141 ms to a 0.28 ms median. Undoing a 16,000-stone vertical line drops
  from 32.2 s total (2.0 ms per undo) to under a second (~0.03–0.05 ms per
  undo), flat as the line grows. A stale bounding box no longer triggers a
  full rescan either: the component floods over-approximate safely, so the
  tight box is only rebuilt when a scoped flood actually needs it.
- **Bounded wall union-find.** Captures and undo used to leave `wallParent`,
  `wallSize`, `wallBox` and `wallCycle` entries behind for every stone ever
  played, so a long game kept them all. `removeStones` now checks the stale
  count and calls `compactWalls()` once entries pass `2 × live + 256`. It
  sweeps the map when most stones are still live: every live stone's parent
  chain is marked and unreachable entries are deleted, keeping live roots (and
  their sealed caches) intact. When live stones are scarce (`live × 10 <
  entries`) it rebuilds the exact graph from the live stones instead. The
  rebuild walks stones in row-major order and only looks at earlier
  neighbours, so each edge is unioned once and no false cycle is reported.
  `wallSize` and `wallBox` now hold one entry per component root, not per
  stone.
- **One hit-test per frame.** `pointermove` stores the raw client position and
  schedules a draw; the hit test, `isBlocked`, and the cursor-style write run
  once in `draw()`. The canvas rect and backing-store scale are cached until
  the next resize, so a mouse move no longer calls
  `getBoundingClientRect()`. The scroll handler likewise does no layout read
  per event. A cursor-style write happens only when the style changes.
- **Ghost scratch layer.** The ghost stone and cursor fit in one cell, so they
  are composed on a ~2-cell scratch canvas and blitted. The second
  full-frame canvas is gone: 1080p DPR 2 drops from 63 MiB of canvas backing
  store to 32 MiB, and 4K DPR 2 from 253 MiB to 127 MiB.
- **Mouse drag pans.** Press, move past the click tolerance, and the board
  follows the pointer; release without the tolerance places a stone. Touch
  still pans natively, and `pinch-zoom` is no longer disabled.
- **Allocation-free hot paths.** Pointer state is four plain numbers (last
  client position, press origin, drag anchor), so a `pointermove` allocates
  nothing and the coalesced hit test writes into two scratch points. The
  animation-frame callback is a named function, not a closure per frame.
  `visibleWindow` reuses its two `Int8Array` slices; the merge sweep reuses its
  cut list, per-player cursor arrays, and pooled `{ player, runs }` slots; the
  draw passes reuse their per-player `Path2D` slot arrays (the paths still
  have to be rebuilt, since `Path2D` cannot be reset). `computeSealed` reuses
  its seven flood buffers, and `computeSealedPlayer` reuses its `seen` set,
  root list and trapped-stone map. `mergeRunLists`/`computeSealed` no longer
  allocate a closure per call.

## Batch capture removal

A large capture used to call `removeStone` once per victim. Each call spliced
that row's `xs` and `players` arrays, so every victim in a dense row moved the
rest of the row, and the cost grew with the stones per row as well as the
victim count. `removeStones` now sorts the trapped list by flat index, groups
it by row, and compacts each row once. A single flood already emits trapped
stones in row-major order, so the sort is skipped in the normal case. Per-stone
counts, player boxes, dirty flags and the one stale-wall rebuild still run.

`bench/capture.js` fills a ring with victims and measures both paths:

```sh
node --expose-gc bench/capture.js 100000 319 close
node --expose-gc bench/capture.js 100000 319 split
```

100,000 victims (319-side ring, 10,000 board, 2 players):

| measurement | time | per victim |
|---|---:|---:|
| flood + trapped scan | 3.0–6.3 ms | — |
| batch removal | 38.9–51.0 ms | 0.39–0.51 µs/stone |
| whole closing move | 54.4–82.9 ms | 0.54–0.83 µs/stone |

The per-stone splice path measured 1.27–1.41 µs/stone for removal and
1.65–1.71 µs/stone for the whole move, so the batch path is about 3× cheaper;
the whole move also pays flood, history, drawing and the stale-wall cleanup.
Undo restore is batched separately (see item 6 above).

## What is left

- The engine itself is ~2 µs per acyclic move; further engine work is noise
  next to canvas and DOM.
- A flood still allocates its `bands`/trapped result objects (the caches keep
  them), and each sealed band is a fresh `{ y0, y1, runs }` record. This is
  bounded by the number of sealed regions, not by board size.
- The remaining flood bound is the cycle's own path: a ring whose two ends sit
  far apart on one component still floods the path between them. A small ring
  on a 990,000-row wall is now ~0.3 ms because the path is small. Undo and
  capture rebuilds still flood the components that ever closed a cycle, which
  is bounded by their sealed content.
- Panning still recomposes the visible frame. A margin cache was measured and
  rejected: it would save ≤0.09 ms of JavaScript per frame at 4K for up to
  12 MB of extra backing store.
- No real browser has been run here: canvas raster, high-DPI, mobile touch,
  and real pointer/scroll costs are unmeasured. The frame and flood timings
  above come from Node with a fake canvas and vary by roughly ±50% run to run.

## Other structures: measured, not adopted

`bench/structures.js` builds the same stone set three ways and measures the two
operations the engine actually performs: a point lookup and a 64-crossing row
scan (what the gap flood does per row). 10,000 × 10,000 board, 200k queries,
5k scans, one process per structure.

| Stones | Structure | Build | Lookup | Row scan | Heap/stone |
|---:|---|---:|---:|---:|---:|
| 10k | sorted rows | 6 ms | 0.05 µs | 0.1 µs | 127 B |
| 10k | 16×16 tile hash | 4 ms | 0.04 µs | 0.2 µs | 639 B |
| 10k | quadtree (bucket 8) | 3 ms | 0.11 µs | 0.5 µs | 68 B |
| 200k | sorted rows | 41 ms | 0.09 µs | 0.2 µs | 25 B |
| 200k | 16×16 tile hash | 84 ms | 0.17 µs | 0.7 µs | 506 B |
| 200k | quadtree (bucket 8) | 83 ms | 0.70 µs | 1.7 µs | 72 B |
| 1M | sorted rows | 216 ms | 0.25 µs | 0.4 µs | 18 B |
| 1M | 16×16 tile hash | 443 ms | 0.28 µs | 1.3 µs | 231 B |
| 1M | quadtree (bucket 8) | 751 ms | 0.93 µs | 3.1 µs | 77 B |

Rows win both operations at every density, and by 3–7× on lookups at 200k+.
The reason is structural, not tuning:

- A quadtree answers a *point* query with 14 levels of pointer chasing plus a
  bucket scan; a row answers it with one Map hit and 7 comparisons over a
  contiguous array. Rows win on cache locality alone.
- The flood does not ask point queries, it asks **row ranges**: "give me the
  gaps in row y between x0 and x1". Rows answer that natively (binary search
  then walk). A quadtree has to run a rectangle query and reassemble the row.
- Tile hashing is the closest competitor and is only competitive on point
  lookups for very sparse boards, where it pays 5× the memory and 2× the scan
  time.

A quadtree is therefore not a second structure to *combine* with rows — it is a
replacement for rows, and a worse one on every measured axis. The same applies
to an R-tree or a spatial hash: the hot operation is a row sweep, which is what
rows are already optimal at.

## What is combined today

The engine is already a combination, and each part exists for one measured
reason:

| Layer | Why |
|---|---|
| Sorted rows | point lookup and row-range scan |
| Sparse wall union-find | cycle gate, so most moves never flood |
| Gap-graph BFS per player | flood cost = rows + gaps, not crossings |
| Per-player sealed bands | one flood per seal, reused until the walls change |
| Owner-band merge (highest id wins) | `analyse()` without a dense owner grid |
| Visible-window flat buffers | draw passes read arrays, not maps |

## Where it still scales with content

Territory used to be the cost that grew with the number of sealed rows, because
every invalidation re-merged every player's runs row by row. Bands fix the
shape of that cost: a seal marks the player's cache dirty and `analyse()`
rebuilds the merged owner bands in one sweep over band boundaries. A ring is
one band, so a large seal costs rectangles. What remains grows with the number
of **separate** sealed regions, each contributing boundary events and its runs.

`bench/territory.js` builds N separate 6×6 rings on a 10,000 board, then closes
one more ring for real:

| Rings | Bands | Runs | Flood | Merge | Seal move |
|---:|---:|---:|---:|---:|---:|
| 25 | 5 | 25 | 0.1 ms | 0.02 ms | 0.22 ms |
| 100 | 10 | 100 | 0.3 ms | 0.06 ms | 0.14 ms |
| 400 | 20 | 400 | 1.3 ms | 0.06 ms | 0.14 ms |
| 1,600 | 40 | 1,600 | 4.1 ms | 0.21 ms | 0.23 ms |
| 4,000 | 63 | 4,000 | 12.2 ms | 0.57 ms | 0.68 ms |

At 4,000 regions the merge is 0.6 ms for 4,000 runs grouped into 63 bands, and
the deliberately unscoped flood over the player's whole bounding box is
12–16 ms depending on GC. A real seal floods only the component that just
closed, so the flood column is a worst case, not the seal move. Ordinary moves
stay at ~0.1 ms because a move that closes no cycle reuses the cached analysis.

## When does it feel slow

Board size by itself is not the limit: an empty 10,000 board starts in 0.55 ms,
takes a 0.37 ms move and composes a 0.03 ms frame. What costs time is content —
the length of a wall being sealed, the number of stones in the player's
bounding box, and the number of separate sealed regions.

`bench/scale.js`, 10,000 board, 2 players:

| Closing a ring, by side | Stones | Closing move |
|---:|---:|---:|
| 100 | 396 | 1.0 ms |
| 1,000 | 3,996 | 2.3 ms |
| 2,000 | 7,996 | 3.2 ms |
| 4,000 | 15,996 | 5.4 ms |
| 9,998 (whole board) | 39,988 | 11.6 ms |

| Small ring closed next to N existing stones | Flood | Closing move | Normal move |
|---:|---:|---:|---:|
| 1,000 | 5.5 ms | 0.4 ms | 0.36 ms |
| 10,000 | 8.8 ms | 0.3 ms | 0.11 ms |
| 50,000 | 23.2 ms | 0.4 ms | 0.17 ms |
| 200,000 | 62.4 ms | 0.6 ms | 0.17 ms |
| 500,000 | 132.1 ms | 0.4 ms | 0.23 ms |

Rough feel, on the 60 Hz frame budget of 16.7 ms:

| Cost | What the player notices |
|---|---|
| under ~4 ms | nothing |
| 4–16 ms | one dropped frame; a tiny hitch on that move only |
| 16–50 ms | visible stutter, one to three frames |
| over 50 ms | feels laggy |

So the comfortable envelope is: any board extent up to the 94,000,000 cap,
rings up to ~2,000 crossings per side (8,000 stones), and several thousand
separate sealed regions. A 4,000-side ring (16,000 stones) costs ~5 ms; a
10,000-side ring (40,000 stones) costs ~12 ms warm, ~20–25 ms on the first
large close. A 16,000-side ring (64,000 stones) costs ~20–30 ms, and a
50,000-side ring (200,000 stones) costs ~95 ms: visible stutter to lag. A
normal move stays at 0.1–0.4 ms even next to 500,000 stones; a closing move no
longer grows with scattered stones because it floods only the newly closed
cycle path. Mass capture is the expensive path: 100,000 trapped stones cost
40–45 ms to remove and 90–100 ms to undo, so ~10,000 victims is the one-frame
edge and 50,000+ is laggy. The flood column is the unscoped whole-player
rebuild that only undo/capture pays, so read it as the worst case, not the
move. Normal (non-sealing) moves stay at ~0.1–0.4 ms, and panning is bounded
by the window, not the board.

These are Node numbers with a fake canvas. A real browser adds raster cost, and
a mid-range phone runs this JavaScript perhaps 2–3× slower, so read the table
as a desktop best case and halve the stone budgets for mobile.

## Measured: spill history to IndexedDB (rejected)

IndexedDB is a browser-provided, per-origin, asynchronous transactional
key-value store. Values are copied with structured clone, so one page can be a
single `ArrayBuffer` of packed history; keys are page numbers; an index is
optional because access is append + reverse read. A spill design would keep
the newest N moves in memory and write older pages to disk. Undo past the
boundary would fetch one page, so `undo()` becomes asynchronous.

Measured in headless Chromium 159 on Linux, 5M moves, 13 B/move (4-byte index),
incompressible payload, one transaction per page, durability `relaxed`:

| page moves | page bytes | write p50 / p95 | read p50 / p95 |
|---:|---:|---:|---:|
| 4,096 | 53 KB | 0.2 / 0.3 ms | 0.2 / 0.3 ms |
| 16,384 | 213 KB | 0.4 / 0.7 ms | 0.4 / 1.3 ms |
| 65,536 | 852 KB | 1.2 / 1.9 ms | 1.3 / 1.9 ms |
| 100k-victim capture | 500 KB | 0.8 / 1.2 ms | 0.9 / 1.5 ms |

Default durability was not slower here (0.2 / 0.4 ms at 4,096), but relaxed
is the honest choice for a best-effort undo cache. One transaction for 200
pages was 1.4× faster than 200 separate transactions, but a live game cannot
hold one transaction open for millions of moves.

| 5M moves, page size | pages | logical | total write | write p95 | read p95 | storage delta |
|---:|---:|---:|---:|---:|---:|---:|
| 4,096 wide | 1,221 | 62.0 MiB | 204 ms | 0.3 ms | 0.4 ms | 62.6 MiB |
| 16,384 wide | 306 | 62.2 MiB | 135 ms | 0.7 ms | 1.3 ms | 62.3 MiB |
| 16,384 narrow | 306 | 57.4 MiB | 139 ms | 0.7 ms | 1.3 ms | 57.5 MiB |

Storage accounting was 1:1 with the packed bytes; the profile reported a
~10 GB quota. Writes total 135–204 ms across 5M moves, about 27–41 ns/move,
and one write lands every 4,096–16,384 moves. IndexedDB is not the bottleneck.

The problem is the benefit:

| game | history bytes | total heap + buffers | keep newest 100k, save |
|---:|---:|---:|---:|
| 1M moves | 12.4 MiB | 58.1 MiB | 11.2 MiB (19%) |
| 5M moves | 62.0 MiB | 346.1 MiB | 60.8 MiB (18%) |
| 10M moves (estimate) | 124 MiB | ~692 MiB | ~123 MiB (18%) |

History stays ~18% of the game because wall nodes and rows grow with moves
too. At 5M the wall arrays alone are 208 MiB and are read on every move, so
they cannot be spilled. A 60 MiB saving does not move the game into a new
memory class; on desktop it is noise, and on mobile 346 → 285 MiB is still
too close to the tab limit.

The complexity is not the page write. It is async undo (pending UI, rapid
undo, cancellation), loading a page and remapping capture offsets, deleting
stale pages when the player branches after undo, prefetching the next page
before the boundary, and isolating tabs that share an origin. IndexedDB can
also fail from quota, private mode, eviction, or corruption; losing a page must
stop undo at that boundary without touching the live board. Finally, the game
does not save the board, so persistence across reloads is unused: the disk
copy exists only to save RAM during one session.

Verdict: not worth implementing for memory alone. Revisit if the game gains
save/resume (then IndexedDB pays for persistence, and history can ride along)
or if wall memory drops enough that history becomes a large fraction of the
total. If it is implemented then, use 16K-move pages, one `ArrayBuffer` per
page, `relaxed` durability, keep the newest two pages, and prefetch the next
page before undo reaches the boundary.

## How to run

```sh
node bench/differential.js          # dense vs sparse differential tests
node bench/one.js main.js 10000 1000 500
node bench/one.js bench/reference-dense.js 1000 100 500
node bench/stress.js                # many stones, distant-stone bbox
node --expose-gc bench/memory.js    # heap/RSS per stone count, one process each
node bench/frame.js                 # frame cost at 1080p and 4K
N=200000 node --expose-gc bench/structures.js   # rows vs tiles vs quadtree
node bench/territory.js             # many sealed regions
node bench/scale.js                 # when does it feel slow
node --expose-gc bench/capture.js 100000 319 split  # mass capture removal
node bench/cache.js 400 1600 4000   # per-component sealed cache
node --expose-gc bench/scratch.js   # flood scratch retention
node bench/sweep.js remove 100000 250000  # stale wall-map cleanup
node bench/envelope.js wall         # small ring on a long connected wall
node bench/envelope.js repeat       # repeated closes on one long wall
node bench/compare.js               # scaling sweep
```

`bench/reference-dense.js` is a frozen copy of the old dense engine, used only
by the differential harness.
