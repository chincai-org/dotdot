# dotdot

A Malaysian childhood game where players take turns placing dots to surround
each other. It is similar to Go but with fewer rules: the goal is to
surround your opponent.

## How to play

- Stones go on the line crossings of the grid.
- A closed ring of your colour owns everything inside it, even if empty
  crossings (liberties) remain open.
- Opponent stones trapped inside your ring are eaten and removed, and the
  whole interior is painted in your colour.
- A bigger ring beats a smaller ring.
- Diagonal stones count as touching, so a diagonal wall is closed too.
- You may not place a stone on an occupied crossing or inside a region that is
  already sealed.

Open the settings panel to change the number of players (2–48) or the board
size (5–1000). Changing either starts a fresh game.

## Controls

### Mouse and touch

- **Left click or tap** near a crossing places a stone on the nearest one.
  Clicking between two crossings snaps to whichever is closer.
- Occupied crossings and sealed ground are refused: the cursor shows
  `not-allowed` and a ring marks the blocked crossing.
- Right or middle click, and any extra finger after the first, never place a
  stone.
- **Drag, wheel or flick** to pan a large board. Moving more than a few pixels
  before release is a pan, not a placement.
- The pill at the bottom left shows the crossing at the top-left of the view,
  so you always know where you scrolled to.
- Hover a panel to open it; click or tap the header to pin it open. **Undo**
  and **Clear** are in the settings panel.

### Keyboard

- **Arrow keys** — move the board cursor one crossing at a time. The board
  scrolls to follow the cursor.
- **Enter** or **Space** — place a stone at the cursor.
- **Shift + Arrow keys** — pan the board without moving the cursor.
- **Ctrl/Cmd + Z** — undo the last move.
- **Escape** — leave a settings field and close open panels.

Number fields keep their normal arrow-key behaviour while focused, and undo
while typing edits the text instead, so board size is never hijacked.
