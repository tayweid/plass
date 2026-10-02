# The Zen draft

Plass in Zen's shape, on the branch `ux/zen`: the paper's way in and out
in the bar beside the traffic lights, every tool on a narrow rail down
the left, and a dark frame — the bar, the rail and one thin edge all
round — holding a rounded room where the paper floats. The first draft
was 2026-10-02 early; the second pass, the same day, answers Taylor's
look at it ("a touch too black, making it hard to see the shadow", "the
sidebar is too wide", "an edge of the black all the way around, with
curved edges around the page at all four corners") and the two
reviewers' findings (below, *The second pass*). Run it from the worktree
with `npm run app` (after `npx vite build`); the record is
`docs/zen-draft-1100.png` and `docs/zen-draft-1500.png`, the shell from
the checkout at 1100 and 1500 px wide (page captures: the traffic lights
are the window's own and are not in them — `screencapture` of the window
needs a screen-recording grant this session does not have; their room
is the empty 100 px at the bar's left, which the File tile sits beside).

## The second pass

**The frame and the room.** The reading taken of "an edge of the black
all the way around, with curved edges around the page at all four
corners": Zen's window, where the page — here the room — is a rounded
panel inset by a thin edge of the frame, the frame being the bar across
the top, the rail down the left and that edge. So the room is a panel
again (as on main before the first draft), rounded 12 px at all four
corners, and the frame shows round it as one 8 px edge: below the name
pill (the bar's band ends 9 px under it), between a rail tile and the
room (the rail is 8 + 32 + 8), and at the window's right and bottom.
The paper keeps its fixed width and centres in the room, 24 px under
the room's top edge. Why the room and not the paper: the paper runs
past the window's bottom (it scrolls), so an edge at the bottom and
curved corners there can only be a viewport's — the room's — and a
fixed-width paper centred in a wider window cannot have a thin edge on
its sides. `--bg: var(--frame)` would undo the panel in one line (the
first draft's one colour, with the 8 px edge as the paper's least gap),
if the other reading was meant.

**Colours, and why.**

| | was | now | why |
|---|---|---|---|
| frame (`--frame`: body, bar, rail, edge) | #111112 | **#18181a** | Zen's own frame measures #131313–#141414 in Taylor's screenshot of it; there it reads as grey beside a black page. A step above it reads as dark grey beside a white paper and a grey room, still Zen's near-black. |
| room (`--bg`) | the frame's | **#2b2a2d** | main's room before the first draft and the rail-layout mockup's: light enough that a black shadow shows on it, dark enough that the paper is the only light. |
| name pill (`--pill`) | #1e1e21 | **#232326** | a shade up from the new frame, as before. |
| lit tile (`--tile`) | #29292c | **#2e2e32** | Zen's lit square measures #2c2e2f. |
| paper's shadow | white 6 % rim, black 50 % contact, black 60 % 24/64 px halo | **black 22 % rim, 32 % 1/3 px contact, 38 % 14/36 px halo** | on the grey room a soft black shadow reads by itself; the faint dark rim holds the paper's edge. |
| room's edge | none | white 5 % hairline | the panel's rim against the frame, as on main. |

`index.html`'s theme colour and the manifest follow the frame.

**Sizes, and why.**

- The rail: **48 px** (was 60): 32 px tiles (was 40), 18 px glyphs (was
  20; the text glyphs H1, B, Σ, † at 14 px), 9 px tile radius, 18 px
  hairlines (was 24). Zen's measures about 41 px with 33 px tiles; the
  task said about 44. 48 is 32 + the frame's 8 on both sides, so the
  gap from a tile to the room is the same 8 px as the window's edge —
  one edge width everywhere. The first tile's top is level with the
  room's top edge, the view switch's bottom with its bottom edge.
- The bar: 60 px in a tab and the PWA, and in Plass.app **the lights'
  band itself** (`--topbar: env(titlebar-area-height, 60px)`): the shell
  publishes the band in CSS px, so under a zoom step the bar shrinks
  with it (55 px at one step, 50 at two, measured in the shell) and the
  row stays centred on the lights; in fullscreen the overlay is not
  visible and the fallback holds (measured). The File tile, the pill
  (42 px) and Export are unchanged.
- The room: 8 px (`--edge`) from the window's right and bottom; the
  paper 24 px (`--margin`) inside its top and sides, **48 px**
  (`--margin-bottom`) above its bottom, the row the HUD sits in.

**The reviewers' findings, fixed.**

- *Settings over the bar*: the rail's flyouts and the settings panel go
  through one placement (`src/flyout.ts`): beside the rail, level with
  the tile, but never higher than 8 px under the bar, and no taller
  than the room under that (scrolling inside itself). At 1100×800 the
  settings panel is 68–792 px, the bar untouched.
- *The HUD on the last page's edge*: the room keeps a 48 px row under
  the last page and the HUD sits in it (20 px from the window's bottom),
  23 px clear of the paper at the end of a document. The toast and the
  image toolbar sit in the same row; all three, and the table toolbar,
  take the paper's axis from one variable (`--axis`).
- *The rail's groups cut with no cue*: the smaller tiles make the
  groups 482 px (they were 586), so every tool shows down to a window
  about 590 px tall (the 800 px default has room to spare; the first
  draft needed 700). Below that a fade at the cut edge (the frame's colour laid over
  the last or first tiles in view, held there while the groups scroll)
  says which way the rest is; `toolbar.ts` sets it on scroll and
  resize only.
- *Quote and Solution looked like lists*: Block quote is now a pair of
  quotation marks, Solution a red rule beside three lines (the solution
  block's own mark).
- *The bar against the lights under a zoom*: above; the smoke now checks
  the bar's height against the band while zoomed.
- *The Extras caption over the next row*: one rule for every glyph's
  caption — beside its column, level with it: a rail tile's to the
  rail's right, a flyout glyph's to the flyout's right (above the glyph
  only when the window has no room beside the panel), so no caption
  covers a row of its panel. All captions in the frame are the menus'
  dark glass now (the rail's were light).
- *Print*: the rail is hidden in toolbar.css's own print block, which
  comes after the rail's `display: flex` (style.css's lost the cascade);
  `frame.spec` checks the bar, the rail, the HUD and the switch print as
  nothing.
- *AGENTS.md*: the dropped word, and the frame described anew.
- *The smoke's zoom step*: main's (merged in): the zoom goes through the
  shell's View menu.

**The reviewers' second look, fixed.** Both approved the look; these
were the leftovers.

- *No blur in the built app*: the stylesheets wrote `backdrop-filter`
  and then `-webkit-backdrop-filter`. The build's minifier (lightningcss)
  reads the two as one property and keeps the last, so `dist/` held only
  the prefixed line, which Chromium does not read. In Plass.app the menus
  and panels had no blur: the File menu was #1b1a1f over the room and
  #28272b over the paper, a hard step at the paper's edge, with the
  document's text readable through it. The `-webkit-` lines are gone
  from all six rules (the menus in toolbar.css; the captions, the table
  toolbar, the old file menu, the settings panel and its dropdown in
  style.css). The minifier adds the prefix itself for Safari, so the
  build now has both. Measured in the built app in the shell's
  checkout: the File menu's `backdrop-filter` is `blur(18px)
  saturate(1.4)` (was `none`), the step at the paper's edge is now a
  gradient about 70 px wide, and over the document's text the glass is
  even (a luminance spread of 0.5 against 4.7, its darkest point the
  glass's own colour, not a letter's). Away from the edge the glass is
  still a shade lighter over the paper than over the room (#28272b
  against #1c1b1f). It is 94 % opaque, and the 6 % that shows through
  is the paper's white whether blurred or not (open, below). The smoke
  now fails if the built File menu has no `backdrop-filter`.
- *Document settings under the fade*: in a short window the cut could
  fall just after ⋯ (at 1100×560) and take Document settings out of
  view with no cue. It is now pinned at the bottom with the view
  switch, as Zen pins its bottom icons, so only tools scroll and only
  tools go under the fade; *More* holds Extras alone. The groups are
  447 px and the pinned pair 67 px, so every tool still shows down to a
  window 588 px tall. The groups have `scroll-padding-block: 28px`, the
  fade's height, so a tile reached with Tab scrolls clear of the fade.
  `frame.spec` checks that the pair is whole, below the cut and inside
  the window at 560, 480 and 360 px tall (360 is the app's minHeight),
  and that a tile tabbed to under the fade comes clear of it.
- *A caption left hanging*: Escape hands the focus back to the menu's
  tile, with its ring and caption. A later mouse click on another tile
  moved no focus, because the tiles swallow mousedown to keep the
  editor's selection, and the settings panel takes no focus either. So
  the old caption stayed beside the new panel. A mouse click on a tile
  in the bar or the rail now first blurs the other tile that held the
  focus. `toolbar.spec` checks this from Headings and from File.
- *The File tile in a tab*: with the rail at 48 px, the File tile
  (12 px in) centred 6 px right of the rail's glyphs. Wherever there is
  no lights' room (a tab, the PWA, a native title bar) it is now 6 px
  in, centred over the rail's column of tiles: the `env(titlebar-area-x,
  -6px)` fallback undoes 6 of the 12. In the shell the padding is the
  same 12 px past the lights. `frame.spec` checks that the two centres
  agree.

## What moved where

**The bar** (60 px, the window's title bar in Plass.app, a drag region
but for its controls), left to right, padded on the left by the lights'
room (`env(titlebar-area-x)`; none in a browser tab and in the PWA,
where the File tile stands over the rail's column):

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

**The rail** (48 px wide, 32 px tiles, under the bar down the left edge,
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
  browser) as the captioned glyph grid.
- Pinned at the bottom, as Zen pins its bottom icons: **Document
  settings**, whose panel flies out to the right, and below it the
  **Plain text / Paper** switch ⌘/, a tile like the others, lit while
  the text is the truth.

The groups scroll as one (no scrollbar drawn, a fade at the cut) when
the window is shorter than they are; settings and the switch stay put.

**The room**: a rounded panel a shade lighter than the frame, edged by
it (above). The paper (816 px, unchanged) is centred in it and hovers
on a soft shadow. The plain-text sheet fills the room's height the same
way. The fixed chrome that sat on the window's axis — the HUD, the
toast, the table toolbar, the image toolbar — sits on the room's:
`main.ts` hands the room's scrollbar width to `:root` as
`--room-scrollbar`, and `--axis` works the axis out from `--rail`,
`--edge` and it. Print hides the rail with the bar.

**Keyboard**: every shortcut is as it was. A rail tile's menu opens on
ArrowDown, ArrowUp or ArrowRight and closes on ArrowLeft or Escape; the
glyph rows (Insert, Extras) still walk sideways with the arrows, so
ArrowLeft there moves, Escape closes. A bar tile's menu opens on
ArrowDown/Up as before; File's submenus still go back with ArrowLeft.
Tab walks the rail's tiles, and one under the fade scrolls clear of it.

**Source mode**: the six direct formatting tiles, the four Blocks tiles
and Settings rest (disabled, dim); Insert ▸ and Extras ▸ stay open with
their editing items disabled, as Extras did; Export and File are
untouched.

**Browser tab and PWA**: no overlay, so the File tile is 6 px from the
left edge, centred over the rail's tiles; the same rail; the manifest
is unchanged (no
`window-controls-overlay`, which would draw Chrome's own controls).

**Shell**: `app/plass.json` unchanged (hiddenInset, lights at {20, 23},
followZoom, minWidth 740). Plass.app from the deploy is on shell tag
v0.2.0, which ignores `titleBarStyle`: there the bar sits under a native
title bar with no lights' room, and the rail and the one-colour surround
are the same.

## What is still hidden, and why

- **Alignment** (Justified, Center, Right) stays in Extras: the rail
  now has room for it at the 800 px default (fourteen tiles need about
  530 px of the 740), so it could come out as a fifth group; it stays
  behind ⋯ until Taylor says.
- **Code** (3) and **Document** (3) stay in Extras: occasional tools.
- **Recent papers**, **Get Plass**, **Check for updates** stay under
  File, as they were.
- **Focus mode** stays in the plain-text sheet's corner (⌘⇧F).
- The keymap-only commands (undo/redo, inline code ⌘`, headings 4–6,
  list Enter/Tab) have no tile, as before.

## What is still open

1. **The reading of "the page".** This pass takes it as Zen's page — the
   room, a rounded panel inside a thin frame edge — with the paper
   floating in it. If Taylor meant the paper itself (rounded corners on
   the sheet, the surround one colour), `--bg: var(--frame)` and a
   `border-radius: 10px` on `.page-box` and `#source` are the two lines;
   the paper's corners stay 4 px here because the sheet is the PDF's
   page.
2. **The frame's shade.** #18181a, a step above Zen's measured
   #131313–#141414. If "a touch too black" meant the frame itself
   should go further, #1c1c1f or #202024 are the next steps (the pill
   and the lit tile would move up with it).
3. **The rail at 48 vs 44.** 48 keeps the tile-to-room gap equal to the
   window's edge; 44 would mean 6 px edges either side of a tile, or a
   rail edge that differs from the window's.
4. **Alignment on the rail?** It fits now (above).
5. **Should the rail's empty part drag the window**, as Zen's sidebar
   does? Still no: the groups scroll, and a drag region takes the wheel.
6. **'File' or 'Open'** for the top-left tile? Kept 'File'.
7. **The name pill**: 42 px with its hairline, between two bare tiles;
   or a bare name, Zen's URL style? And should it stretch, or carry the
   path, at 1500 px where the bar is otherwise empty?
8. **The Insert ▸ glyph**: a plus mid-rail, which in Zen means a new
   tab; a table glyph instead?
9. **The record's screenshots** are page captures without the native
   traffic lights; a window capture needs the screen-recording grant.
10. **The glass over the paper.** With the blur back, a menu still reads
    a shade lighter over the paper (#28272b) than over the room
    (#1c1b1f): the glass is 94 % opaque, and the blurred paper behind it
    is still white. At 97 % the paper's side would be about #222125;
    fully opaque would end the glass.

## Checks (second pass)

- `npm test`: green. `npm run build` (the sidecar, unused-code, exports
  and cycle checks, tsc, vite): green.
- `npx playwright test --project=chromium`: 173 passed. `frame.spec`
  checks the colours, the rounded room, the 8 px edge, the 48 px rail
  with 32 px tiles, the HUD clear of the last page at the end, the
  settings panel and a flyout below the bar, the fade at a short
  window's cut, and print; `toolbar.spec` checks a flyout glyph's
  caption sits beside the panel, level with the glyph.
- `node app/smoke.mjs` (the shell checkout beside the main one, on main
  with the title-bar option and follow-zoom): ok, through the View
  menu's zoom, with the bar's height checked against the lights' band
  while zoomed and the room's 8 px edge checked after.

## Checks (the second look)

- `npm test`: green. `npm run build`: green; the built stylesheet has
  `-webkit-backdrop-filter` and `backdrop-filter` in every glass rule.
- `CI=1 npx playwright test --project=chromium`: 174 passed. New
  checks: in `frame.spec`, the File tile centred over the rail's tiles in
  a tab, settings and the switch pinned whole below the cut at 560, 480
  and 360 px, and a tile tabbed to under the fade coming clear of it; in
  `toolbar.spec`, a mouse click after Escape leaving no focus or caption
  on the old tile. Each fails on the source before this change, and the
  Tab check fails without the scroll padding.
- `node app/smoke.mjs`: ok, now with the File menu's blur checked in the
  built app. On a build of the previous commit it fails with
  `backdrop-filter: none`.
