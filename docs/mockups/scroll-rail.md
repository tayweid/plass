# The scroll rail: a design round, 2026-10-02 (afternoon)

Taylor, after asking that the paper show its true corners: "and then maybe
there's a scrollbar much like the history git page with points on it
indicating the parts of the page and page breaks and such." Earlier, of the
history view: "i like that scroll bar with the added detail vertically for
the nodes."

Three designers each built an interactive mockup (open them in a browser;
the panel scrolls, the rail tracks it, marks are hoverable, clicks jump),
and two judges scored them 1–10 on fidelity to Taylor's words, Zen-ness,
legibility at 1100 and buildability in Plass. The files are beside this
record: `scroll-rail-<key>.html` with `-rest`, `-hover` and `-end`
screenshots at 1100 × 760.

| key | angle |
|---|---|
| gutter | the rail in a 20 px gutter of the frame at the window's right, outside the paper, light marks on dark |
| edge | a 3–4 px strip over the paper's right edge, hidden at rest, widening on hover |
| outline | a 16 px rail on the paper's right margin, always on, that unrolls into the outline on hover |

## Scores


**Judge 1** ranked outline, gutter, edge.

| key | fidelity | zen | legibility | buildability |
|---|---|---|---|---|
| outline | 8 | 7 | 8 | 6 |
| gutter | 7 | 6 | 7 | 6 |
| edge | 5 | 7 | 6 | 7 |

- *outline*: At rest this is the history strip moved onto the paper. It is 16 px wide, 4 px inside the panel's right edge, on the page's right margin, so it costs no paper width. Every mark is always on, in the frame's ink: break hairlines, 5 and 3 px heading dots, hollow squares for floats, the blue caret tick, and a capsule for the visible span. It is the only one of the three whose points are there without hovering, which is what Taylor praised in the history strip. Shapes tell breaks from headings from floats at a glance at 1100 and 2x. The capsule (white fill .045, ring .13 on white paper) is the faintest part. Measured: no console errors and no sideways scroll at 740, 1100 and 1500. A 100 px capsule drag moved exactly as expected (1000 to 2032, expected 2032). A heading click lands its text about 40 px under the panel's top. The weak part is the hover: a 264 px dark-glass table of contents. It covers about 38 % of the 688 px panel at 740 and the right 120 px of the text column at 1100. At 30 pages (the paper repeated six times, in memory) the dodge clamps the list to the glass, and the title, 1 Introduction, 2 Data and 2.1 are pushed off the top and clipped. Page breaks get no hover label of their own; page numbers sit in the glass's left column instead. Build: a sibling of #hud, marks placed by a CSS --f fraction so a resize runs no script, and one requestAnimationFrame (rAF) write per scroll, all good. The glass, with its dodge, SVG leaders and clamping, is most of the code and the part that fails at length. My comparison sheets: docs/mockups/judge1-rails-close-1100.png, judge1-rails-30-pages-1100.png, judge1-rails-740.png.
- *gutter*: This one looks most like the history strip: light marks on the dark frame in a 20 px column, a rounded band for the view, and drag to travel. It adds the best labels of the three: section number, the heading in 13 px STIX and its page, 'Page 3 of 5' on a break, and a faint line with its page over empty track. It also puts faint page numbers under each break hairline, a direct answer to 'page breaks and such'. But at rest it shows only the hairlines and a band at 3.5 % white. The dots, squares and numbers appear only when the pointer comes within 36 px, so the always-visible points Taylor liked are missing (its designer says showing them is a one-line change). Cost: the panel loses 12 px of width (scale 1.284 to 1.270 at 1100). The frame becomes 6 px beside the tiles, 8 at the bottom and 20 at the right, against 'an edge of the black all the way around'. Knuth's matching room box breaks, and the frame.spec and smoke-test numbers need changing. --axis, the HUD and the toast need a new right-edge variable. Measured: drag exact (1000 to 1950, expected 1951), no errors, no sideways scroll. A figure's label is 360 px wide and covers text at 1100. At 30 pages the rest state is a ladder of 30 hairlines, and the crowding rule hides every page number when awake. Build: placement by offsetTop in the stack's own px, as a percentage of the track, is the cleanest positioning of the three (no division by the scale, nothing moves on resize). The scroll handler is not rAF'd and toggles a class on every mark on every scroll event. That is cheap at 20 marks but wants a rAF.
- *edge*: At rest it is bare paper on purpose, so there are no points until you scroll or hover. That is the opposite of the history strip, which is always on. While scrolling it is a 4 px strip of 1.5 to 4 px specks and a 1 px light core, legible only if you stare. On hover it widens to a 14 px dark capsule over the white paper. That state is legible (ringed dots, boxes for the figure and table, dark cuts at page gaps, a lit window). But a dark pill on white reads more like a dark-mode overlay scrollbar than like Zen's frame. The gap that cuts the thumb at the same fraction as the real gap crosses the panel is clever, but nobody will see it at a glance. Labels match the gutter's style but carry no section numbers. Real defect: a press within 6 px of any mark jumps to it instead of grabbing the thumb, and the thumb always holds the marks in view. At scroll 1000 the thumb's middle was 0.6 px from a break tick, so a 100 px drag moved 350 px instead of 1,029. The thumb has no minimum height (11.5 px at 30 pages), and at 30 pages the wide state becomes a solid column of rings. Build: the simplest to drop into src. It is one fixed element beside #hud, fed with layout-px marks by a settled pass, re-placed by a ResizeObserver on the track, with rAF on scroll. It costs no paper width and keeps the HUD's corner.

