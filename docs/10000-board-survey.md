# 10,000 × 10,000 board: data-structure and algorithm survey

Status: implemented. See `optimization-report.md` for the row-gap engine,
differential tests, and benchmarks.

Goal: make `BOARD_SIZE_MAX = 10000` usable in the browser without rewriting the
rules. A 10,000 × 10,000 board is **100,000,000 crossings**. The current design
allocates dense grids at that size and scans them on enclosure moves, so it
cannot simply have its limit raised.

---

## 1. Bottom line

Do not reach for a general-purpose tree first. The best fit is:

1. **Sparse row-gap representation** — each row stores only its wall cells and
   its sealed runs, not 10,000 cells.
2. **Gap-graph flood** — a flood node is a maximal passable run in a row, not a
   cell. An open board has one node per row, so a flood is O(rows + walls),
   not O(cells).
3. **Per-player sealed runs** — territory is stored as row intervals.
   `owner` is derived from the highest player id covering a cell, and scores
   are counted from runs.
4. **Keep the current union-find cycle gate** — no flood when a new stone cannot
   close a wall cycle.
5. **Index per row** — sorted stone x values and sorted interval arrays; use
   binary search / interval merging. An interval tree or R-tree is optional for
   visible-region queries, not the primary structure.

This gives memory proportional to stones plus sealed runs, and typical move cost
proportional to the affected region, not to 100M cells.

A good fallback if row intervals prove awkward to implement is a **sparse tile
grid** (32×32 or 16×16 tiles) with a tile-skipping flood. A **quadtree is not
recommended as the primary structure** for this game: thin walls fragment it,
and the per-player territory overlay multiplies its cost.

---

## 2. Targets and assumptions

| Item | Target |
|---|---|
| Board | 10,000 × 10,000 = 100M crossings |
| Runtime | Browser, single main thread (workers optional) |
| Initial load | No multi-gigabyte allocation |
| Typical move | Ideally < 16 ms; worst case bounded |
| Undo | Same cost class as the move it reverses |
| Rules | Unchanged |
| Realistic stone count | Sparse to medium (do not design for a fully filled 100M-cell board) |

The last assumption matters. A fully occupied 10k board is 100M stones; any
exact cell-level structure becomes large. The practical target is a board that
is huge *in extent* but sparse in content, which is exactly what this game
produces.

Rules that the new structure must preserve:

- Walls are **8-connected** stones of one player.
- The flood is **4-connected** and only the flooding player's stones block it.
  Other players' stones are passable and can be captured when sealed.
- A player's sealed region depends only on that player's own stones.
- Territory owner is the **highest player id** whose sealed region covers the
  cell; later players paint over earlier ones.
- Only the mover can capture on a move (adding a stone is what closes a wall).
- Removing a stone only opens a flood; it never seals a new region.
- Undo must restore the mover's stone, captured stones, turn, territory, and
  scores.
- Rendering only touches the visible frame.

---

## 3. Current implementation and why it stops at 1,000

### 3.1 Dense allocation

`allocateCellState()` (`main.js:339`) allocates eight flat arrays of
`dim * dim` elements:

| State | Type | Bytes/cell |
|---|---|---:|
| `playerAt` | `Int8Array` | 1 |
| `ownerCells` | `Int8Array` | 1 |
| `cellFloodVisited` | `Int32Array` | 4 |
| `cellFloodQueue` | `Int32Array` | 4 |
| `trappedCells` | `Int32Array` | 4 |
| `territoryCells` | `Int32Array` | 4 |
| `wallParent` | `Int32Array` | 4 |
| `wallSize` | `Int32Array` | 4 |
| **Total** | | **26 bytes/crossing** |

At 10,000 × 10,000:

```text
100,000,000 cells × 26 bytes = 2,600,000,000 bytes ≈ 2.6 GB
```

That is before the `state.stones` `Map`, string keys such as `"1234,5678"`,
per-stone objects, history records, and captured-stone lists. `startGame()`
allocates this immediately, so the browser will fail or thrash before the first
move.

### 3.2 Per-move work

The current optimizations are good, but the fallback is still whole-board:

- `connectWall()` (`main.js:374`) uses a union-find over 8-neighbour wall
  stones. A new stone that closes no cycle does not dirty the player's
  enclosure cache.
