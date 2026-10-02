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
scroll rail (branch `ux/rail`, the same evening) maps the paper in a
20 px gutter of the frame at the window's right (below, *The scroll
rail*; its record is `docs/zen-rail-1100.png` and
`docs/zen-rail-1500.png`). Run
it from the worktree with `npm run app` (after `npx vite build`); the
record is `docs/zen-draft-1100.png` and `docs/zen-draft-1500.png`, the
shell from the checkout at 1100 and 1500 px wide, and
`docs/zen-knuth-1100.png`, Knuth in the same shell at 1100, for the
bars, each on a document in `~/Projects/week-3` (page captures: the
traffic lights are the window's own and are not in them —
`screencapture` of the window needs a screen-recording grant this
session does not have; their room is the empty 88 px at the bar's left,
which the File tile sits 12 px past).

## The scroll rail

Taylor, after asking that the paper show its true corners: "and then
maybe there's a scrollbar much like the history git page with points on
it indicating the parts of the page and page breaks and such." Earlier,
of the history view: "i like that scroll bar with the added detail
vertically for the nodes." Three designers each built a mockup and two
judges scored them (`docs/mockups/scroll-rail.md`); both judges
recommended the outline mockup's resting rail, on the paper's right
margin, and ranked the gutter second and last. Shown the three
mockups' screenshots, Taylor: "i think i like gutter-hover.png the
most." So this is the gutter mockup (`docs/mockups/scroll-rail-gutter.html`),
ported: its DOM, CSS and script, in `src/scroll-rail.ts` with its CSS
beside the HUD's in `src/style.css`.

**What was built.** While a paper of two sheets or more runs past the
panel in the page view, the frame's right edge widens from 8 px to a
20 px gutter, and the rail lives in it, on the dark frame and outside
the paper, as the history strip lives beside its river. The panel keeps
its left, top and bottom edges and is 12 px narrower; the paper fills it
by the usual rule. The rail stands for the whole paper, its track
exactly the panel's height (the bar's bottom to the frame's edge above
the window's bottom), so at the top of the paper the band's top is level
with the panel's top and at the end its bottom is level with the
panel's bottom. On it, in light marks on the dark:

- a hairline across the rail at the middle of each page gap, the
  page's number faint under it, thinned on a long paper (every 2nd,
  5th, 10th … page) so the shown numbers stay 16 px apart, and a number
  giving way to a heading, figure or table that falls just under its
  hairline; the gap that is on screen draws a longer, stronger tick
  (from the edge mockup);
- headings as dots sized by level (the title 7 px, a section 5, a
  subsection 3), figures as tiny filled squares and tables as open
  ones;
- the caret as a short bar in the focus blue, the one coloured mark;
- the visible span as a lighter rounded band, and the marks outside it
  a step quieter.

The marks are there at rest, at the mockup's awake values: the one
change from the mockup, which both judges asked for (the history strip's
nodes are always there; the mockup showed them only with the pointer
near). The band brightens while the pointer is in the gutter and for
0.9 s after the paper moves.

The pointer: the nearest mark within 7 px either side, across the
gutter's whole width, grows and turns white, and one dark-glass label
hangs to the rail's left over the paper's margin — the section number,
the heading's own words in the bar's serif, "p. 3"; "Page 3 of 5" on a
break; over empty track a faint line where a click would land, with its
page — held inside the window at the track's ends. A click jumps (a
heading, figure, table or the caret to an eighth of the way down the
panel, a break to its sheet's top at the panel's top, empty track to
that point in the panel's middle); a press that drags scrubs the band by
the drag, from wherever it was pressed, and jumps nothing (the mockup
centred empty track on the press; a drag from there now moves the band
from where it is); the wheel over the gutter scrolls the paper, in
lines or pages as it came. The keyboard: one tab stop, Up and Down,
Home and End between the marks with the label following, Return or
Space jumps. A press that began on the text (a selection dragged toward
the edge) wakes nothing on the rail, and a gutter due under a held
button waits for the release.