**Judge 2** ranked outline, edge, gutter.

| key | fidelity | zen | legibility | buildability |
|---|---|---|---|---|
| outline | 8 | 7 | 8 | 6.5 |
| edge | 5 | 6 | 6 | 7 |
| gutter | 7 | 4 | 6.5 | 5 |

- *outline*: This one is closest to the history strip Taylor liked. It is the same 16 px strip hugging the panel's right edge (#mini sits 7 px in from its room's edge; this sits 4 px in). It is always on, with a hairline per page break, dots sized by heading level, open squares for figures and tables, a blue caret tick and a soft capsule for the visible span. It reads as an index strip, not a browser scrollbar, and takes no paper width. The edge, the scale, frame.spec and Knuth parity all stay as they are. Rest marks were legible at 1100 in my crops, and marks inside the capsule are inked darker, so the span reads even though the capsule itself is faint. Checks at 1100 and 1500: a click lands the heading text about 40 px under the panel's top, the wheel over the rail scrolls the paper, and there were no errors or sideways scroll. Marks are placed as CSS fractions (--f), reading offsetTop inside #stack in layout px, with one rAF per scroll, so it drops in beside #hud with nothing on resize or zoom. The weak part is the unrolling outline. It opens on a 120 ms hover and covers 264 px of text, more than a third of the panel at 740. In my test, dragging a text selection toward the right edge opened it over the text being selected. Its proportional label layout breaks down past about 30 pages, which the designer admits. Smaller problems: a click in the 16 px strip in the margin navigates instead of placing the caret, the wheel ignores deltaMode, and it does not hide when the document fits.
- *edge*: This one keeps the paper's width and frame intact, and its code is the smallest: one fixed element, marks in layout px that are re-placed on resize. The neat idea is that a page gap in view cuts the thumb at the same fraction where the real gap crosses the panel. But the paper is bare at rest, so the visible nodes, the thing Taylor liked in the history strip, show only while scrolling or hovering. Thin, it looks like a macOS overlay scrollbar, which is the browser-scrollbar look the brief rules out: a dark thumb with a light core. Wide, it becomes a heavy dark pill with white-ringed dots on the paper. Figures and tables are hidden in the thin state. What would annoy Taylor day to day: the wheel does nothing over the 14 px hit strip (I measured scrollTop 4960 before and 4960 after). That strip stays live even while invisible, so a click 12 px in from the panel's edge jumped the paper 2177 px. It widens and labels during a selection drag. There is no keyboard support, and it pops out with no hover delay. Thumb accuracy breaks past about 60 pages, where the thumb would need a minimum height. Jumps were accurate: headings landed 28 px under the panel's top at both sizes.
- *gutter*: This has the most careful code of the three. It reads offsetTop in layout px and places marks by percentage, so a resize runs no script. Hit-testing takes the nearest mark within ±7 px across the full gutter width. It has roving-tabindex keys, wheel forwarding that knows deltaMode, and page numbers that thin out for long papers. Light marks on the dark frame are the history strip's own palette. But it breaks the brief's hard rule: it takes 12 px from the paper (scale 1.270 instead of 1.284 at 1100). It also makes the frame uneven (6/7/8/20) and breaks 'one 8 px edge all round' and Knuth's matching box, so the HUD, toast, --axis, the table toolbar, frame.spec and the smoke test all need new numbers unless Knuth takes the same gutter. At rest the 20 px column is almost empty: two faint hairlines and a band at 3.5 % white. It reads as a reserved scrollbar track, which is exactly the browser-scrollbar look the brief rules out, and the visible span is barely there. Headings show only when the pointer is near, and the 8 px page numbers at 40 % are tiny. The hover label over the margin is the best of the three and worth grafting.