- When a cycle closes, `enclosure()` (`main.js:436`) floods the entire board.
- `classifyUnreached()` (`main.js:559`) scans every cell to separate sealed
  empty crossings from trapped stones.
- `analyse()` (`main.js:662`) calls `owner.fill(0)` and scans the whole owner
  grid to count scores.

At 10k every cycle-closing move touches 100M cells at least once, often twice
or three times. Even at hundreds of millions of simple operations per second,
that is far beyond an interactive frame budget, and it is repeated for every
cycle.

### 3.3 What is already good and should be kept

- **Union-find cycle gate.** Most moves do not close a cycle, so most moves
  already avoid a flood. This should survive the redesign.
- **Per-player enclosure caching.** Reachability depends only on one player's
  stones. Keep that idea.
- **Viewport-bounded rendering.** `visibleCells()` (`main.js:1013`) and the
  draw passes only touch the frame. Do not replace this with full-board
  painting.
- **Horizontal run merging.** `drawFullFaces()` (`main.js:1145`) already paints
  runs rather than individual faces. The same run idea works for storage.
- **Flat integer indices.** A 100M index still fits in `Int32`; do not move to
  strings or BigInts for cell addresses.

---

## 4. Problem decomposition

The redesign has five separate problems. A single structure does not have to
solve all of them, but they must agree.

| Problem | Current | Requirement at 10k |
|---|---|---|
| Stone lookup | `Map` by string + dense `playerAt` | O(log) per row, memory O(stones) |
| Flood / enclosure | Dense cell BFS/span fill | Sparse region flood, no 100M scan |
| Territory ownership | Dense `ownerCells` | Sparse runs, highest player wins |
| Scores | Full owner scan | Count from runs, ideally incremental |
| Rendering | Visible cells, dense lookups | Visible cells, interval lookups |

Capture and undo cross all five: a capture removes stones, changes the
victim's walls, and can change territory ownership; undo reverses that.

---

## 5. Candidate structures

### 5.1 Sparse row gaps / run-length encoded rows

**Idea.** Store each row as a small set of wall x positions. The complement of
those positions is a list of maximal passable intervals ("gaps"). A flood is a
graph search over gaps, not cells.

For a player `P`, only `P`'s stones are walls. The gap list is the complement of
`P`'s stones in the row. Since a gap is a maximal horizontal run, if one cell in
a gap is reachable, the whole gap is reachable. A gap in row `y` connects to a
gap in row `y ± 1` when their x-intervals overlap.

**Why it fits this game.**

- An open row has one gap. An open board has only 10,000 gap nodes, not 100M.
- A local ring creates a local gap graph; the flood stays near the ring.
- Walls are thin, so the number of gaps is roughly `stones + rows`, not
  `rows × columns`.
- Diagonal walls are handled correctly by 4-connected overlap: two diagonal
  stones leave no shared passable x between the two sides.
- Territory is naturally a list of unreached gaps, which are already runs.

**Cost.** Let `S_P` be one player's stones and `R` the number of rows spanned by
their stones. Gaps in the region are `O(S_P + R)`. Flooding is
`O(S_P + R + edges)`, where edges arise from merging adjacent row interval
lists. With per-player bounding boxes, `R` is the affected vertical span, not
the whole board.

**Territory.** Unreached gaps are sealed runs. Empty cells inside them are
territory; stones of other players inside them are captured. After capture the
whole run is empty and owned by `P`.

**Weakness.** A pathological fully packed row has 10,000 walls and 10,001 gaps;
still manageable, but the representation is no longer small. If rows become
dense everywhere, a compressed bitset (5.3) or sparse tile layer is better.

### 5.2 Sparse tile grid (chunked arrays)

**Idea.** Divide the board into tiles, for example 32×32 or 16×16. Allocate a
tile's typed arrays only when a stone or territory touches it. Flood at two
levels: whole empty tiles are marked reached without visiting their cells;
mixed tiles get cell-level visits.

**Memory.** At 10k with 32×32 tiles there are 98k tiles; with 16×16 tiles there
are 391k tiles. An untouched board costs almost nothing. A touched 32×32 tile
costs about 1 KB for a byte-per-cell layer, so 100k touched tiles is about
100 MB. Finer tiles waste less per touched tile but create more tiles to walk.

**Pros.** Simpler to retrofit than row intervals; natural viewport queries;
familiar cell-level flood code inside a tile.