**The mechanism.** The marks come from the settled layout pass: main.ts
hands each settled pass's pages to the rail (the typeset plugin now
says which `onPages` calls are settled; a keystroke in an editorial
note republishes the sheets unsettled and the rail waits), and in the
next frame the rail reads the sheets' tops from the pass and the
headings', figures' and tables' from `offsetTop`, which is layout and so
in the page's own 816 px, never divided by the scale. Each mark is a
fraction of the stack's height, written once as `--f` and placed by CSS,
so a resize or a zoom moves no mark, only the band. A scroll writes two
custom properties on the rail in a frame, the visible span's top and
bottom as fractions; CSS draws the band from them and works out, for
each mark and gap, whether it is inside the band (the quieter marks and
the stronger on-screen tick). The caret's bar moves at the settle and,
in a frame, when the selection moves without an edit (a click, an
arrow); typing writes nothing to the rail. The label is fixed to the
window, its right edge 7 px left of the gutter, its middle level with
the mark and clamped inside the window. The gutter is the `has-rail`
class on the root, which sets `--edge-right` (split out of `--edge` as
the one right-margin variable: the panel, the HUD and `--axis`, so the
toast and the table and image toolbars, read it); it is asked for at
each settle, resize and view switch, and whether the paper runs past is
asked at the gutter's width whether or not the gutter is showing, so
its own 12 px can never take it away again. It comes and goes at once,
not animated: an animated edge would redraw the whole page at a new
scale on every frame. The window's bottom edge stays 8 px and the
rail's side 6 px; print and the PDF export are untouched (the rail is
hidden in print, where the panel has no margin).