## The judges' synthesis

**Judge 1.** Build the outline's rail, without its outline. At rest it is the history strip moved onto the paper. It is 16 px wide at the panel's right edge, on the page's right margin, in the frame's ink, and every mark is always on: a hairline at each page break, dots sized by heading level, a hollow square for a figure or table, the caret's blue tick, and a soft capsule for the part you are looking at. It costs the page no width, the black edge stays 8 px all round, and it is the only one of the three whose points show without hovering, which is what you liked in the history view. Its hover, though, is a 264 px table of contents. That covers a third of the panel at 740 px, and on a 30-page paper it pushes the title and the first sections off its top. Swap it for the gutter's label: one dark caption for the mark nearest the pointer. It gives the section number, the heading in STIX and its page; on a page break it says "Page 3 of 5", and over empty track it draws a faint line with that page. Take two more things from the gutter. First, the faint page numbers under the hairlines, shown while the pointer is on the rail and thinned on long papers so they stay legible. Second, its one-stop keyboard, and the rule that pressing a mark jumps only if you don't drag, so the capsule can be grabbed anywhere; the edge mockup jumps instead, and a 100 px drag there moved a third of what it should. From the edge, take where the marks come from: a finished layout pass hands them over in the page's own pixels, so resizing the window moves only the capsule. Leave out the gutter's 20 px column, which narrows the page, makes the frame uneven and breaks the match with Knuth's panel. Leave out the edge's hiding at rest too: its resting state is bare paper, and its thin strip is 4 px of specks. The outline panel can come back later as a contents view of its own, once it can drop subsections on a long paper.

**Judge 2.** Build the outline mockup's resting rail, and leave its unrolling outline for later. That rail is the history strip moved onto the paper: 16 px wide, hugging the panel's right edge, always there once the paper runs past the panel. It shows a hairline for each page break, dots sized by heading level, small open squares for figures and tables, a blue tick for the caret, and a soft capsule for the part you're looking at, all in the frame's own ink. It takes nothing from the paper's width and leaves the 8 px edge and Knuth's matching box alone, so frame.spec keeps its numbers. The gutter design lost on exactly that point. Its 20 px column shrinks the page about 1 % and makes the right edge uneven, and at rest it looks like a reserved scrollbar track. The edge design is bare paper until you scroll, which misses what you liked about the history strip (the nodes are always there), and the scroll wheel does nothing over its invisible 14 px strip.

Take these from the other two. From the gutter: its hover label, one dark-glass caption with the section number, the heading in STIX and 'p. 3' (or 'Page 3 of 5' on a page break), in place of the 264 px outline that opens over your text after a 120 ms hover. Also its ±7 px hit area for the nearest mark, its page numbers that thin out on long papers, its arrow keys between marks, and wheel forwarding that handles line-based scrolling. From the edge: the darker tick for the page gap that's on screen.

Fix two things before it lands. First, nothing opens or grows while a mouse button is down: in my test, dragging a selection toward the edge opened the outline over the text being selected. Second, the rail hides when the document fits on screen and in source view.

