# The Zen draft

The first draft of Plass in Zen's shape, 2026-10-02, on the branch
`ux/zen`: the paper's way in and out in the bar beside the traffic
lights, every tool on a rail down the left, the paper floating on one
near-black surface. Run it from the worktree with `npm run app` (after
`npx vite build`); the record is `docs/zen-draft-1100.png` and
`docs/zen-draft-1500.png`, the shell from the checkout at 1100 and 1500
px wide (page captures: the traffic lights are the window's own and are
not in them; their room is the empty 100 px at the bar's left, which the
File tile sits beside).

## What moved where

**The bar** (60 px, the window's title bar in Plass.app, a drag region
but for its controls), left to right, padded on the left by the lights'
room (`env(titlebar-area-x)`; 0 in a browser tab and in the PWA):

- **File** — a bare 36 px tile, the folder glyph; its menu drops below
  as before: New document, Open… ⌘O, Recent papers ›, Save ⌘S, Get Plass
  for your Mac › (a Mac browser tab), Check for updates… (Plass.app).
  The name stayed `File` because that is what the menu holds; Taylor
  said "open" for this spot, and the glyph reads as open.
- **The name pill** — the document's name and its save dot (red unsaved,
  green saved), 42 px, Zen's address pill; click, Enter or Space renames
  in place, and an unsaved paper's first commit saves and asks for a
  folder, as before.
- **Export** — a bare tile, the download glyph; PDF, Typst (.typ), LaTeX
  (.tex) drop below.

The rest of the bar is empty: drag region.

**The rail** (60 px wide, 40 px tiles, under the bar down the left edge,
`nav#rail`; not a drag region, since it scrolls), top to bottom, in the
bar's old groups under hairlines:

- *Text*: Headings ▸, Text style ▸, Lists ▸ — their menus fly out to the
  right, level with the tile, which sits on the lighter tile while open.
- *Insert*: Insert figure ⌘⌥I, Inline math ⌘M, Footnote ⌘⌥F, and
  **Insert ▸** (a plus), whose flyout is yesterday's Extras ▸ Insert row:
  Table ⌘⌥T, Grid, Display equation ⌘⇧M, Title block, Page break ⌘⏎.
- *Blocks* — yesterday's hidden group, now visible: Block quote ⌃>,
  Solution, Comment, Remove quote, as tiles; Quote and Solution light
  (`aria-pressed`) when the caret is in one, Remove quote is enabled
  inside a quote. These refresh on every state change (cheaply: an
  ancestor walk and a dry-run `lift`, no geometry), and only write an
  attribute when it changes, so the typing path publishes nothing.
- *More*: **Extras ▸** (⋯), keeping Alignment (Justified, Center,
  Right), Code (Code block, Raw Typst block, Inline raw Typst) and
  Document (Bibliography, Markdown & shortcuts, Install Plass in a
  browser) as the captioned glyph grid; **Document settings**, whose
  panel flies out to the right.
- Pinned at the bottom: the **Plain text / Paper** switch ⌘/, a tile
  like the others, lit while the text is the truth.

The groups scroll as one (no scrollbar drawn) when the window is shorter
than they are; the switch stays put.

**The room**: the rest of the window, painted the frame's own colour
(`--bg: var(--frame)`), no rounded panel, no inset. The paper (816 px,
unchanged) is centred in it on at least `--margin` (24 px) to the bar,
the rail and the window's edge, and hovers on a hairline rim, a contact
shadow and a wide dark halo. The plain-text sheet fills the room's
height the same way. The fixed chrome that sat on the window's axis —
the HUD, the toast, the table toolbar, the image toolbar — now sits on
the room's: `main.ts` hands the room's scrollbar width to `:root` as
`--room-scrollbar`, and the stylesheet works the axis out from `--rail`
and it. Print hides the rail with the bar.

**Keyboard**: every shortcut is as it was. A rail tile's menu opens on
ArrowDown, ArrowUp or ArrowRight and closes on ArrowLeft or Escape; the
glyph rows (Insert, Extras) still walk sideways with the arrows, so
ArrowLeft there moves, Escape closes. A bar tile's menu opens on
ArrowDown/Up as before; File's submenus still go back with ArrowLeft.

