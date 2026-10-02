# The Zen draft

Plass in Zen's shape: the paper's way in and out in the bar beside the
traffic lights, every tool on a narrow rail down the left, and a dark
frame — the bar, the rail and one thin edge all round — holding one
rounded panel, which is the paper. The first draft (branch `ux/zen`)
was 2026-10-02 early; the second pass, the same day, answered Taylor's
look at it ("a touch too black, making it hard to see the shadow", "the
sidebar is too wide", "an edge of the black all the way around, with
curved edges around the page at all four corners") and the two
reviewers' findings (below, *The second pass*); both are on main. The
third pass (branch `ux/zen3`, the same afternoon) gives Plass Knuth's
bar and makes the panel the paper, the window the zoom (below, *The
third pass*), and then takes Knuth's new 44 px bar and holds the view
still while typing (below, *The bar as tall as the rail is wide*). The
paper's corners (branch `ux/corners`, the same evening) round a corner
only where it is a sheet's (below, *The paper's corners*). Run
it from the worktree with `npm run app` (after `npx vite build`); the
record is `docs/zen-draft-1100.png` and `docs/zen-draft-1500.png`, the
shell from the checkout at 1100 and 1500 px wide at the top of a paper,
`docs/zen-draft-scrolled-1100.png`, the same at 1100 with a page gap in
view, and `docs/zen-knuth-1100.png`, Knuth in the same shell at 1100,
for the bars, each on a document in `~/Projects/week-3` (page captures: the
traffic lights are the window's own and are not in them —
`screencapture` of the window needs a screen-recording grant this
session does not have; their room is the empty 88 px at the bar's left,
which the File tile sits 12 px past).

## The paper's corners

Taylor, after the merged layout (Plass main eb4ea89): "looks soo good.
in plass i think it's a little hard to tell what's the top and bottom
of the page. so i wonder if we can round the edges of the page when
they're visible but if the edge of the paper isn't visible then the
corners of the elevated platform on that side are squared off. not sure
i'm explaining this very well. but i basically want to show the PAPER
and it's rounded corners and not have the elevated platform round the
corners if they aren't truely the corner of the paper."

The panel's four corners were rounded 12 px whatever was under them, so
in the middle of a paper a rounded corner at the top and the bottom of
the window said "here the page ends" where it did not, and nothing told
the first page's top from the middle of the third.

**What was built.** A corner is rounded only where it is a sheet's own:
the first page's top corners while its top edge is in view, both
sheets' corners at every page gap (each sheet is a piece of paper, and
the gap shows the frame), the last page's bottom corners at the end.
Where the paper runs on past the panel's edge, that edge is square: the
clip is straight and nothing there suggests an edge. The radius is 12
px on the screen at any scale, Knuth's room's, so the corner is the
same size at 868, 1100 and 1500 wide although the page is drawn at 1,
1.28 and 1.77. Zen's shadow is now the paper's: it is drawn round the
paper in view, so a short paper's shadow ends where its last page ends
(below it the panel is the frame, nothing of the paper), the frame's
8 px edge keeps its shade under paper that runs on, and its corners are
the paper's, square where the paper is cut. The plain-text view is one
long sheet, never shorter than the panel, rounded at its top and its
end like a page.

**The mechanism**, in two sentences: every sheet is rounded at its four
corners (`.page-box`, the radius divided by the scale `paper-scale.ts`
writes on `#pages`; the clip box `#paper` cuts the stack's outer four)
and the panel's own clip is square, so a corner shows wherever a sheet's
corner is in view and an edge is straight wherever the paper runs on, by
geometry alone. The shadow is a fixed box behind the panel
(`#paper-shadow`) whose top, bottom and corner radii are CSS variables
`paper-scale.ts` writes in the frame after a scroll, a new set of
sheets or a new height, and only when they change, from the sheets the
painter laid (`paperSheets`, called by `renderPages`) and the panel's
scroll offset.

Why it is built that way:

- **The rounding is geometry, not a rule per scroll position.** The
  panel carries no white or shadow of its own any more: it is a square
  window. Nothing decides "round the top now"; the first sheet's corner
  is either in the window or not. The one thing that must be told is the
  shadow, which sits outside the panel's clip (a shadow drawn inside a
  scroller cannot fall on the frame round it).