In Plass it's one fixed element beside the HUD. It takes the marks from the settled layout pass, places them as fractions in CSS so a resize or zoom moves them for free, and redraws the capsule once per scroll. The full outline can come back later as something you open on purpose, from a click or a key, once it handles a 30-page paper.

The one trade-off to accept: a click in the 16 px strip at the far edge of the right margin moves the paper instead of placing the caret.

Evidence images are beside the mockups: scroll-rail-judge2-rest-rails.png, scroll-rail-judge2-scroll-hover-rails.png and scroll-rail-judge2-outline-selection-drag.png.

## The designers' reports

### gutter

File: /Users/taylorjweidman/Projects/plass-wt-rail/docs/mockups/scroll-rail-gutter.html

Screenshots (1100×760, device scale 2):
- /Users/taylorjweidman/Projects/plass-wt-rail/docs/mockups/scroll-rail-gutter-rest.png
- /Users/taylorjweidman/Projects/plass-wt-rail/docs/mockups/scroll-rail-gutter-hover.png
- /Users/taylorjweidman/Projects/plass-wt-rail/docs/mockups/scroll-rail-gutter-end.png

I also checked the file at 1500×900 and 740×600. Both work, and at 1500 the hover label sits wholly inside the page's right margin. The worktree was created on ux/rail from main eb4ea89. Nothing is committed. The main checkout is clean. Another agent's scroll-rail-edge.html is in the same folder and I left it alone.

**What the rail shows and how.** The rail stands for the whole document, top to bottom. It sits in a 20 px gutter on the dark frame, between the panel's right edge and the window's. Its track is exactly the panel's height, so at the top of the paper the band's top edge is level with the panel's top edge, and at the end its bottom edge is level with the panel's bottom.

The marks:
- **Page breaks:** a hairline across the rail at the middle of each 6 px gap between sheets. The page number sits faint just under each hairline.
- **Headings:** dots sized by level (title, section, subsection).
- **Figures and tables:** tiny squares, filled for a figure and open for a table, like the history strip's square for your own commits.
- **Caret:** a short bar in the frame's focus blue, the only coloured mark.
- **Visible span:** a lighter rounded band, after the history strip's band. Marks outside it are a step quieter.

States:
- **At rest:** only the hairlines and a faint band show.
- **Awake:** the marks and numbers fade in when the pointer is in the gutter or over the last 36 px of the paper beside it, and fade out 600 ms after it leaves. Scrolling lights only the band, for 900 ms, like a macOS overlay scrollbar.
- **Hover:** the nearest mark within ±7 px is picked across the gutter's full width, so a 3 px dot is easy to hit. It grows 1.45× and turns white. A label hangs to the rail's left over the paper's margin: the section number, the heading's own words in the bar's serif, then "p. 3". A page break shows "Page 3 of 5". Empty track shows a faint line where a click would land, with its page.
- **Click and drag:** clicking a heading or figure puts it an eighth of the way down the panel. Clicking a break puts that sheet's top at the panel's top. Clicking empty track centres that point, and a drag scrubs the band. The mouse wheel over the gutter scrolls the paper.
- **Keyboard:** the rail is one tab stop. Up/Down, Home and End move between marks and the label follows; Enter jumps.

**How it's built.** The marks are real buttons, placed by percentage of the track. Their position is read from layout (offsetTop) in the page's own 816 px coordinates, not from the drawn size, so no paper-size workaround and no division by the scale are needed, and a window resize moves no mark with script. In Plass the marks would be rebuilt when a layout pass settles. Only the band is rewritten, on scroll and on resize. A long paper thins its page numbers (every 2nd, 5th, 10th…) so shown numbers stay at least 16 px apart. Under 4 px a page the hairlines thin too, and a number gives way to a mark that falls just under it. In the mockup each sheet holds its own content; in Plass one editable flow runs over painted page boxes. The reading code is the same either way.

**The numbers:**
- **Gutter:** 20 px, only while a document is open; otherwise the edge stays 8 px. The track runs from y 44 to 8 px above the window's bottom (708 px at 760).
- **Band:** 14 px wide (3 px in from each side), 4 px corners, at least 10 px tall.