**Cons.** A full open-board flood still walks the tile graph (98k–391k tiles),
which is acceptable once but not on every move. Thin walls make many mixed
tiles. Per-player overlays and undo still need design. Tile size needs tuning.

**Verdict.** Good fallback/phase-1 structure, not the final best fit.

### 5.3 Compressed / sparse bitsets (Roaring-style)

**Idea.** One bit per cell, compressed by 32-bit or 64-bit chunks. An empty row
or chunk is absent. Operations are bit-parallel: expand runs with shifts and
masks, intersect adjacent rows, find next set bit.

**Memory.** A dense 100M-bit layer is 12.5 MB. Sparse chunks are much smaller.
Per-player occupancy is one bitmap per player, allocated lazily.

**Pros.** Much smaller than the current 26 bytes/cell even when dense; fast
32-bit word operations; good for local flood with bit tricks.

**Cons.** A custom sparse bitmap is a new mini-database: iterators, rank/select,
chunk allocation, and careful JS 32-bit handling. A Roaring dependency adds
WASM or a library. Full dense scans are still possible if the code is not
region-scoped. Territory as a separate bitmap per player multiplies memory.

**Verdict.** Strong alternate core, especially if rows become dense. More code
than row gaps for the common sparse case.

### 5.4 Quadtree / region quadtree

**Idea.** Recursively split the square into four children; store uniform-empty,
uniform-owned, or mixed nodes. Empty space collapses to a few nodes. A flood
can mark whole uniform nodes.

**Pros.** Excellent compression for large empty regions; simple point lookup;
naturally hierarchical.

**Cons.**
- Thin walls are the worst case: a single line of stones creates many mixed
  nodes along its path. A long diagonal wall is close to a full-depth
  subdivision.
- Territory is per player and later players overpaint earlier ones. A separate
  quadtree per player, or a multi-value node, gets complicated.
- Undo needs copy-on-write nodes or an undo log.
- The flood still has to visit mixed nodes along a wall; it does not exploit the
  fact that the wall is a 1-cell-wide curve.
- The game's 4-connected/8-connected topology does not map cleanly to quadtree
  boundaries; boundary cells need special handling.

**Verdict.** Not recommended as the primary structure. It solves empty space
compression, but row gaps solve that better for line-like walls, and tiles are
easier to reason about.

### 5.5 R-tree / interval tree

These are **indexes**, not complete board representations.

- **Interval tree per row**: store a row's owner runs and sealed runs, answer
  "which player owns `(x, y)`" and "which runs overlap the visible x range" in
  O(log n + k). This is a natural companion to row gaps.
- **R-tree over stones or sealed regions**: answer "stones in this sealed
  interval" and "regions intersecting the viewport". Useful for capture and
  rendering, but a row index already answers most queries because rows are the
  natural scan unit.

**Verdict.** Use interval queries per row. Avoid a general R-tree until
profiling shows a need.

### 5.6 Planar wall graph / half-edge / faces

**Idea.** Treat each player's wall as a planar graph. The sealed regions are
exactly its bounded faces. Maintain a half-edge / DCEL structure dynamically:
adding an edge splits a face; removing an edge merges faces.

**Pros.** Asymptotically the best for area: updates cost O(perimeter), not
O(enclosed area). Captures can be found by querying stones inside a face instead
of flooding. Excellent for very large sealed regions.

**Cons.**
- The wall graph is on an 8-neighbour lattice where diagonal edges can cross at
  a grid corner. A clean planar embedding needs a corner-vertex model or a
  careful split of each crossing.
- Self-touching cycles, holes, nested regions, and multiple players make the
  face bookkeeping hard.
- Undo of face splits/merges is delicate.
- Much more code and much harder to test than a gap flood.

**Verdict.** A later optimization if profiling shows that painting/counting
large sealed areas dominates. Not the first implementation.

### 5.7 Dynamic connectivity / Euler-tour trees

**Idea.** Maintain connected components of empty cells under stone insertions
and deletions. General dynamic connectivity supports split/merge in polylog
time.

**Pros.** Exact and asymptotically strong.

**Cons.** Very high constant factors, complex data structures, and the game's
grid is planar with a special 8/4 topology. Implementing this correctly in JS
is far more work than the gap graph, and the gap graph already gives
near-linear-in-output cost for the sparse case.

