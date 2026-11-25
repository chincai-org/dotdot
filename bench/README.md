# Benchmarks and tests

These scripts run `main.js` under a fake DOM (`fake-dom.js`), so the game logic
can be measured without a browser. Canvas calls are no-ops; history and score
DOM rows are stubbed because both engines pay that cost equally.

| File | Purpose |
|---|---|
| `run.js` | Loads a game file in a `vm` sandbox and exposes internals |
| `reference-dense.js` | Frozen copy of the old dense engine (test reference) |
| `differential.js` | Dense vs sparse random games, walls, shapes, undo |
| `one.js` | One engine, one run, JSON metrics |
| `stress.js` | 100k/1M stones and a distant-stone bounding-box case |
| `memory.js` | Heap and RSS per board size, stone count, sealed regions, moves |
| `frame.js` | Frame composition cost at 1080p/4K windows, margin-cache math |
| `structures.js` | Rows vs tile hash vs quadtree: build, lookup, row scan, memory |
| `territory.js` | Seal cost with many separate sealed regions |
| `capture.js` | Mass capture: closing move, batch removal, batch undo restore |
| `cache.js` | Per-component sealed cache: invalidate one ring, re-analyse |
| `scratch.js` | Flood scratch retention after one giant flood |
| `sweep.js` | Stale wall-map cleanup: sweep vs rebuild, end-to-end removal |
| `scale.js` | Move / seal / frame cost by board size, ring side, stone count |
| `envelope.js` | Where each cost axis lands, on a 1,000,000 board |
| `scroll.js` | Virtual spacer mapping: capped range, far corner, centring, pan |
| `probe-big.js` | Seal cost across the extent range, up to the 94M cap |
| `compare.js` | Scaling sweep over board and ring sizes |

Set `ENGINE=/path/to/engine.js` to run any benchmark or the differential
harness against a candidate copy of the engine.

Examples:

```sh
node bench/differential.js
node bench/one.js main.js 10000 1000 500
node bench/one.js bench/reference-dense.js 1000 100 500
node --expose-gc bench/memory.js
node bench/frame.js
N=200000 node --expose-gc bench/structures.js
node bench/territory.js
node bench/scale.js
node --expose-gc bench/capture.js 100000 319 close   # also: split, undo
node bench/cache.js 400 1600 4000
node --expose-gc bench/scratch.js
node bench/sweep.js remove 100000 250000             # also: sweep, rebuild
node bench/envelope.js extent   # also: ring, wall, repeat, regions, capture, undo
node bench/scroll.js
node bench/stress.js
```

`one.js` arguments are: engine file, board size, ring size, acyclic moves.
The ring is placed by one player (turn is forced) so the closing move actually
seals a region.
