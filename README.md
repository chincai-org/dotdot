# dotdot

A Malaysian childhood game where players take turns placing dots to surround
each other. It is similar to Go but with fewer rules: the goal is to
surround your opponent.

## Quick start

1. Open `index.html` in a browser.
2. Click or tap a line crossing to place the first stone (red starts).
3. Take turns; blue places next. Surround opponent stones to capture them.
4. Drag, scroll or flick to move around a large board.
5. Hover a panel to preview it; click its header to pin it open. The settings
   panel has players, board size, **Undo**, **Clear** and **Preferences…**.

Your theme and key choices are saved in the browser and restored next time.

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
size (5–94,000,000). Changing either starts a fresh game.

## Controls

### Mouse and touch

- **Left click or tap** near a crossing places a stone on the nearest one.
  Clicking between two crossings snaps to whichever is closer.
- Occupied crossings and sealed ground are refused. Sealed ground shows a
  `not-allowed` cursor and a ring; an occupied crossing keeps the crosshair
  but a click there places nothing.
- Right or middle click, and any extra finger after the first, never place a
  stone.
- **Drag, wheel or flick** to pan a large board. Moving more than a few pixels
  before release is a pan, not a placement.
- **Edit the x/y pill at the bottom left** to jump the cursor. Click either
  field, type a coordinate and press **Enter** (or leave the field). The board
  centres on that crossing. Coordinates are relative to the centre, so `0, 0`
  is the middle of the board.
- Hover a panel to open it; click or tap the header to pin it open. **Undo**
  and **Clear** are in the settings panel.
- **Preferences…** in the settings panel (or **Ctrl/Cmd + ,**) opens the
  Preferences modal. See [Preferences](#preferences).

### Keyboard

- **Arrow keys** — move the board cursor one crossing at a time. The board
  scrolls to follow the cursor.
- **Enter** or **Space** — place a stone at the cursor.
- **Type in the x/y pill** — jump the cursor to that coordinate.
- **Shift + Arrow keys** — pan the board without moving the cursor.
- **Ctrl/Cmd + Z** — undo the last move.
- **Ctrl/Cmd + ,** — open Preferences.
- **Escape** — leave a settings field and close open panels.

These are the defaults. Every move, pan, place and undo key can be changed in
Preferences; a key can only be used by one action at a time. Number fields keep
their normal arrow-key behaviour while focused, and undo while typing edits the
text instead, so board size is never hijacked.

### Preferences

Open Preferences with the button in the settings panel or **Ctrl/Cmd + ,**.

**Theme**

- **System** (default) follows your operating system and switches live when
  the system does.
- **Light** and **Dark** force that theme.
- The choice applies immediately and is remembered.

**Keyboard**

1. Click the shortcut button you want to change. It shows **Press keys…**.
2. Press the new key or combination. It is saved at once.
3. Press **Esc** to cancel. If the key is already used by another action, an
   error explains which one; press another key or **Esc**.
4. **Reset shortcuts** restores every default shown in the Keyboard list.
5. **Done**, **×** or **Esc** closes the modal.

**Enter** always places a stone and **Esc** always closes, so those stay
reserved. Shift+Arrow is only the default pan binding; it can be changed.