**Verdict.** Overkill. Do not use.

### 5.8 Cycle-local flood / contour fill

**Idea.** Keep the union-find gate. When a stone closes a cycle, only find the
newly enclosed region instead of flooding the player's whole bounding box.

Options:

1. **Local seed flood**: flood from empty cells adjacent to the new stone until
   the flood hits the wall cycle or the board border. The side that does not
   reach the border is the new enclosure. Needs a way to avoid flooding the
   huge outside.
2. **Cycle trace + scanline fill**: find the cycle path in the wall graph and
   fill its interior with an even-odd scanline. Cost O(perimeter + area).
3. **Per-wall-component flood**: flood only within the bounding box of the wall
   component that just merged. This is simpler than a contour fill and usually
   enough.

**Verdict.** Good second-phase optimization on top of row gaps. Start with
per-player or per-component bounding boxes; only add contour fill if needed.

### 5.9 Workers, OffscreenCanvas, GPU

These improve responsiveness, not algorithmic complexity.

- Move `analyse()` / flood to a Worker to keep the main thread responsive.
- Use `OffscreenCanvas` for rendering if paint becomes a bottleneck.
- WebGL is unnecessary: rendering is already viewport-bounded and cheap.

Workers with `SharedArrayBuffer` add cross-origin isolation requirements and
synchronization. Use only after the algorithm is fixed.

---

## 6. Comparison

| Option | Memory at 10k | Cost of a cycle-closing move | Undo | Code risk | Verdict |
|---|---|---|---|---|---|
| Dense typed arrays (today) | ~2.6 GB + Map | O(100M) flood + O(100M) score scan | Simple | Low | Impossible |
| Dense bitsets | ~12.5 MB per bitmap | Still O(100M) unless region-scoped | Simple | Low–medium | Stopgap |
| Sparse tiles | O(touched tiles) | O(tile graph + mixed tiles) | Medium | Medium | Good fallback |
| Sparse row gaps | O(stones + rows + runs) | O(gaps in region) | Medium | Medium | **Best fit** |
| Roaring / sparse bitsets | O(compressed chunks) | O(region words) | Medium | Medium–high | Strong alternate |
| Quadtree | O(nodes) | O(mixed nodes near walls) | Hard | High | Not primary |
| R-tree / interval tree | O(indexed objects) | Query only | Medium | Low | Companion |
| Planar faces / DCEL | O(walls + faces) | O(perimeter) | Hard | Very high | Later |
| Dynamic connectivity | O(stones) | Polylog but huge constant | Hard | Very high | No |

The important comparison is not raw asymptotic notation. It is **what gets
touched per move**. Row gaps touch the affected rows and runs; dense grids touch
the whole board.

---

## 7. Recommended design: sparse row-gap graph + sealed runs

This section is a concrete target architecture, not code.

### 7.1 Stone storage

Keep per-row indexes rather than a board-sized grid.

```text
rows: Map<y, Row>
Row {
  stones: sorted x values, each with player id
}
```

A good concrete row representation:

- `xs: Uint32Array` or a plain sorted array of x positions.
- `players: Uint8Array` parallel to `xs`.
- Binary search for point lookup.
- Insert/delete shifts the row; a row has at most 10,000 entries, and typical
  rows are tiny. This is acceptable and much simpler than a balanced tree.

For very dense rows, switch that row to a 32-bit word bitset:

```text
Row {
  words: Map<wordIndex, Uint32>  // sparse bitset
  players: ...                   // parallel per set bit
}
```

Recommendation: start with sorted arrays. Add a sparse bitset row only if a
stress test shows a pathological dense row.

Also remove string keys from the hot path. `cellIndex(x, y)` stays numeric. The
`state.stones` `Map` can remain as a convenience index for now, but it should
not be the only source of truth at 10k.

### 7.2 Gap flood for one player

For player `P`:

1. Build `P`'s gaps row by row: the complement of `P`'s stone x positions.
   Rows with no `P` stones have one gap `[0, dim-1]`.
2. Seed every gap that touches the board border:
   - all gaps in row `0` and row `dim-1`;
   - any gap containing `x = 0` or `x = dim-1`.
3. BFS over gap nodes. For a reached gap `[a, b]` in row `y`, look at the gap
   list of row `y - 1` and `y + 1`; every gap whose interval overlaps `[a, b]`
   is reached.