| Band state | Fill (white) | Inset edge (white) |
|---|---|---|
| At rest | 3.5 % | 8 % |
| Awake or scrolling | 7.5 % | 17 % |
| Dragging | 11 % | 24 % |

| Mark | Size | Colour |
|---|---|---|
| Page break | 12 × 1 px hairline | white 17 % |
| Page number | 8 px system sans, 3 px under its hairline | rgba(240,238,233,.40) |
| Title | 7 px dot | rgba(240,238,233,.86) |
| Section | 5 px dot | .72 |
| Subsection | 3 px dot | .56 |
| Figure | 5 px filled square, 1 px corner | rgba(216,214,209,.60) |
| Table | 5 px open square, 1.2 px line | rgba(216,214,209,.70) |
| Caret | 8 × 2 px bar | #9db8d6 |

- **Label:** Plass's dark-glass caption: rgba(27,26,30,.94), a 1 px 10 % white hairline, 6 px corners, the same shadow as the captions. Heading text is 13 px STIX; the section number is 11 px sans at 50 %; the page is 10.5 px at 42 %. Its right edge is 7 px left of the gutter. The page and empty-track labels use the plain 11 px caption.

**What it costs the layout:**
- **A narrower page:** the panel loses 12 px of width, so the page draws at (W − 64)/816 instead of (W − 52)/816.
  - 1100 px window: scale 1.270, down from 1.284 (about 1 % smaller).
  - 1500 px window: 1.760, down from 1.775.
  - 740 px window: 0.828, down from 0.843.

  The 816 px layout itself is untouched, so nothing reflows and no layout pass runs.
- **One edge variable split out:** the panel's right margin becomes its own variable. The HUD, the toast, the paper's centre line and the table toolbar would read it; in the mockup the HUD and the centre line do.
- **Parity broken:** "one 8 px edge all round" and "Knuth's room's box, to the pixel" both stop holding unless Knuth takes the same gutter. The panel-box and scale checks in frame.spec and the smoke test would need new numbers.
- **Script:** one walk over the headings, figures and tables after each layout pass, and two style writes per scroll.

**Decision for you:** your brief said the rail fades to its page-break hairlines. I kept the band faintly visible at rest as well, because the panel draws no other scrollbar and "where you are" is the rail's first job. Dropping it is a one-line change.

**What I'm least sure of:** whether a 20 px gutter reads as part of Zen's frame or as a reserved scrollbar column. It makes the frame uneven (6 px beside the tiles, 8 at the bottom, 20 at the right). At rest that strip is nearly empty: two faint marks don't obviously explain why the right edge is wider. That runs against the "thin edge all round" Taylor asked for.

### edge

**File:** /Users/taylorjweidman/Projects/plass-wt-rail/docs/mockups/scroll-rail-edge.html (worktree `ux/rail` at eb4ea89; nothing committed, main checkout untouched)

**Screenshots (1100×760, device scale 2):**
- /Users/taylorjweidman/Projects/plass-wt-rail/docs/mockups/scroll-rail-edge-rest.png
- /Users/taylorjweidman/Projects/plass-wt-rail/docs/mockups/scroll-rail-edge-hover.png
- /Users/taylorjweidman/Projects/plass-wt-rail/docs/mockups/scroll-rail-edge-end.png

**What the rail shows and how:** The rail is one fixed element next to `#scroll`, the way `#hud` is. It sits over the panel's right edge, 3 px in, above the paper's right margin, and stands for the whole document from top to bottom.

- **Thin (4 px):**
  - A faint groove.
  - Page-break ticks in the frame's colour, like the real gaps. Each reaches 2 px onto the paper. The tick for a gap that's on screen reaches 6 px and darkens.
  - Heading dots by level, ringed in the paper's white so they still read under the thumb. The history strip does the same with its nodes.
  - The caret, as an accent line.
  - The visible span as a thumb: the frame's colour with a 1 px light core.