- **The shadow's corner is what is left of the sheet's corner.** Its
  radius is 12 px less however far the sheet's edge is past the panel's
  edge, so as the first page's top scrolls out the shadow's corner
  shrinks with the visible part of the paper's (6 px when scrolled 6 px)
  and does not snap. A page gap at the panel's edge starts the shadow at
  the next sheet's top, a few px in, rounded.
- **A gap crossing the panel's edge hands the shadow over across a
  corner's length.** The sheet beyond the gap is all corner for its
  first 12 px in view, so while less than that of it is in, the
  shadow's end is mixed from the sheet on this side's (its edge, 12 px
  corners) and its own (the panel's edge, square), a part for each px in
  view. At first a sheet counted as in view from its first fraction of a
  px, so as a gap crossed the panel's bottom the shadow's end jumped the
  gap's height (7.7 px at 1100) and its corners went from 12 px to
  square in one frame (the review found it at a scroll offset where 0.06
  px of the next sheet was in view; the same at the top). Now a px of
  scroll moves the end by under 2 px (1.4 px at most at 1100) and the
  corner by 1 px.
- **No layout on scroll.** A scroll asks for one frame, and that frame
  reads the panel's scroll offset (the panel's height and the clip's are
  kept from the resize path), walks the kept sheets, and writes up to
  four variables on the shadow's own element, which only change near a
  sheet's edge; in the middle of a page nothing is written. The scale
  variable lives on `#pages`, not the stack: on the stack it would have
  every node of the editor restyled (24 ms a write on a 32-page paper,
  7269 nodes, against 0.2 ms on the page boxes). The scroll range, the
  `paperPass` caret hold and the no-anchoring rule are untouched.
- **A clip path, not a border radius, on the clip box.** Chromium clips
  a rounded `overflow`'s descendants in paint but not in hit testing
  (measured: a point in a cut corner still answered the editor), so a
  click in the cut-away corner would have put the caret in the paper.
  `clip-path: inset(0 round 12px)` clips both; `overflow: clip` stays
  for the scroll range, as before.