**Source mode**: the six direct formatting tiles, the four Blocks tiles
and Settings rest (disabled, dim); Insert ▸ and Extras ▸ stay open with
their editing items disabled, as Extras did; Export and File are
untouched.

**Browser tab and PWA**: no overlay, so the File tile is 12 px from the
left edge; the same rail; the manifest is unchanged (no
`window-controls-overlay`, which would draw Chrome's own controls).

**Shell**: `app/plass.json` unchanged (hiddenInset, lights at {20, 23},
followZoom, minWidth 740). Plass.app from the deploy is on shell tag
v0.2.0, which ignores `titleBarStyle`: there the bar sits under a native
title bar with no lights' room, and the rail and the one-colour surround
are the same.

## What is still hidden, and why

- **Alignment** (Justified, Center, Right) stays in Extras: fourteen
  tiles already need about 650 px, and the 800 px default window gives
  the rail 740. A second step could reparent the row into the rail
  under `(min-height: 860px)`.
- **Code** (3) and **Document** (3) stay in Extras: occasional tools.
- **Recent papers**, **Get Plass**, **Check for updates** stay under
  File, as they were.
- **Focus mode** stays in the plain-text sheet's corner (⌘⇧F).
- The keymap-only commands (undo/redo, inline code ⌘`, headings 4–6,
  list Enter/Tab) have no tile, as before.

## What I would ask Taylor

1. The hovering on near-black. A black shadow on #111112 barely reads,
   so the floating is the rim (1 px at 6 % white), the contact shadow
   and the halo (24 px / 64 px at 60 %). Does it read in the shell, or
   is Zen's own answer — the lighter room panel — better? `--bg:
   #2b2a2d` brings it back in one line.
2. Should the rail's empty part drag the window, as Zen's sidebar does?
   It is not a drag region in this draft: an Electron drag region takes
   the wheel, so a draggable rail would need `no-drag` on the scrolling
   groups wrapper, and the bar is enough to move the window.
3. The rail's height budget: fourteen 40 px tiles. Under about 700 px
   the groups scroll with no scrollbar, and at minHeight 360 only six
   tiles show. 36 px tiles (pitch 40) would save 56 px; or Blocks could
   fold back into Extras on short windows.
4. 'File' or 'Open' for the top-left tile? Kept 'File' (its menu holds
   New, Open, Recent, Save, Get Plass, updates), and three tests click
   it by that name.
5. The name pill between two bare tiles: 42 px with its hairline border,
   as before. Or a bare name, Zen's URL style, with the dot?
6. The HUD (`N p · M words`) sits 16 px from the bottom inside the paper's
   right edge; with the room's uniform 24 px bottom margin it overlaps
   the last page's bottom edge by 5 px when scrolled to the end (the
   room's bottom padding was 56). Keep the uniform margin, or pad the
   bottom for the HUD?
7. Captions: a rail tile's shows to its right; the Extras and Insert
   rows' still show below. One rule, or is the difference right?
8. The glyph for Insert ▸: a plus. Zen's plus opens a new tab at the
   bottom of its sidebar; here it sits mid-rail. A table glyph instead?

## Checks

- `npm test`: green. `npm run build` (the sidecar, unused-code, exports and
  cycle checks, tsc, vite): green.
- `npx playwright test --project=chromium`: 171 passed, after the three
  tests that reached a moved item through Extras (grid, editor-comments,
  solution-block) were pointed at the rail, and frame, toolbar,
  source-view and native-tables were updated for the shape.
- `node app/smoke.mjs`: the open, the typesetting, ⌘S and the drag wider
  pass, and so do the rail under the bar, the overlay padding and the
  File tile beside the lights' room — but the smoke stops before them at
  its zoom step: the shell checkout beside this one (its working tree,
  2026-10-02) scales the window only from its View menu's `zoomTo`, not
  for a `webContents.setZoomLevel(1)` from outside, and main's own page
  fails the same step against it. A copy of the smoke with the zoom step
  skipped runs to "ok". The shell is not this branch's to change.