- **Lining up:** a strip that stands for the whole document can only put a tick on the same pixel as its real gap at one scroll position. So I took "line up" to mean the same fraction instead. The thumb is the panel's scroll position and height in the document's proportion, with no minimum size. A gap on screen crosses the thumb, as a cut in the light core, at the same fraction of the thumb as the real gap crosses the panel. Measured: 0.3034 against 0.3035 at 1100, and 0.3123 against 0.3123 at 1500.
- **Hover (14 px):** the strip widens to the left and becomes the frame itself.
  - A dark strip with the sheets drawn down it as a light column, cut by the gaps. The visible sheets are lit inside a window.
  - Light heading dots, plus small boxes for the figure and the table (the table's box has a rule through it).
  - One label at a time for the mark nearest the pointer (within 6 px), or "Page n of 5" plus a hairline where there's no mark. The label uses Plass's dark caption style, sits 8 px left of the strip, and shows heading names in STIX.
- **Click and drag:** clicking a mark jumps there, smoothly, with a heading landing 28 px under the panel's top. Clicking bare track centres that point. Dragging the thumb scrubs.
- **Showing and hiding:** it shows on scroll and on hover, and fades 1100 ms after both stop. Opening a document shows it for 1500 ms. So the rest screenshot is bare paper, on purpose. The end screenshot shows the thin state with the 4|5 gap cutting the thumb, and the hover screenshot shows "Three weeks of readings, p. 3" with the 1|2 gap in view.
- **Labels:** the history view's strip has no labels of its own (it is drag-to-travel only), so the labels are new here.

**Numbers:**
- **Placement:** the track runs from 10 px under the panel's top to 36 px above its bottom (x 1085–1089, 662 px tall at 1100×760). The thumb is 68.8 px for 5 pages.
- **Thin:**
  - Groove rgba(24,24,26,.07), radius 2.
  - Thumb rgba(24,24,26,.8) with a 1 px core of white at 62 %.
  - Ticks 1.5 px, frame colour at 50 %, 6 px long; 10 px long at 88 % when the gap is on screen.
  - Dots: level-2 headings 4 px, level-3 2.5 px, the title a 4×2 bar; ink rgba(24,24,26,.72) with a 1 px white ring.
  - Caret 8×2 in #305c8a.
- **Wide:**
  - 14 px, radius 7, rgba(24,24,26,.92) with a 10 px blur, a white 8 % hairline and the shadow 0 4px 14px rgba(0,0,0,.22).
  - Sheet column 8 px wide, white at 13 %; gaps 2 px of #18181a.
  - Thumb window 11 px wide, 1 px ring of white at 42 %, lit core white at 30 %.
  - Dots: 6 px and 4 px, the title 8×2.5; ink rgba(240,238,233,.92) with a 1.5 px frame-colour ring.
  - Figure and table boxes 8×6; caret 10×2 in #9db8d6; the hovered mark grows 1.45× and turns white.
- **Label:** rgba(27,26,30,.94), radius 6, 11 px sans.
- **Timing:** 140 ms to widen, 320 ms to fade.
- **Checks:** at 1100 and 1500, jumps land 28 px under the panel's top, a 100 px thumb drag moved exactly the expected amount, there were no console errors, and nothing scrolls sideways at 740, 1100 or 1500.

**What it costs the layout:**
- **Unchanged:** no paper width, no reflow, no change to the scale, and the HUD keeps its corner (the track stops above its row).
- **The paper's margin:** 14 px of its right margin becomes a hover zone, live even while the strip is hidden. A click there jumps or scrubs instead of putting the caret at a line's end.
- **Labels:** they briefly cover the ends of lines.
- **Code:** one fixed element, fed by a settled layout pass with the page breaks, headings, figures and tables. Mark positions are kept in the layout's own px, so a resize only re-reads the track's length.
- **Long documents:** past roughly 60 pages at 1100 the thumb would need a minimum height, and the fraction match would break there.

**Least sure of:** hiding it at rest. The history view's strip, the one you liked, is always on screen, and its marks are the point. Here the headings and sheets show only while you scroll or hover, and the rest state is bare paper.

### outline

The mockup is done and interactive: the rail tracks the paper as it scrolls, hovering it opens the outline, and clicking, dragging, the wheel and the keyboard all work. All three screenshots were taken at 1100×760, device scale 2, with no console errors. I also checked it at 1500 and 740 wide. Nothing is committed. The main checkout is untouched and still clean.

**What the rail shows and how.** At rest, a 16 px rail sits on the paper's right margin, hugging the panel's right edge the way the history strip hugs its room. It has a faint spine and is drawn in the frame's own ink:
- **Marks:** a hairline across the spine for each page break (the frame showing through, as between sheets), a dot for each heading (5 px for a section, 3 px for a subsection), a short bar for the title, a hollow square for a figure or table, and a blue tick for the caret. A click in the text moves the caret and its tick.
- **Thumb:** the visible span is a soft 8 px capsule under the marks. Marks inside it are inked darker. It brightens while the pointer is on the rail and for 0.9 s after a scroll.
- **Outline:** 120 ms after the pointer reaches the rail, the outline unrolls leftward out of it in Plass's dark glass (the same as its menus). The rail becomes the outline's spine, with its marks turning light. Heading names sit at their dots' heights in serif, joined to their dots by dotted leaders, the way a table of contents joins names to page numbers. Where two names would overlap they part around their shared middle and the leader bends back to the dot. Page numbers sit at the left under each break. The visible span is a band across the outline. Figures and tables get a softer sans row only where a gap is free.
- **Lit and hovered rows:** the current heading (the one under a line a quarter of the way down the panel) is white with a blue bar beside it. The row and dot under the pointer light together.
- **Going somewhere:** clicking a name or dot brings that heading to 40 px under the panel's top. Clicking empty space centres that place. Pressing and dragging anywhere scrubs the paper live, and the wheel over it scrolls the paper.
- **Keyboard:** Tab opens it, ↑↓ walk the headings, Return jumps, Page Up/Down, Home and End scroll, Escape folds it.
- **Closing:** leaving it folds it back after 260 ms. The foot of the outline repeats the HUD's count, since it covers the HUD: "Page 3 of 5 · 1,052 words".

**The numbers:**

| | |
|---|---|
| Rail | 16 px wide, inset 4 px from the panel's right edge. The spine is 12 px inside the panel, 20 px from the window's right. |
| Rail height | from 12 px under the panel's top (y 56) to 36 px above its bottom, which leaves the HUD its row: 660 px tall at 760 |
| Page break | 12×1 px, rgba(24,24,26,.30) |
| Section dot | 5 px, alpha .50, .80 in view |
| Subsection dot | 3 px, alpha .40, .66 in view |
| Title bar | 9×2.5 px |
| Figure or table | 5 px hollow square, 1 px ring, alpha .30, .52 in view |
| Caret tick | 10×1.5 px, #305c8a (#9db8d6 on the glass) |
| Spine | 1 px, alpha .07 |
| Thumb | 8 px wide, radius 4, at least 14 px tall; fill .045 with a .13 ring, rising to .07 / .24 |
| Outline box | 264 px wide, 4 px inside the panel's top, right and bottom, radius 8 (concentric with the panel's 12). Glass rgba(27,26,30,.94), blur 18 px with saturate 140 %, 1 px white 10 % hairline. |
| Outline type | title italic 13/20 STIX Two Text, sections 13/18, subsections 12/16 indented 44 px against 30; page numbers 9.5 px sans at 34 %; figure and table rows 10.5 px sans |
| Leaders | 1.2 px dotted: white 20 %, current #9db8d6 at 75 %, hovered 60 % |
| Band and scrub line | band white 4.5 % with a 6 % ring; scrub line #9db8d6 at 50 %, shown only over empty space or during a drag |
| Timing | opens after 120 ms, unrolls in 220 ms |