- **The clip box is white** where nothing covers it: under a burst of
  typing run past the last page before the pass that adds the page (the
  text was on the panel's white before; the panel has none now), and as
  the plain-text sheet. Under a burst it is paper run on from the last
  sheet: the clip path rounds its end like a page's, and the shadow is
  drawn round it (`paper-scale.ts` counts it as the last sheet's while
  `fitPaper` sees the editor past the stack). At first the shadow ended
  at the last sheet, and once the burst had the panel all white it went
  away altogether until the page came (the review's probe: hidden for a
  quarter second round the whole panel). In the page view `#pages`
  covers it in the frame's colour, which is what the gaps and the
  sheets' corner notches show.
- **Print and the PDF are untouched.** Typst knows nothing of the
  screen; `@media print` hides the shadow and the sheets and takes the
  clip path off the clip box, and `frame.spec` checks it.

Measured in a browser tab (the dev server, `--font-render-hinting=none`),
1100 × 800, eighteen paragraphs over four pages; the shadow's radius at
its top and bottom, and what answers one CSS px inside the panel's
corner:

| where the panel is | top corners | bottom corners | the shadow |
|---|---|---|---|
| at the top | rounded, cut away (the panel answers) | square (the paper answers) | the panel's box; 12 px, 0 |
| 6 px down | half the corner left, cut | square | 6 px, 0 |
| a gap across the middle | square | square | the panel's box; 0, 0 |
| a gap at the panel's top edge | (the gap) | square | from the next sheet's top, 3.9 px in; 12 px, 0 |
| a gap crossing the bottom edge, 0.12 px of the next sheet in | square | square | ends 7.75 px up (the sheet above ends 7.82 px up); 12 px, 11.88 px |
| the same, 6.12 px in | square | square | ends 6.77 px up; 12 px, 5.88 px |
| the same, 12.12 px in | square | square | the panel's box; 12 px, 0 |
| a burst of Enters at the end, the white past the last sheet in view | square | rounded, cut away (the clip path) | the panel's box to the white's end, 0.4 px up or less; 0, 11.6–12 px |
| at the end | square | rounded, cut away | 0, 11.94 px (the range ends 0.06 px short of the page) |
| 740 × 1000, one page | rounded, cut away | rounded; the page ends 57.6 px above the panel's bottom | ends at the page; 12 px all round |
| the plain-text view, a short text | rounded | rounded | the panel's box; 12 px all round |

The sheets' radius is 9.34 CSS px at 1100, 6.76 at 1500, 14.23 at 740
and 12 at 868: 12 px drawn at each. In the shell from the checkout
(claerbout main, this branch's `dist/`), two View-menu zoom steps take
the window from 1100 to 1320 px wide at a device pixel ratio of 2.4, the
page still 1100 CSS px: the corners stay 12 CSS px, scaled with the bar's
pills, and the clip still cuts them (claerbout main b19873e).

**The cost**, this branch against a copy of main, in the same tab:

| | main | this branch |
|---|---|---|
| 120 wheel steps through a 32-page paper (two runs): layouts | 2, 4 | 4, 4 |
| the same: layout time | 0.4, 0.7 ms | 0.5, 0.5 ms |
| the same: script time | 0.7, 0.6 ms | 4.4, 4.8 ms (the edge, about 0.04 ms a scroll event) |
| the same: passes | 0 | 0 |
| a keystroke on that paper at 868 (median of 80, four runs) | 4.8, 4.9, 8.4, 9.5 ms | 5.3, 6.2, 6.3, 7.9 ms |
| the same at 1500 | 5.1, 5.4, 5.9, 7.7 ms | 5.4, 6.4, 6.5, 6.6 ms |

(A keystroke here is keydown to the end of the task that handled its
input, the live pass included, on a 32-page paper, so larger than the
2–3 ms live pass quoted above.) The two are the same within the spread
between runs; without the clip path the keystroke measured 5.2–8.1 ms,
so the clip path costs nothing measurable either. Typing writes nothing
new: `fitPaper` runs before each scroll to the caret as before and only
compares two numbers more, and the sheets are handed over only when the
painter repaints them.

**Checks.** `frame.spec` has a new test, *the paper's corners are
rounded only where they are a sheet's*: with `document.elementFromPoint`
one CSS px inside each of the panel's corners (not the paper where the
corner is rounded and cut, the paper where it is square), the shadow's
box against the sheets in view and its computed corner radii, at the top,
6 px down, with a gap across the middle and at the top edge, at the end,
at 1500 and 868, on a one-page paper at 740 × 1000 (the page's own
bottom corners cut, the panel below it not the paper), and in the
plain-text view; and a scroll from the end that touches nothing on the
page but the shadow's style attribute and runs no pass. Without the
scroll listener it fails at the 6 px step. Two more beside it: *a page
gap crossing the panel's edge hands the shadow's end across it over a
corner's length*, which scrolls a px at a time across the second gap
at the panel's bottom and at its top, and checks that no px of scroll
moves the shadow's end by 2.5 px or its corner by 1.5, and that with a
fraction of a px of the sheet beyond the gap in view the shadow still
ends within a px of the sheet on this side, rounded; and *a burst of
typing past the last page is paper*, which presses Enter at the end of
the paper until the white past the last sheet fills the panel, and
checks in each frame that the shadow is drawn round the paper in view,
the white included, its bottom corners what is left in view of the
clip's. Both fail on the first version of this branch (the shadow 7.8
px off the sheet with 0.12 px of the next one in; 20.5 px short of the
white under a burst). The Zen frame test (renamed *a dark edge all
round one panel of paper, its sheets rounded*) now expects a square,
transparent, shadowless panel and sheets rounded 12 px on the screen;
the print test expects the shadow and the sheets gone and no clip path.
The smoke checks, in the shell, that the page's top corners are cut at
the top of the paper, that its bottom corners follow whether the page
runs past the panel, and that the shadow's corners agree.

**What is still open.**

1. **The sheets' corners at the gaps** are rounded (taken as yes: each
   sheet is a piece of paper). Square there, with only the outer corners
   rounded, would be one line (`.page-box` loses its radius).
2. **The shadow and the gaps.** The shadow is one box round the paper in
   view, so it runs down the panel's sides past a gap, and the gap is
   the frame's plain colour. A shadow per sheet, falling into the gaps
   too, would make each sheet float on its own; it would darken the gaps
   to near black and needs a box per sheet in view.
