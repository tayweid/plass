# Plass Markdown

How to write a Plass document by hand, or have a model write one.

A Plass document is one `.md` file in [Pandoc
Markdown](https://pandoc.org/MANUAL.html#pandocs-markdown). Everything on
this page is ordinary pandoc syntax. Plass adds meaning in only two places:
a few div class names (`solution`; `columns`, `column` and `continued`;
`table`; `center`, `right`, `keep`), and the settings under one `plass:`
key in the front matter, which pandoc ignores.

Plass lays out the page the way Typst prints it. Pandoc checks what the file
*says* (its text, math, labels, comments and tables), not how the page looks.
To see how pandoc reads a file, run `pandoc -f markdown -t native paper.md`.
In a Plass checkout, `node --import tsx scripts/pandoc-parity.ts paper.md`
compares pandoc's reading with Plass's.

Status: this page was written for step 5 of `docs/MARKDOWN-SOURCE-PLAN.md`,
before the reader and writer it describes were built. Step 11 checks it
against what was actually built.

## A short file

~~~markdown
---
title: Vignette B3 | Solutions
author: Taylor J. Weidman
date: 2026-10-04
plass:
  page: half-letter
---

# Demand {#sec:demand}

Demand is $q = a - bp$, so revenue peaks at @eq:price.

$$
p^* = \frac{a}{2b}
$$ {#eq:price}

::: solution

Revenue is $p(a - bp)$; set its slope $a - 2bp$ to zero.

:::

<!-- Check the sign on b before posting. -->
~~~

## Front matter

The front matter is YAML between two `---` lines at the very top of the file.
For the main settings it uses pandoc's own names. Settings that pandoc has no
name for go under `plass:`. Every key is optional. Plass writes a key only
when its value is not the default, so most files have few keys. Here is
every key except `plass.page`, which takes the place of `papersize` and is
listed in the table below:

```yaml
---
title: "Vignette B3 | Solutions"   # Markdown: $x$ and *em* work here
author: "Taylor J. Weidman"        # a YAML list is read too, and saved as one line joined with ", "
date: 2026-10-04
abstract: |
  Markdown, like the body: $\beta$, *emphasis* and [@key] all work.

  A blank line starts a second paragraph.
papersize: a4
margin: {top: 1in, right: 1in, bottom: 1in, left: 1in}
fontsize: 11pt
mainfont: New Computer Modern
section-numbering: "1.1"
bibliography: references.bib
linestretch: 1.4
indent: true
bibliographystyle: apa
plass:
  landscape: true
  hyphenate: false
  number-equations: false
  page-numbers: {show: true, format: "i", align: right, place: bottom, start: 1, front-matter: roman}
  header: {text: "{section}", align: right, first-page: false}
  footer: {text: "Econ 0100 · {page}", align: center, first-page: true}
  footnotes: {numbering: "*", separator: full}
  math-macros: |
    \R = \mathbb{R}
---
```

| Key | What it sets | Values | Default |
|---|---|---|---|
| `title`, `author`, `date` | the title block | Markdown text | none |
| `abstract` | the abstract | Markdown paragraphs, as a YAML block scalar | none |
| `papersize` | paper | `us-letter`, `a4`, `us-legal`, `iso-b5`, `a5` | `us-letter` |
| `plass.page` | paper with no Typst name (use it instead of `papersize`) | `half-letter`, or `{width: 6in, height: 9in}` (2–30 in) | none |
| `margin` | margins | a map of all four sides, or one value for all of them; `in`, `mm`, `cm`, `pt`; 0–3 in | `1.25in` |
| `fontsize` | body text size | 6–72 pt | `12.5pt` |
| `mainfont` | font | New Computer Modern is the one certified font. Any other name is kept, but the page still prints in New Computer Modern | New Computer Modern |
| `linestretch` | line spacing, as a multiple of the font size | 1–3 | `1.5` |
| `indent` | indent each paragraph's first line, with no gap between paragraphs | `true`, `false` | `false` |
| `section-numbering` | number the headings 1, 1.1, … | any value turns it on; Plass writes `"1.1"` | off |
| `bibliographystyle` | citation style | `ieee`, `apa`, `chicago-author-date` | `ieee` |
| `bibliography` | a `.bib` file next to the document | a path | none |
| `plass.landscape` | turn the page sideways | `true`, `false` | `false` |
| `plass.hyphenate` | hyphenation | `true`, `false` | `true` |
| `plass.number-equations` | number display equations | `true`, `false` | `true` |
| `plass.page-numbers` | page numbers | `show` (`true`, `false`); `format` (`"1"`, `"— 1 —"`, `"i"`, `"1 / 1"`); `align` (`left`, `center`, `right`); `place` (`bottom`, `top`); `start` (a whole number); `front-matter: roman` | shown, `"1"`, center, bottom, 1 |
| `plass.header` | a running header | `text` (may contain `{page}` and `{section}`); `align` (`left`, `center`, `right`); `first-page` (`true`, `false`) | no text, right, not on page 1 |
| `plass.footer` | a running footer | `text` (empty means the page number); `align`; `first-page` | no text, center, on page 1 |
| `plass.footnotes` | footnote markers | `numbering` (`"1"`, `"a"`, `"i"`, `"*"`); `separator` (`rule`, `full`, `none`) | `"1"`, `rule` |
| `plass.math-macros` | LaTeX macros for every formula | one `\name = expansion` per line | none |

- Plass reads `title`, `author`, `date` and `abstract` the same way it
  reads body text. Math, emphasis and citations work in them, and quotes
  and dashes are converted just as they are in the body.
- Quote a value that contains `{page}` or `{section}`, a `*`, or a number
  that is meant as text (`"1"`, `"1.1"`). In YAML, `{` starts a map and `*`
  starts an alias.
- `front-matter: roman` gives the title block its own pages, numbered in
  roman numerals. The body starts on a new page, numbered from 1.
- `bibliography:` is read once, and only when the document's folder is open
  in Plass. When Plass saves, it copies the entries into a
  ```` ```{=bibtex} ```` block (see References) and removes the key.
- Plass keeps keys it does not know, and `#` comments, and writes them back
  after its own keys. If a value is out of range, Plass changes it and
  warns you when it opens the file.

## Everything else at a glance

| To get | Write | Notes |
|---|---|---|
| a heading | `## Results {#sec:results}` | the label is optional. `{-}` is ignored, because heading numbers are on or off for the whole document |
| emphasis, strong, strike | `*em*`, `**strong**`, `~~gone~~` | |
| inline code | `` `x = 1` `` | |
| a link | `[Typst](https://typst.app)` | |
| a line break | `\` at the end of the line | |
| a footnote | `a claim.[^1]` and, below, `[^1]: The note.`; or `a claim.^[The note.]` | one paragraph per footnote |
| a bullet list | `- item` | |
| a numbered list | `3. item` | keeps its starting number |
| a loose list | a blank line between items | spaced like paragraphs. With no blank lines, the list is tight. A tight list cannot hold an item whose blocks need a blank line between them (a second paragraph, a quote, a div, a table): Plass saves such a list loose, with a warning |
| a quote | `> text`, with a bare `>` line between paragraphs | |
| a code listing | ```` ```python ```` … ```` ``` ```` | printed as a monospace block |
| a horizontal rule | `---`, with a blank line above and below it | without them, pandoc can read `---` as the start of a metadata block and drop the text up to the next `---` |
| a page break | `\newpage` on its own line, with blank lines around it | `\pagebreak` also works |
| a nonbreaking space | `Fig.\ 3`, or the U+00A0 character | |
| dashes and an ellipsis | `--`, `---`, `...` | stored as –, —, … |
| a fill-in blank | `\_\_\_\_\_\_` | prints `______` |
| a proposed-edit mark | `{++ added ++}` | plain text, printed exactly as typed |
| math | `$q = a - bp$`, or `$$` … `$$ {#eq:demand}` | see Math |
| a solution block, columns, an aligned or kept paragraph | `::: solution`, `:::: {.columns gutter=1em}`, `::: center` | see Divs |
| a table | a pipe table, optionally inside `::: {.table …}` | see Tables |
| a figure | `![Caption](figures/sd.svg){#fig:sd width=60%}` | see Figures |
| a citation, a cross-reference | `[@smith2020]`, `@eq:demand` | see References |
| an editorial comment | `<!-- note to self -->` | never printed. See Comments |
| raw Typst | ```` ```{=typst} ```` … ```` ``` ````, `` `#sym.arrow`{=typst} `` | kept and shown as code, never run. See Kept, not rendered |

## Math

~~~markdown
Inline: $q = a - bp$, and $\pi = (p - c)\,q$.

$$
p^* = \frac{a}{2b}
$$ {#eq:price}

$$
\text{CS} = \tfrac12 (a - p^*) q^*
$$ {.unnumbered}
~~~

- The math itself is LaTeX. A `$` must touch the formula: `$x$`, not `$ x $`.
  A closing `$` that has a digit right after it does not end the formula.
- Inline math can continue onto the next line, but not past a blank line.
  A `$` at the start of a line closes a formula opened on the line before
  (pandoc reads it that way), so a dollar sign at the end of a line, before
  a `$$` block for instance, must be written `\$`.
- Put `$$` on lines of their own. Attributes go right after the *closing*
  `$$` (or on the next line): `{#eq:name}` is a label;
  `{.unnumbered}` leaves one equation unnumbered; `{.numbered}` numbers one
  equation even when `number-equations: false`. You can combine them:
  `{#eq:name .unnumbered}`. An unnumbered equation cannot be referenced.
- Each line between the `$$` lines prints as its own row, and `&` aligns
  the rows (Plass wraps them in `aligned` and puts the `\\` between them
  itself). So do not end the lines with `\\`: Plass would add its own as
  well, and each doubled `\\` prints an empty row. Either write plain
  lines, or write the whole `\begin{aligned} a &= b \\ c &= d
  \end{aligned}` yourself; a formula that contains `\begin{…}` is left
  exactly as written. Pandoc reads plain lines as one line, so if the file
  must also read correctly in pandoc or LaTeX, use the second form.
- To reference an equation, write `@eq:price`.

## Divs

A div is a block between a `:::` line that opens it and a `:::` line that
closes it. Put a blank line before and after every `:::` line. A fence can
have more than three colons: a closing fence closes the innermost open div
whatever its length, so a longer fence on an outer div (`::::`) only makes
the nesting easier to read.

**Solution block.** Printed in red, with a red rule down the left side. It can hold
any blocks: paragraphs, math, lists, columns, tables. `::: {.solution}`
means the same thing.

~~~markdown
::: solution

The answer is $p^* = a/(2b)$.

:::
~~~

**Columns.** A grid is written one row at a time, with the names pandoc
and Quarto use for columns. Each row is a `.columns` div, and each cell in
it is a `.column` div. Every row after the first carries the class
`.continued` as well, which joins it to the row before it, so the rows
form one grid:

~~~markdown
:::: {.columns gutter=1em}

::: {.column width=60%}

![](figures/supply.svg)

:::

::: {.column width=40%}

The left panel shows the shift in supply.

:::

::::

:::: {.columns .continued gutter=1em}

::: {.column width=60%}

![](figures/demand.svg)

:::

::: {.column width=40%}

The left panel shows the shift in demand.

:::

::::
~~~

- Without `.continued`, two `.columns` divs one after the other are two
  separate grids. They look almost the same: the only difference is the
  space between the rows, which is the paragraph spacing instead of the
  gutter. `.continued` is Plass's own class; pandoc and Quarto ignore it.
- `width` is the cell's share of the row, as a percent. Every row of a grid
  has the same columns, so write the same widths on every row. Leave
  `width` off every cell to get equal columns. Plass also reads `2fr` or a
  bare number.
- `gutter` is the space between the columns, and between the rows of one
  grid (rows joined by `.continued`). It is measured in `em`; `pt`, `in`,
  `mm` and `cm` are converted. Without it, the gutter is `1em`. Write the
  same `gutter` on every row.
- Plass warns when a `.continued` row has a different number of cells or a
  different gutter from the grid it joins.

**Aligned or kept paragraph.** Wrap exactly one paragraph. `keep` stops it
from breaking across pages. You can combine the classes. Anything else
inside one of these divs (two paragraphs, a heading, a list) is not
aligned or kept: Plass keeps the whole div verbatim and prints it as code
(see Kept, not rendered).

~~~markdown
::: center

A centered line.

:::

::: {.keep .right}

Right-aligned, and never split across pages.

:::
~~~

## Tables

The basic form is a pipe table. The first row is the header. The line under
it sets each column's alignment: `:---` left, `---:` right, `:---:` center,
and `---` is the default (left).

~~~markdown
| Good  | Price | Change  |
|:------|------:|:-------:|
| Bread |  2.50 | $+3\%$  |
| Milk  |  1.25 | $-1\%$  |
~~~

- Each cell holds one paragraph of text. A table edited in Plass can hold
  more in a cell; the save then warns and flattens it: paragraphs are
  joined with a space, and a line break, a list or a display formula
  becomes part of that one paragraph. A footnote, an image or inline HTML
  in a cell is dropped when Plass saves, with a warning; put an image in
  columns instead. (A comment in a cell is kept: see Comments.)
- Escape a `|` in a cell's text as `\|`. You do not need to escape one
  inside `$…$` or backticks.
- For a table with no header, leave the first row blank: `|   |   |`.

A pipe table cannot express everything a table can have. Put the rest as
attributes on a `.table` div around the table:

~~~markdown
::: {#tbl:prices .table caption="Prices by region" style=grid fills="r0:gray" spans="r3c0:2x1"}

| Region | Price | Note |
|:-------|------:|:----:|
| North  | 12.50 | new  |
| South  |  3.25 | old  |
| Total  |       |      |

:::
~~~

| Attribute | Means | Example |
|---|---|---|
| `#tbl:name` | the label, for `@tbl:name` | `#tbl:prices` |
| `caption` | the caption | `caption="Prices by region"` |
| `style` | `booktabs` (the default), `grid`, `plain` | `style=grid` |
| `density` | cell padding: `compact` or `roomy` | `density=compact` |
| `inset` | cell padding, in points | `inset=9pt` |
| `columns` | column widths: `auto`, `Nfr` or `Npt`, separated by spaces | `columns="auto 1fr 2fr"` |
| `font-size` | `0.9em`, `0.85em`, `0.8em`, `0.75em` | `font-size=0.85em` |
| `decimal` | columns whose `---:` should line up on the decimal point, as column numbers separated by spaces | `decimal="1 3"` |
| `rules` | the rule under row N: `light`, `heavy`, `none` | `rules="0:heavy 3:none"` |
| `fills` | `gray`, `gray-dark`, `yellow` or `blue`, for a row `rN` or a cell `rNcM` | `fills="r0:gray r2c1:yellow"` |
| `valign` | `top`, `middle` or `bottom`, for the whole table or a cell `rNcM` | `valign=middle` |
| `aligns` | the alignment of one cell, different from its column's: `left`, `center`, `right`, `decimal`, or `default` (no alignment of its own, like `---`) | `aligns="r2c1:center"` |
| `spans` | a merged cell, as columns×rows, given at its top-left cell | `spans="r3c0:2x1"` |

Rows and columns are counted from 0. `r0` is the first row, which is the
header row if the table has one. In a table with no header, the blank
first line is not a row, so `r0` is the first body row. Columns are
counted including the cells a merged cell covers. In a merged cell, the
cells it covers are written empty. Where an attribute takes several
entries (`decimal`, `rules`, `fills`, `valign`, `aligns`, `spans`),
separate them with spaces. A `: Caption` line after a table is also read
as its caption.

## Figures and images

~~~markdown
![Supply and demand](figures/sd.svg){#fig:sd width=60%}

![](figures/sd.svg){width=40%}

Text with an icon ![arrow](figures/arrow.svg){width=4%} in it.
~~~

- An image on its own line with a caption is a numbered figure. `#fig:name`
  labels it, so you can reference it as `@fig:sd`.
- An image on its own line with no caption and no label is a plain image,
  not numbered. With a label and no caption, `![](f.svg){#fig:x}`, it is
  a numbered figure with an empty caption (see Pitfalls). A figure with
  neither is saved with a made-up label, `{#fig:figure-1}`, so that it
  stays a figure; Plass warns when it does.
- An image on its own line with alt text and a nonbreaking space (U+00A0)
  after it is a plain image that keeps its alt text, not a figure: that is
  pandoc's way to say so, and how Plass writes one. The space itself is not
  kept.
- An image with text around it sits inline, in the text.
- `width` is a percent of the text width, or of the cell's width.
- `![Caption](src "title")` adds an optional title.
- The source can be a path relative to the file, which needs the folder
  open in Plass. Or it can be a data URL
  (`data:image/svg+xml;base64,…`, also PNG, JPEG or GIF), which keeps the
  document a single file. Select an image in Plass and choose **Save to
  project** to write it out to `figures/`, or **Fix image** to store it
  back inside the document.

## References, citations, bibliography

~~~markdown
As @sec:demand and @fig:sd show, markets clear [@smith2020].
Two sources: [@smith2020; @jones2019].

# References

```{=bibtex}
@article{smith2020,
  author = {Smith, Adam},
  title  = {Markets},
  year   = {2020}
}
```
~~~

- An `@` key that starts with `eq:`, `fig:`, `sec:` or `tbl:` is a
  cross-reference to a label. Any other `@key`, bare or in brackets, is a
  citation.
- The references list prints where the ```` ```{=bibtex} ```` block is. In
  Plass, the bibliography's Edit panel has **Import .bib…** and
  **Download .bib**. A `bibliography:` key in the front matter is read
  once, then saved as this block.
- A key that is not in the bibliography shows up on the page as a visible
  [?].

## Comments

~~~markdown
<!-- Check the sign on b before posting. -->
~~~

Every HTML comment is an editorial comment. Plass keeps it in the file and
shows it as a "Comment · Not printed" strip. It is left out of the PDF,
the Typst export and the LaTeX export, and kept in a Markdown export. Put
it on its own lines, with a blank line before and after. A comment cannot
contain `-->`: write `--&gt;` instead, and Plass shows it as `-->`. The old
`<!-- plass:comment` form is still read.

A comment can also sit inside a block: a solution, a column, a list item, a
quote, a table cell or a footnote, or in the middle of a paragraph. It is
still kept and never printed. But on the first save it moves out of that
block, to just before the block if it came before the block's text, and
otherwise to just after it. Inside an HTML element that Plass keeps as
source, a comment on lines of its own moves out after the element, whose
first line prints; a `<div>` counts as a div, so there a comment that
comes before any of its text moves before it.

## Kept, not rendered

~~~markdown
```{=typst}
#lorem(20)
```
~~~

Plass keeps ```` ```{=typst} ```` blocks and `` `…`{=typst} `` inline code
exactly as written. On the page and in the PDF they print as code. Plass
never runs Typst written by hand. ```` ```typst ````, without the braces,
is an ordinary code listing.

The same goes for anything else Plass has no form for: an unknown div class
(`::: {.callout-note}`), an HTML block (`<div>`, `<aside>`), or inline HTML.
Plass keeps it verbatim and prints it as code, with a tag in the margin. It
never deletes it. A footnote or link definition (`[^1]: …`, `[site]: …`)
that only such content uses is kept too: it moves to just after that
content.

## Pitfalls

1. Put a blank line before and after every `:::` line and every comment.
   Pandoc reads a `:::` that comes straight after a line of text as more
   text. A comment there becomes part of that paragraph.
2. Write `\$` for a literal dollar sign, above all at the end of a line: a
   `$` that starts the next line (the first `$` of a `$$` block too)
   closes a formula opened by it.
3. Equation attributes go after the closing `$$`, not the opening one.
4. Write ```` ```{=typst} ````, not ```` ```typst ````. Write
   ```` ```{=bibtex} ````, not ```` ```bibtex ````. Without the braces, the
   block is just a code listing.
5. `@eq:`, `@fig:`, `@sec:` and `@tbl:` are cross-references, so do not
   start a bibliography key with one of them. Any other `@word` that is
   not directly after a letter or digit (after a space, `(`, `[`, a quote
   mark …) is a citation, so write `\@` for a literal at sign. An email
   address such as `a@b.org` is fine.
6. To pandoc, `H~2~O` is a subscript and `x^2^` is a superscript. Plass has
   neither: it keeps the characters as text and escapes them when it saves.
   Use math instead: `$x^2$`.
7. Pandoc numbers only figures with a caption. Plass also numbers
   `![](f.svg){#fig:x}`, a labeled image with an empty caption; pandoc
   reads it as a plain image. Give a figure a caption if the file must
   read the same in both.
8. A comment inside a block moves out of that block on the first save.
9. In YAML, quote any value that contains `{section}` or `{page}`.
10. Image widths must be percents. `width=3in` is dropped, with a warning.
11. If a known div has an attribute Plass does not use, such as
    `::: {.solution color=red}`, the attribute is dropped with a warning.
12. Put adjacent citations in one bracket: `[@a; @b]`. Pandoc reads
    `[@a][@b]` as an in-text citation of `a` inside literal brackets,
    followed by a bracketed citation of `b`. A cross-reference next to a
    citation goes in the same bracket: `[@eq:demand; @smith2020]`.
13. Plass cites only the key. In `[see @smith2020, p. 3]`, "see" and
    ", p. 3" stay as ordinary text next to the citation, and Plass warns
    once ("citation prefix/suffix kept as text"). So do `-@smith2020` and
    `@smith2020 [p. 3]`.
14. Each line of display math prints as its own row (see Math). Do not end
    the lines with `\\`; either write plain lines, or write the whole
    `\begin{aligned} … \end{aligned}` yourself.
15. A table cell holds one paragraph. A footnote, an image or inline HTML
    in a cell is dropped with a warning, and a cell's paragraphs are
    joined (see Tables). A footnote holds one paragraph.
16. Mark every row of a grid after the first with `.continued`. Without
    it, each `.columns` div is a grid of its own (see Divs).
17. The Typst export is exact on typst 0.14.2 when it is compiled with
    Plass's fonts (see below).
18. In a list item, put a blank line before a pipe table. Pandoc reads
    table lines directly under the item's text as more text, so Plass saves
    the blank line, which makes the list loose (see the loose list above).
19. Pandoc reads a paragraph that starts with `a)`, `A)`, `a.`, `iv.`,
    `(1)`, `(a)` or `(@)` as a list item, `| text` as a line block, and
    `: text` or `~ text` after a paragraph as a definition. Plass's lists
    are bulleted or numbered (`1.`) only: it shows these characters as text
    and escapes them when it saves (`a\)`, `\|`, `\:`), so pandoc then
    reads text too. Write the list with `1.` markers if it should stay a
    list.

## What the first save rewrites

Plass rewrites a hand-written file once, the first time it saves it, and
after that leaves it as it is. Nothing is lost silently: what Plass cannot
keep, it drops with a warning (see Pitfalls 10, 11 and 15).

- **Typography, as Typst prints it.** Straight quotes become curly quotes.
  `--`, `---` and `...` become –, — and …. A hyphen after a space and before
  a digit becomes a minus sign (−3). `5'11"` gets primes (5′11″). The space
  before a footnote marker is removed.
- **Layout of the text.** Each paragraph is written on one line. `_em_`
  becomes `*em*`, and `__strong__` becomes `**strong**`. Bullets become `-`,
  numbered items are renumbered 1., 2., 3., … from the list's start
  number, and indents are made consistent. Footnotes become `[^1]`,
  `[^2]`, … with their notes at the end, including inline `^[…]` notes
  (a label that content kept as source uses is skipped). Reference links
  become inline links. A footnote or link definition that nothing uses is
  dropped, with a warning.
- **Blocks.** A blank line is added around every `:::` line and every
  comment. `\pagebreak` becomes `\newpage`. `::: {.solution}` becomes
  `::: solution`. A `: Caption` line moves into the table div's `caption=`.
  Each grid row is its own `.columns` div, and every row after the first
  carries `.continued`. Column widths are written as percents (to three
  decimals, or more where three would read back as other widths), or left
  out when the columns are equal.
- **Front matter.** Keys are written in the order shown above, with unknown
  keys after them. Default values are dropped. An `author` list becomes one
  string. `bibliography:` becomes an embedded ```` ```{=bibtex} ```` block.
  Quoting may change.
- **Comments.** A `-->` inside a comment becomes `--&gt;`. The old
  `plass:comment` form becomes a plain comment. Comments inside blocks move
  out of them.
- **Escapes.** A backslash is added in front of any character that would
  change the meaning of the text, such as `\@`, `\~`, `\^`, `\$`, `\*` or
  `\_`, and in front of what would start a block at the head of a line:
  `\#`, `\>`, `\-`, `1\.`, `a\)`, `(i\)`, `\|`, `\:` (see Pitfall 19), and a
  `%` that opens the file (pandoc's title block). `\ ` becomes a literal
  nonbreaking space. A digit directly after a formula is written as a
  character reference (`$x$&#50;`), since `$x$2` is not a formula to
  pandoc.

## The Typst export

**Export → Typst (.typ)** writes the same Typst source that Plass compiles.
Kept-but-unrendered content prints as code, and comments are left out. Use
the `.typ` to compile or to read, not to edit: edit the `.md`. If you open
the `.typ` in Plass again, its kept content shows up as plain code listings.

- **The export is exact on typst 0.14.2**, the Typst inside Plass (the
  same line breaks and the same page breaks), when it is compiled with
  Plass's fonts and no others:

  ```sh
  typst compile --ignore-system-fonts --ignore-embedded-fonts \
    --font-path path/to/plass/public/fonts paper.typ
  ```

  Plass's fonts are the `.otf` and `.ttf` files in the `public/fonts`
  folder of the Plass repository.
- A compile with the fonts the typst command-line tool ships with
  (`typst compile --ignore-system-fonts paper.typ`) works, but it is not
  exact. The tool's copies of New Computer Modern and its math font are
  not Plass's files, and they include a bold math weight that Plass does
  not have. Math set with them can come out up to about 2 pt wider or
  narrower (bold text around a formula, and calligraphic letters such as
  `\mathcal{L}`, most of all), which is enough to move a line break.
  Without `--ignore-system-fonts`, fonts installed on your computer can
  take part as well.
- The export also compiles on typst 0.15.x. But Typst 0.15 changed how it
  lays out some math (`\underbrace`, `\mathcal`, binomials), so a few
  formulas can come out slightly different there.
- For now, math compiles through the mitex 0.2.7 package. The typst
  command-line tool downloads it from the Typst package registry the first
  time you compile, which needs a network connection. A later step will
  write plain Typst math instead.
- If the project folder is open, embedded images are written to `figures/`
  next to the export and linked by path. If it is not, the images stay as
  data URLs, and the `.typ` will not compile outside Plass.

An older `.typ` document still opens in Plass. **Export → Markdown (.md)**
converts it to this format.