**What it costs the layout:**
- **Paper width:** none. The rail lies on the paper's 1.25in right margin, which is drawn 101 px wide at 740, 154 at 1100 and 213 at 1500.
- **Height:** the rail stops 36 px short of the panel's bottom so the HUD keeps its corner.
- **Resize:** the marks are placed as fractions of the rail's height in CSS, so a resize runs no script except the thumb's one write.
- **Scrolling:** one frame-callback per scroll, reading three numbers and writing the thumb, the band and a few classes. The outline is built only when it opens or the window resizes while it is open.
- **When open:** the outline covers 264 px of the paper. At 1100 that is the right 120 px or so of the text column; at 740 it is more than a third of the panel.
- **Stand-ins:** in the mockup the marks are read off the DOM after a small stand-in paginator. In Plass they would come from the layout's page list and heading, figure and table positions after each pass.
- **Corners:** the sheets follow main's look (square at the gaps); the ux/corners change isn't in the mockup.

**What I'm least sure of.** Putting names at their heights is right for this five-page paper, with 13 headings in 660 px. On a 30-page document with 60 headings the clusters would outgrow their space and push names far from their dots. The outline would need to drop subsections by priority, or stop being proportional, and then it is just a list. A smaller worry: the rail lives on the paper, not in the 8 px frame edge, so it reads as part of the frame only through its frame-coloured ink and the dark glass it opens into.