4. Unreached gaps are sealed by `P`.

This is exact for the current rules because:

- `P`'s stones are the only blocked cells.
- A gap is horizontally contiguous, so reaching any cell reaches the gap.
- Two gaps in adjacent rows connect exactly when their x intervals overlap.
- Other players' stones are inside gaps and remain passable, matching the
  current flood.

The BFS can be implemented with a queue of `(row, gapIndex)`. Adjacent row gap
lists are merged with two pointers; no per-cell work.

**Region scope.** Run the flood only inside the player's stone bounding box, or
better, inside each wall component's bounding box:

- Cells outside the bounding box have no walls of that component, so they are
  reachable; the bbox boundary is a valid seed line.
- If the bounding box touches the real board border, seed the real border gaps
  as usual.
- A wall component's enclosed cells lie inside its own bbox.
- Separate 8-connected wall components cannot jointly seal a region in a
  4-connected flood; only the component itself matters. Per-component caching is
  therefore sound and more local than per-player caching.
- When flooding per component, the blocked set is **that component's stones
  only**. Stones of other components owned by the same player are passable for
  this flood; otherwise separate components would be treated as one wall.

Start with per-player bbox; move to per-component bboxes if a stress case with
one small ring and one distant stone shows a large wasted span.

### 7.3 Captures

For each unreached gap interval `[a, b]` in row `y`, find stones whose x lies in
`[a, b]` and whose player is not `P`. Those are trapped and captured.

Use the row stone index and binary search / merge. Cost is O(trapped stones in
the region + log per row), not O(area).

After removal:

- The unreached gap remains `P`'s territory; the captured cells are already
  inside it.
- The victim's own enclosure cache is invalidated because their walls changed.
- The victim's union-find entries become stale; the existing "stale links only
  over-connect" policy is acceptable, but a local rebuild of the affected
  component is an option if undo becomes frequent.

### 7.4 Territory, owner, and scores

Store each player's sealed region as row runs:

```text
sealedByPlayer[P]: Map<y, Array<[x0, x1]>>
```

These are exactly the unreached gaps from the flood.

`ownerAt(x, y)` is the highest player `P` whose run covers `(x, y)`. To avoid
checking all players per lookup:

- Build a combined **owner run** list per row when analysis changes.
- Sweep all players' runs in that row in ascending player order; later players
  overpaint earlier ones.
- Cache the combined runs per row, invalidated when any sealed run changes.
- `isBlocked` is then a binary search in the row's owner runs.

Scores fall out of the same sweep: add the length of each final owner run to that
player's count. Score cost is O(number of sealed runs), not O(cells).

This preserves the current rule exactly: a cell sealed by players 1, 3, and 7 is
owned by 7 and scores for 7 only. Players 1 and 3 keep their own sealed runs
underneath so that removing 7's wall can reveal them again.

Defensive rule: `ownerAt(x, y)` returns 0 when a stone occupies the cell,
matching `analyse()`'s current zeroing of occupied owner cells. In normal play a
sealed run has no stones left after captures, but undo and stale-cache paths
should not rely on that.

`patchCachedAnalysisForStone()` (`main.js:1717`) can be dropped or rewritten as
a run split. With owner runs derived lazily from sealed runs, there is no dense
owner grid to patch in place.

Memory: O(total sealed runs). A large rectangular territory is one run per row,
so at 10k even a whole-board enclosure is about 10,000 runs, not 100M cells.

### 7.5 Rendering

Keep the viewport-bounded renderer. Replace dense lookups with row queries:

- `ownerAt(x, y)` for the four corners of each visible face.
- Per-row stone binary search for stones and links.
- `drawFullFaces` and `drawSplitFaces` still iterate visible faces only.
- `drawStones` iterates visible rows and the x range, or walks the row's sorted
  stones in that range.
- The grid pass is already O(visible lines).

The number of visible faces is bounded by the frame, so interval lookups are
cheap. If desired, build a small temporary owner array for the visible window
from the owner runs; that keeps the existing face loop mostly unchanged.

### 7.6 Undo

Undo already reverses the move record: remove the mover's stone, restore the
captured stones, restore the turn. The new structure must also invalidate the
correct caches:

- Mover's sealed runs change when a stone is removed; mark the mover dirty.
- A restored captured stone dirties its owner and may seal/unseal regions.
- Combined owner runs and scores are rebuilt lazily from the per-player sealed
  runs.