| | no gutter (main's numbers) | with the gutter |
|---|---|---|
| the frame at the panel's right | 8 px | 20 px |
| the panel at 1100 × 800 | (44, 44) to (1092, 792), 1048 × 748 | (44, 44) to (1080, 792), 1036 × 748 |
| the page's scale at 868 | 1.0000 | 0.9853 (804 / 816) |
| at 1100 | 1.2843 | 1.2696 (about 1 % smaller) |
| at 1500 | 1.7745 | 1.7598 |

The rail: 20 px wide, its track the panel's height (748 px at 800). The
band 14 px wide (3 px in from each side), 4 px corners, at least 10 px
tall, white 3.5 % over a 8 % edge at rest, 7.5 / 17 % lit, 11 / 24 %
dragged. A break 12 × 1 px at white 17 %, on screen 16 px at 36 %,
hovered 60 %; its number 8 px sans at rgba(240, 238, 233, .40), 3 px
under it. Dots 7, 5 and 3 px at .86, .72 and .56; squares 5 px, a
figure filled at .60, a table a 1.2 px line at .70; the caret 8 × 2 px
#9db8d6; outside the band the marks at 60 %. The label: the menus' dark
glass, rgba(27, 26, 30, .94) with a 10 % white hairline and 6 px
corners, the heading 13 px STIX Two Text, its number 11 px sans at 50 %,
its page 10.5 px at 42 %, at most 360 px or half the window wide.

**The trade accepted.** The judges' objection to the gutter was that it
takes paper width (the page about 1 % smaller: 1.270 against 1.284 at
1100), makes the frame uneven (6 px beside the tiles, 8 at the bottom,
20 at the right) against "an edge of the black all the way around", and
ends the match with Knuth's room, so the HUD, the toast, `--axis`, the
table toolbar, `frame.spec` and the smoke test all needed new numbers.
Taylor chose it having seen the narrower page, and it is accepted as
the price of a rail that lives on the frame, outside the paper. Two
things limit it: the gutter is there only while it has something to
map (a one-page note, a paper that fits and the source view keep the
8 px edge, and the page main's scale), and the marks at rest answer the
judges' other point, that the empty gutter read as a reserved
scrollbar track. One cost the record did not name: a note that grows
to a second sheet gets the gutter at that settle, so the page is drawn
1 % smaller under the caret once (the line at the panel's top holds
still, as on any resize; a caret near the panel's bottom moves up a few
px), and back if it shrinks to one sheet again.

**Knuth** keeps its 8 px edge. The two apps no longer claim the same
panel box: Plass's matches Knuth's room only with no gutter (a one-page
note, the source view). Knuth has no rail; if it wants one, the gutter
and the module are the place to start.

**Typing.** Unchanged: the rail writes nothing on a keystroke (a
mutation observer over the page counted no rail writes in sixty keys but
the band's, on the three scrolls ProseMirror made). A/B against main on
a 29-page numbered paper at 1100, sixty keys at the end of a paragraph
mid-document, medians of six alternated runs on a machine other agents
were loading: in one set the live pass took 2.1 ms on main and 2.6 with
the rail, the main thread 9.8 and 11.3 ms a key; in the next, with the
rail hidden as a control, 1.6, 1.2 and 1.2 ms and 7.8, 5.7 and 5.4 ms
(main, rail, rail hidden). The differences change sign between sets:
noise, and the record's 2–3 ms a keystroke stands.

**Open.** The unrolling outline (the outline mockup's contents view) is
left for later, as something opened on purpose (a click or a key) once
it can drop subsections on a long paper, as both judges said. On a long
paper whose pages mostly open with a heading, the crowding rule hides
most page numbers (Judge 1's 30-page note); the label still gives every
page. The rail counts sheets, as the HUD does: "Page 3 of 5" is the
third sheet even where the folio is roman front matter or restarts.

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
grey room is gone. `--bg` went with it.

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

**The panel** (the third pass): one rounded panel edged by the frame
(above), and it is the paper — the pages, laid out at 816 px, drawn at
its width, edge to edge, a thin line of the frame between them. The
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
2. ~~**No scrollbar in the panel.**~~ BUILT: the scroll rail, in a
   20 px gutter at the window's right while a paper runs past the panel
   (above, *The scroll rail*). The unrolling outline is still open.
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
   Knuth keeps its 8 px edge at the right; with the scroll rail's
   gutter, Plass's panel no longer claims Knuth's box (above).
10. **The frame's shade (the rail is 44 now), Alignment on the rail,
    the rail as a drag region, 'File' or 'Open', the Insert ▸ glyph**:
    as the second pass left them.
11. **The glass over the paper.** Every menu now opens over the white
    paper, so the step at the paper's edge is gone; the glass reads
    #28272b there (94 % opaque), a shade lighter than over the frame.
12. **The record's screenshots** are page captures without the traffic
    lights. (Retaken on documents in `~/Projects/week-3`: the folder
    line reads as it would for a real project.)

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

## Checks (the scroll rail)

- `npm test`: green. `npm run build` (the sidecar, unused-code, exports
  and cycle checks, tsc, vite): green.
- `CI=1 npx playwright test --project=chromium` (on a spare port): 193 passed. New:
  `tests/rail.spec.ts` (nine tests: the gutter and rail only for a
  paper of two sheets or more that runs past the panel, none for a
  one-page note, in the source view or in print, the 8 px edge back;
  the panel's box and the scale with the gutter and without at 868,
  1100 and 1500; every mark and page gap at its layout offset over the
  stack's height, to under a pixel, and unmoved by a resize; the caret's
  bar following a click; the label for a heading, a break and empty
  track, inside the window at the track's ends; a click on a break and
  on a heading; a 100 px drag moving the paper 100 / 748 of its height
  and jumping nothing; the wheel; the band against the scroll; the
  keyboard; a selection dragged into the gutter opening nothing and a
  gutter due under a held button waiting for the release; the numbers
  thinning on a thirty-page paper). Changed: `frame.spec` at the gutter's
  numbers; `table-pagination.spec`'s break test reads its two-page
  paper's rects at the drawn scale (804 / 816 at 868 now), where it had
  assumed 1:1.
- `node app/smoke.mjs` (the shell checkout beside the main one): ok. Its document now runs to two sheets,
  and it checks the panel's right edge at the 20 px gutter and the rail
  in the gutter beside the panel with its page breaks.
- The record: `docs/zen-rail-1100.png` (mid-paper, the pointer on the
  3.1 mark with its label) and `docs/zen-rail-1500.png` (at rest), the
  shell checkout's Electron launched as `app/run.mjs` does, on a paper
  under `~/Projects/week-3` (a symlink for the captures, removed after),
  taken with the window's own capture: Playwright's page capture
  overrides the viewport for a moment, and the panel's scroll does not
  survive that.