3. **The rim on a cut edge.** Zen's shadow has a white 5 % hairline round
   the box, kept on every side, so a cut edge (the panel's top, mid-paper)
   has a faint rim against the bar's band. Dropping it on cut edges
   would make a cut edge read as no edge at all.
4. **A short paper's HUD** sits on the frame below the last page, not on
   the paper.
5. **A burst of typing past the last page** shows the clip box's white
   below the last sheet, rounded at its bottom by the clip path and
   shadowed like a sheet, until the pass adds the page (a quarter second
   after the burst). Where the sheet meets the white, its own rounded
   bottom corners show two notches of the frame and a hairline seam runs
   between them; both go when the page comes.
6. **The zoom.** The corners are 12 CSS px, so a View-menu zoom scales
   them with everything else (14.4 screen px at two steps), as it scales
   the bar's pills and Knuth's room.

## The third pass

Taylor, running the merged Plass beside the merged Knuth: "plass looks
nice. i like the sidebar styling. we'll come back to layout of icons
and all that. but the topbar looks better in knuth, and i think
basically everything in knuth's topbar (at least the left side) can be
copied over. it's nice to have the address shown, and the vertical
height of the bar in knuth is better. then there's too much background
shown in plass. i basically just want the paper to sit edge to edge in
that elevated part, with none of the lighter grey behind the page."
And, clarifying: "the page should fill the whole elevated panel
according to its width. the width of the elevated panel is defined by
the width of the app window. so changing the app window width expands
the elevated panel, widening the page, effectively zooming in."

So two changes, and the rail untouched ("we'll come back to layout of
icons").

**The bar is Knuth's.** Copied as code from `knuth/src/main.ts` and
`knuth/src/styles.css`: the name pill is Knuth's `#doc-pod` with
`#file-name`, the save mark `#doc-mark` and the folder line
`#doc-folder`; its rules are Knuth's to the property (the pill's box and
colour, the name's face, the folder's type, how the folder gives way);
the bar's right padding is the frame's 8 px edge (it was 12); and
Knuth's `tilde()` puts a home folder as ~. What stayed Plass's: the File
tile's menu (Knuth's `menu.ts` is a port of it), the save dot's colours
(Knuth's are Plass's), renaming in place with the first save's folder
question, and Export beside the pill. The folder line is the file's
folder where the shell knows the path, else a project folder's name (a
tab working in a folder, as Knuth shows an attached folder's name), else
nothing: a tab with a bare file shows the name alone. Plass keeps files
by handle and a handle has no path, so the path is the shell's: the page
already reported its file to the shell for the autosave record
(`reportDocument`, `src/claerbout.ts`), and the shell answers that
report with the path it took or matched; `reportDocument` now resolves
to that answer, `main.ts` keeps it, and the bar shows its folder. A
narrow bar drops the folder at Knuth's 760 px, through a container query
on the bar rather than a media query (below, *The resize cost*).

Knuth's bar, measured in the shell checkout (claerbout main 6ef9af3,
knuth main a1703f5, a 1100 × 800 window, `CLAERBOUT_APP=app/knuth.json`,
a throwaway `KNUTH_CONFIG_DIR`), against Plass's before and after (the
heights and sizes since replaced by Knuth's 44 px bar, below):