- No full-board scan is needed.

A move record can keep the captured `(index, player)` list exactly as today.
For extra safety, record the previous owner runs only for the rows touched by the
move, so undo can restore them directly; this is optional because rebuilding
from sealed runs is already bounded.

### 7.7 Wall union-find

Keep the cycle gate, but make it sparse:

- `parent` and `size` entries keyed by stone index, for example
  `Map<number, number>`, or a small per-tile array.
- Neighbour lookup uses the per-row stone index, not a dense `playerAt`.
- Track the bounding box per root if using per-component floods.

Memory O(stones). The current stale-link policy still works: stale links only
over-connect, which can cause an unnecessary flood, never a missed one.

### 7.8 Complexity summary

Let:

- `S` = stones of the player being analysed.
- `R` = rows in the affected bounding box.
- `G` = gaps in that region (`G ≈ S_region + R`).
- `T` = sealed runs.

Then:

| Operation | Current | Row-gap design |
|---|---|---|
| Start game | O(S) allocation 2.6 GB at 10k | O(1) maps; allocate on demand |
| Place acyclic stone | O(1) | O(log row) + O(1) union |
| Place cycle-closing stone | O(dim²) | O(G + edges) in bbox |
| Capture | part of flood | O(G + trapped log) |
| Scores | O(dim²) | O(total sealed runs) |
| Owner lookup | O(1) dense | O(log runs) |
| Render | O(visible cells) | O(visible cells × log runs) |
| Undo | recompute affected | O(affected G) |
| Memory | 26 bytes/cell | O(S + R + T) |

At 10k, `R ≤ 10,000`, and `S` is the number of stones actually played. That is
the right scaling for this game.

### 7.9 Pseudocode

```text
function gapsOf(player, y):
    walls = player.wallXs[y]          # sorted, may be empty
    return complementIntervals(walls, 0, dim - 1)

function floodPlayer(player):
    gapLists = {}                      # y -> gaps
    reached  = {}                      # y -> set of gap indexes
    queue    = []

    for each y in affectedRows(player):
        gapLists[y] = gapsOf(player, y)

    for each border gap g in gapLists:
        markReached(g); queue.push(g)

    while queue not empty:
        g = queue.pop()
        for each neighbour row ny in [g.y - 1, g.y + 1]:
            for each gap h in gapLists[ny] whose interval overlaps g:
                if not reached(h):
                    markReached(h); queue.push(h)

    sealed = []
    for each y, for each gap g not reached:
        sealed.push(run(y, g.x0, g.x1))

    return sealed
```

```text
function ownerRunsAndScores(sealedByPlayer):
    for each row y that has any sealed run:
        events = []
        for P in 1..playerCount:
            for run in sealedByPlayer[P][y]:
                events.push(start(run.x0, P), end(run.x1 + 1, P))
        sweep events left to right, tracking which players are active;
        owner = highest active player
        emit owner run for each constant-owner span
        scores[owner] += span length
```

---

## 8. Migration plan

### Phase 0 — guardrail

- Keep `BOARD_SIZE_MAX = 1000` until the storage rewrite lands, or cap by a
  memory estimate.
- Add a comment/issue so the limit is not raised accidentally.

### Phase 1 — remove dense cell storage

- Replace `playerAt` with per-row stone indexes.
- Replace `ownerCells` with per-player sealed runs and a per-row owner cache.
- Replace the dense flood scratch arrays with gap lists/queues.
- Replace dense `wallParent`/`wallSize` with sparse maps.
- Keep the union-find gate and per-player dirty flags.
- Raise the cap to 10,000 only after the initial allocation is O(1).
- Keep the dense reference implementation behind a test flag for small boards.

This phase is the bulk of the work. It should already make 10k open boards and
local rings usable.

### Phase 2 — scope the flood

- Flood inside the player's stone bounding box first.
- If profiling shows a big span caused by distant components, split the cache
  per wall component and flood only the component that changed.
- Keep the real-border seed when the bbox touches the board edge.

### Phase 3 — optional refinements

- Cycle-local contour fill if sealed areas are large and perimeter work
  dominates.
- Sparse bitset rows for pathologically dense rows.
- Worker offload for analysis.
- Interval tree/R-tree only if row binary searches show up in profiles.