Files are in /Users/taylorjweidman/Projects/plass-wt-rail/docs/mockups:
- scroll-rail-outline.html
- scroll-rail-outline-rest.png
- scroll-rail-outline-hover.png
- scroll-rail-outline-end.png

## Recommended, 2026-10-02

Both judges: build the outline mockup's resting rail — 16 px on the
paper's right margin, hugging the panel's right edge, always on once the
paper runs past the panel, the frame's ink: a hairline per page break,
dots sized by heading level, hollow squares for figures and tables, a blue
tick for the caret, a soft capsule for the visible span — and leave its
unrolling outline for later. Graft from the gutter: the one dark-glass hover
label (section number, the heading in STIX, "p. 3"; "Page 3 of 5" on a
break; a faint line with its page over empty track), the ±7 px hit area,
page numbers under the hairlines that thin on long papers, the keyboard
(one tab stop, arrows between marks, Return jumps), wheel forwarding. From
the edge: the darker tick for the gap that is on screen, and marks placed
from a finished layout pass in the page's own pixels. Rules: nothing opens
or grows while a mouse button is down; the rail hides when the document
fits the panel and in source view; it takes no paper width and the 8 px
edge stays.

**Built, 2026-10-02 (branch `ux/rail`).** Taylor, shown the three
mockups' screenshots: "i think i like gutter-hover.png the most." So the
gutter was built, not the judges' pick: the frame's right edge widens to
a 20 px gutter while the paper runs past the panel (one sheet or many),
and the rail lives there on the dark frame, outside the paper, as the
history strip lives beside its river (`src/scroll-rail.ts`). The judges'
objection to it — the gutter takes 12 px of the paper's width (the page
drawn at 1.270 instead of 1.284 at 1100, about 1 % smaller), makes the
frame's edge uneven and ends the match with Knuth's room — is accepted as
the trade for that: Taylor chose it having seen the narrower page beside
the full-width ones, the gutter is there only while it has a paper to
map (a paper that fits the panel and the source view keep the 8 px edge
and main's scale; in the page view that is nearly every paper, since a
Letter page runs past the panel at any usual window size, so typing a
note onto its second sheet never rescales it), and their other
objection, a nearly empty
column at rest that reads as a reserved scrollbar track, is answered by
the change they both asked for: the marks are shown at rest. From their
synthesis it keeps the rules (nothing opens or grows while a mouse button
is down; no rail when the paper fits or in the source view); from the
edge, the stronger tick for the page gap on screen and marks placed from
a settled layout pass in the page's own px. The unrolling outline is left
for later. The verifiers' round (the same evening) closed five
problems: the band's height after a resize at the top of the paper; a
scroll that restyled every mark (the band now moves by a transform on
its own layer, and only the marks it crosses change); page numbers
hidden on a long paper whose pages open with headings (a number now
moves over or past the mark in its place); and the first build's rule
that kept one-page notes out of the gutter, which was not the brief's
(the tests' window moved from 868 to 880 px so a paper with the gutter
is still drawn at 1:1). The numbers, the mechanism and the checks are
in `docs/ZEN-DRAFT.md`, *The scroll rail*.