| | Knuth | Plass before | Plass now |
|---|---|---|---|
| bar height at rest | 60 px (the lights' band) | 60 | 60 |
| bar height, one zoom step (×1.095) | 55 px | 55 | 55 |
| File tile | 36 × 36 at (112, 12), 20 px glyph | same | same |
| name pill | 42 px tall at y 9, 12 px radius, #232326, 1 px white 8 % hairline, 12 px padding, 9 px gaps | same | same |
| pill's widest | min(560 px, 50vw): 550 at 1100 | min(420 px, 45vw) | Knuth's |
| name | 15/22.5 px STIX Two Text, 1.35 px tracking, white 80 % | New Computer Modern | Knuth's |
| folder | 12/18 px system sans, white-ish 55 %, cut from its start | none | Knuth's |
| bar's padding | 12 px past the lights (112), 8 px at the right | 12 at the right | Knuth's |
| between items | 6 px | 6 | 6 |

The heights were already one. Knuth's `npm run app` runs the shell its
package pins, tag v0.2.0, which ignores `titleBarStyle`: there Knuth has
a native title bar above a 60 px bar whose File tile stands over the
rail's column. Plass's `npm run app` runs the claerbout checkout beside
it, where the bar is the window's title bar with the lights in it. So
the bars Taylor compared were in two shells (open, below).

**The panel is the paper.** One elevated panel: from the rail's tiles
plus the frame's 8 px (x 48; x 44 since the rail's 6 px, below) to 8 px
short of the window's right edge, from the bar's band (9 px under the
pill) to 8 px above the window's bottom, rounded 12 px at all four
corners, the paper's white, its shadow on the frame — Knuth's room's
box, to the pixel. ("From the rail's right edge plus 8 px … under the
bar plus 8 px" is read with the rail's own 8 px padding and the band's 9
px under the pill as that edge: taken past the rail element and the bar
element, the frame would show 16 px beside the tiles and 17 under the
pill, against "the frame shows only as that 8 px edge all round", and
the panel would sit off Knuth's.) The pages fill its width edge to edge
and stack down it with a thin line of the frame between them; the panel
clips them and scrolls, drawing no scrollbar (the rail's groups draw
none either); the page count and words sit in its bottom-right corner,
10 px in, a quiet frosted chip.

The page fills the panel **by scaling, never by re-flowing**. The layout
is still the page's own width, 816 CSS px for Letter, and
`src/paper-scale.ts` draws it at the panel's width with a transform on
`#stack`: `scale(panel width / 816)` from its top-left corner (1.284 at
1100, 1.775 at 1500, 0.843 at 740, with the 44 px rail). Around the
stack, `#paper` is a clip box whose height is the stack's times the
scale, so the panel scrolls exactly the drawn pages and never sideways.
One ResizeObserver on the panel and the stack writes the scale and that
height, and keeps the line at the panel's top where it was; a transform
resizes no box, so the writes cannot loop. No CSS zoom, no layout, no
pagination pass: the editor's width in CSS px never changes, and the
layout scheduler, which watches that width, never wakes. The page gap is
6 CSS px (was 28, when the sheets floated in a room): 7.7 screen px at
1100, 10.6 at 1500, 5 at 740, about the frame's edge.

What the transform asks of the code: every client rect under it is the
drawn one, scaled. ProseMirror reads `getBoundingClientRect`, which
honours transforms, so a click, a drag-selection, its scrolling into
view, the popups placed at the caret (math, references, raw Typst), the
toolbars docked to the window and CodeMirror in the plain-text view
need nothing. The layout's own reads do: the typeset plugin measures
text runs, block widths, spacer heights and positions off the page in
CSS px. Those reads go through `atPaperSize`, which sets the transform
to `scale(1)` for the length of a synchronous read and puts it back
before the frame paints, so a pass reads exactly what it read when the
paper was a column at 1:1, bit for bit: both scheduler callbacks, the
suffix verification, the solution rules, `printPageAt`, the environment
check, the audit and the atom hook; the table view's column measure and
its atoms' observer; the grid cell's fit; the table break's header
offset. Dividing each read by the scale was the other way: about twenty
edits inside the layout code, each a place to get wrong, and float noise
in every recovered coordinate (a client rect is single precision, and
scale × y is rounded where y alone was exact), against a dozen wrap
points and exact numbers. One read changed instead of wrapping: the
caret's ArrowUp/Down probes (`src/editing.ts`) are client coordinates,
so they step by the drawn line pitch. The plain-text sheet sits in the
stack too and scales with it.

**The window is the zoom.** `followZoom` stays in `app/plass.json`, and
the page's scale follows the panel's width in CSS px under it as at any
other time: a View menu zoom step the shell answers by scaling the
window is a wider window, the same CSS width, so the same CSS scale and
a page larger on the screen with the chrome; at the display's edge the
window grows less (measured: at 1500 × 900 a step left it 1470 × 923)
and the page is drawn at a smaller CSS scale, still filling the panel
(1.576). A tab and the PWA scale the same way.

**The room or the paper** (the second pass's first open question):
the paper. The panel is the paper's white, the sheets are bare (no
shadow, no rounded corners: the panel rounds the outer ones), and the
grey room is gone. `--bg` went with it. (Since replaced: the panel is a
square window and each sheet has its corners, above, *The paper's
corners*.)

**The resize cost**, 1100 → 1500 → 1100:

| | passes | the scale drawn | longest frame |
|---|---|---|---|
| tab, the dev server, 11 pages (`__pagCount`) | 0, 0 | in the first frame after the resize event (15 ms) | 17.7 ms, no long tasks |
| Plass.app from the checkout, 1 page (the HUD's title, which every pass writes) | 0, 0 | 7–17 ms after the resize event | 17.5–17.8 ms |
| main's build, the same resize in the app | 0, 0 | — | 17.5–17.8 ms |

One first grow out of five in the app showed a 117 ms frame; main's two
runs showed none, and four later runs of this build did not repeat it.
Typing is unchanged: the live pass is about 2 ms at 1:1, 1.28 and 1.77,
the same as main's at 1100. The first measurements found a pass after
all, only across 760 px: Knuth's `@media (max-width: 759px)` sat in
`style.css` beside the `@font-face` rules, and a media query that flips
makes Chromium re-read that sheet, the faces load again, and the layout
scheduler settles the page for the fonts. The production build bundles
every stylesheet into one, so the bar's older 540 px query did the same
there. Both are container queries on the bar now, and the built
stylesheet has no width media query left.

**Checks added.** `frame.spec` is rewritten for the panel: its box
against the window and Knuth's room's; the page meeting the panel edge
to edge with its scale equal to panel width / 816 at 1100, 1500 and 740,
and not one pass, the same breaks and the place kept across them; the
same layout, every spacer, folio, footnote, solution rule, table column
and grid cell, laid out afresh at 868 (1:1), 1500 and 740 (with the
brackets turned off this fails at 1500); the frame's colours, the bare
sheets, the gap in the frame's colour and its drawn width, the HUD in
the corner; the bar's measurements equal to Knuth's; the folder from a
project folder in a tab, and from the shell's answer in Plass.app, with
~, giving way first; at 1.77× a click, a drag-selection, ArrowDown, the
table toolbar, the figure's toolbar, an image drop and the bibliography
editor; print at the page's own size. The suite's default window is 868
× 720 (`playwright.config.ts`; 872 with the 48 px rail): the width at
which the drawn page is the laid-out page, so the layout tests read the
page in the layout's px as they always have, and `frame.spec` covers the
other widths. The smoke (`app/smoke.mjs`) checks the page filling the
panel at rest, wider and zoomed, no pass across the drag and the zoom
(the HUD's title), the panel's box and white, the bar's measurements
against Knuth's, and the folder from the shell.

### The bar as tall as the rail is wide (the same afternoon)

Taylor, running the merged apps: the bars "seem taller than they were
originally", and the height they liked is the panes mockup's, "equal in
height to the width of the sidebar". Knuth took it first (knuth
c6875a4, "The bar as tall as the rail is wide"), and Plass takes the
same numbers: the bar 44 px (`--topbar: env(titlebar-area-height,
44px)`), the rail 44 px (a 32 px tile with 6 px either side,
`--rail-gap`; the panel's edge at the window's right and bottom stays
8 px, and the panel still starts at the bar's bottom), the name pill
30 px tall with 9 px corners and 10 px padding, the bar's tiles (File,
Export) 32 px with 9 px corners and 18 px glyphs, and the traffic lights
at {x: 14, y: 15} in `app/plass.json`, so their band is the bar
(2·15 + 14 = 44). The 60 px bar was the old toolbar's height, which as
a solid band with no title bar above it read heavier than the glass had.

Both apps in the same shell (claerbout main b19873e, knuth main
2d5fc68, which has c6875a4's numbers, Plass from this branch), 1100 ×
800, each on a document in `~/Projects/week-3`:

| | Knuth | Plass |
|---|---|---|
| lights' room | x 88, 44 tall | x 88, 44 tall |
| bar | 44 px, padded 100 px (the room + 12) and 8 px, 6 px gaps | same |
| File tile | 32 × 32 at (100, 6), 9 px corners, 18 px glyph | same |
| name pill | 30 tall at (138, 7), 9 px corners, 10 px padding, 9 px gaps, #232326, widest 550 | same |
| name | 15 px STIX Two Text, 1.35 px tracking, at x 149 | same |
| folder | `~/Projects/week-3`, 12 px, y 13, 103.09 px wide | same |
| the right of the pill | the status pill, 30 tall at y 7, 9 px corners, ending at the room's right (1092) | Export, 32 × 32 at y 6, 9 px corners, 18 px glyph, 6 px past the pill |
| rail | 44 wide from y 44, its tiles 32 px at x 6 | same |
| room / panel | (44, 44), 1048 × 748 | same |

The same at 1500. The pills differ in width by their names alone
(notes.py, draft).

**The view holds still.** A pass takes the paper's transform off and
puts it back (`atPaperSize`), and at any scale but 1 Chromium's scroll
anchoring answered that by scrolling the panel by itself a beat after
typing (the reviewers: Enter ×14 mid-document at 1500 px, then 272 px of
scroll and the caret 272 px higher). And where Enters carry the caret's
line over a page break, the pass moved it down past the panel's bottom
(414 px at 1500; main does that too, 252 px at 1:1). The panel has
`overflow-anchor: none` now, and the view is held by `paperPass`
(`src/paper-scale.ts`), round both of the scheduler's passes: when the
caret is being followed (ProseMirror scrolled it into view since it last
moved: a keystroke, an arrow, a command, not a click or a load) and is
in the panel's view, the panel scrolls by however far the pass moved it,
once, so it is at the same place on the screen after the pass, to under
a pixel, at 1500, 1100 and 868. Nothing else is anchored: the pages hold
their content still on their own (a page's spacer takes up what its
lines gain or lose), so a pass moves nothing in view but the lines that
cross a break, and a first-visible-line anchor would hold a stale place
against a pass that puts it right. An edit that is not at the caret
(none in Plass's own use; a test inserting three paragraphs above the
view) moves the text down by what it inserted (231 px at 1100); on main
the anchoring held it through the insertion and the pass then moved it
237–259 px the other way, so neither held, and this is accepted.

Typing at the end of a long paper had a second fault behind the first:
the clip box round the drawn pages had the pages' height, so a burst of
Enters past the last page, before the pass that adds one, ran the caret
under the clip, out of reach, and the pass then left it there (2276 px
down in an 892 px panel). The clip now takes the editor's height while
it runs past the stack (`fitPaper`), and before ProseMirror scrolls the
caret into view (the typeset plugin's `handleScrollToSelection`), so
the caret stays on screen through the burst and the pass that adds the
page holds it. `frame.spec` types each case at 1500: Enter ×14
mid-page, Enters over a page break, a burst past the last page; on the
code before this change it fails at the first (the caret 414 px off).

**The browser tab.** Under a 540 px bar (a phone-width tab) every name
lost its last 3 px to an ellipsis: the name's cap kept the pill's 9 px
gap while the narrow bar closes it to 6, so the cap follows the pill's
gap now (`--pod-gap`). A tab working in a project folder **keeps the
folder line** (decided: it mirrors Knuth, whose bar shows an attached
folder's name; the brief's "a tab shows the name alone" is now a tab
with a bare file), and `frame.spec` expects it so.

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
- **The name pill** — Knuth's (the third pass): the document's name, its
  save dot (red unsaved, green saved) and the folder it lives in (home
  as ~; in a tab, a project folder's name or nothing), 42 px, Zen's
  address pill; click, Enter or Space renames in place, and an unsaved
  paper's first commit saves and asks for a folder, as before.
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

**The panel** (the third pass): one panel edged by the frame (above),
and it is the paper — the pages, laid out at 816 px, drawn at its width,
edge to edge, a thin line of the frame between them, its corners
rounded only where they are a sheet's (*The paper's corners*). The
plain-text sheet is drawn the same way. The toast, the table toolbar
and the image toolbar sit on the panel's axis (`--axis`, from `--rail`
and `--edge`; the panel draws no scrollbar, so `--room-scrollbar` is
gone); the HUD sits in its bottom-right corner. Print hides the rail
with the bar and prints the page at its own size.

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

1. ~~**The bar's height.**~~ DECIDED: 44 px, as tall as the rail is
   wide, in both apps (above, *The bar as tall as the rail is wide*).
2. **No scrollbar in the panel.** The paper runs to the panel's right
   edge, so there is nowhere for a gutter; the wheel and the keys scroll
   and the HUD counts pages. A thin thumb laid over the paper's right
   margin, drawn on scroll, is the next step if one is wanted.
3. **Very wide windows.** The page is drawn at panel width / 816 with no
   cap: 2.3× in a 1920 px window, 3.1× at 2560. "Effectively zooming in"
   is read as no cap.
4. **The page gap scales.** 6 CSS px, 5–11 screen px from the narrowest
   window to the widest. A gap fixed in screen px would change the
   layout's page stride with the window, which is a re-layout.
5. ~~**The folder in a tab.**~~ DECIDED: kept. A tab working in a
   project folder shows the folder's name, as Knuth's does; a tab with a
   bare file shows the name alone.
6. **The plain-text view scales too**, being in the same stack: at 1500
   its text is drawn 1.77×. Consistent with "the window is the zoom";
   it could keep a fixed size instead.
7. ~~**Scroll anchoring.**~~ FIXED: it did show (the reviewers measured
   the panel scrolling by itself after typing at 1.28× and 1.77×);
   Chromium's anchoring is off on the panel and a pass holds a followed
   caret (above).
8. **The File menu's focus.** Knuth's menu hands the focus back to where
   it was when it opened (the cell being typed in); Plass's hands it to
   the tile, as `toolbar.spec` pins. Not copied.
9. **Knuth's room.** Knuth keeps its grey room round a centred column;
   if the two apps are one system, its cells may want the same panel.
10. **The frame's shade (the rail is 44 now), Alignment on the rail,
    the rail as a drag region, 'File' or 'Open', the Insert ▸ glyph**:
    as the second pass left them.
11. **The glass over the paper.** Every menu now opens over the white
    paper, so the step at the paper's edge is gone; the glass reads
    #28272b there (94 % opaque), a shade lighter than over the frame.
12. **The record's screenshots** are page captures without the traffic
    lights. (Retaken on documents in `~/Projects/week-3`: the folder
    line reads as it would for a real project.)
13. **The paper's corners**: the gaps' corners, a shadow per sheet, the
    rim on a cut edge, a short paper's HUD and the zoom are open in that
    section (above).

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

## Checks (third pass)

- `npm test`: green (with `reportDocument`'s answer: the matched path,
  null for no match, a non-path, a failing bridge and a tab).
- `npm run build` (the sidecar, unused-code, exports and cycle checks,
  tsc, vite): green; the built stylesheet keeps both container queries
  and has no width media query.
- `CI=1 npx playwright test --project=chromium`: 178 passed.
- `node app/smoke.mjs` (the shell checkout beside the main one, on main
  with the title-bar option, follow-zoom and the autosave record): ok,
  five runs in a row. Its first form failed one run in three with two
  "passes": the edit's own settled pass, 250 ms after the last key,
  landing after the counter was set; it now waits for a quiet second
  before counting.

## Checks (third pass, the 44 px bar and the held view)

- `npm test`: green. `npm run build`: green; the built stylesheet keeps
  its two container queries and no width media query.
- `CI=1 npx playwright test --project=chromium`: 179 passed. New and
  changed: `frame.spec`'s bar at Knuth's 44 px numbers, the 44 px rail
  and the panel from x 44, the 1:1 width 868, names whole at 480 px, and
  the caret held through Enter ×14 mid-page, Enters over a page break
  and a burst past the last page, at 1500.
- `node app/smoke.mjs`: ok, four runs, with the bar checked at 44 px,
  the File tile 32 px 6 px down and the pill 30 px 7 px down, against
  the lights' band.
- Both apps measured in the same shell at 1100 and 1500 (above): the
  bars agree to the pixel.

## Checks (the paper's corners)

- `npm test`: green. `npm run build` (the sidecar, unused-code, exports
  and cycle checks, tsc, vite): green; the built stylesheet keeps the
  clip path, the `:has()` rule and the sheets' `calc()` radius as
  written, and still has no width media query.
- `CI=1 npx playwright test --project=chromium` (on a spare port): 185
  passed; 187 after the review's fixes (the gap hand-over and the
  burst's shadow, two new tests in `frame.spec`).
- `node app/smoke.mjs` (the shell checkout beside the main one): ok, with
  the paper's corners checked.