Do not start with Phase 3. Phase 1 plus Phase 2 is enough for a credible 10k
board.

---

## 9. Testing strategy

Keep the existing fake-DOM differential harness and add a dense reference for
small boards.

### Correctness

- Random games on 5×5 through 40×40: place, capture, undo, clear, change player
  count, change dimension.
- Compare against the current dense implementation for:
  - occupied cells;
  - captured stones;
  - sealed runs / owner per cell;
  - scores;
  - blocked-cell predicate.
- Multi-player overlap: nested rings by different players; later player owns
  the overlap; removing the later wall reveals the earlier owner.
- Diagonal walls: two diagonal stones must block a 4-connected flood; a gap
  must not leak between them.
- Edge/corner walls; single-row and single-column rings; nested rings; holes.
- Undo after capture restores both the mover's stone and all captured stones.
- Random undo sequences, including undo after clear.

### Invariants

- Sealed runs are disjoint and never overlap the player's own stones.
- Every non-wall cell is either reached or sealed, never both.
- A cell is blocked iff some sealed run covers it.
- Score sum equals the number of cells with an owner.
- No stone exists on blocked ground.
- Owner is always the highest sealing player.

### Performance and memory

- 10k open board: start, hover, place acyclic stones, pan, render.
- 10k with a 20×20 ring, a 200×200 ring, and a long diagonal wall.
- 10k with 100k and 1M spread stones; measure per-move p50/p95.
- Undo the same moves; compare timings.
- Chrome DevTools memory: confirm no `100M` typed arrays.
- Scroll the full 320k CSS-pixel spacer; check render origin and coordinate
  readout at the extremes.
- Mobile device smoke test for memory and long tasks.

### Browser limits

At 10k with 32 px cells, the spacer is about 320,000 CSS pixels per side. That
is below current browser maximum element sizes (roughly 16M–33M pixels depending
on engine), so the existing scroll-spacer approach remains viable. Keep the cell
size fixed; do not scale the canvas with the board.

---

## 10. Risks and open questions

1. **Dense worst case.** A fully packed 10k board is inherently 100M stones.
   Confirm the product only needs huge *extent*, not huge *density*. If dense is
   required, add compressed bitsets and accept much higher complexity.
2. **Per-component vs per-player flood.** Per-player bounding boxes are simpler.
   A player with a tiny ring and a distant stone can make the bbox large. Decide
   whether Phase 1 ships per-player and Phase 2 adds per-component.
3. **Diagonal topology.** The gap-overlap rule is exact for 4-connected flood,
   but it must be tested hard around diagonal pairs and corner pinches.
4. **Multi-player overlays.** Per-player sealed runs must be retained under
   later players' runs; do not delete them when overpainted.
5. **Undo history memory.** `state.history` grows with every move and stores
   captured lists. At long games this can be large even if the board is sparse.
   Consider a history cap or compaction separately.
6. **Row update cost.** Sorted-array insert/delete is O(row length). This is
   fine for normal play, but a fully packed row is 10k shifts per move. Add a
   sparse bitset row if stress tests show it.
7. **Coordinate and input ranges.** `coord` inputs, `centerCell()`, and
   `clampDim()` all need the new limit. The `±5,000` range is fine for number
   inputs, but the fields must not silently clamp to `±500` anymore.
8. **History coordinates.** The centred-coordinate change is independent of this
   redesign; keep the 0,0-at-centre rule for both the pill and history.

---

## 11. Decision

**Recommended first implementation:** sparse row gaps + gap-graph flood +
per-player sealed runs + per-row owner cache, with the existing union-find cycle
gate.

**Use a tree when it is the right tool:**

- interval tree / sorted interval arrays per row for owner and visible-range
  queries;
- union-find forest for wall components (already present);
- R-tree only if a future profiling result shows region/stones queries dominate.

**Do not use as the primary structure:**

- quadtree (thin walls and multi-player overlays fragment it);
- dynamic connectivity (too complex for the benefit);
- a plain `Map` per cell (memory/GC at scale);
- dense `dim × dim` typed arrays (the current blocker).

**If row gaps are too large a rewrite for the first step:** ship a sparse tile
grid with a tile-skipping flood as an intermediate. It is less elegant but much
easier to retrofit than a quadtree, and it removes the 2.6 GB allocation
immediately.
