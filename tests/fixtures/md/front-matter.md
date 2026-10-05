---
title: "Vignette B3 | Solutions"
author: "Taylor J. Weidman"
date: 2026-10-04
abstract: |
  Parsed as Markdown on both sides: $\beta$, *emphasis*, [@arrow1951] all work.

  Paragraphs are separated by a blank line.
margin: {top: 1in, right: 0.75in, bottom: 1in, left: 0.75in}
fontsize: 11pt
mainfont: Libertinus Serif   # a stored preference; rendering resolves to the certified New Computer Modern
section-numbering: "1.1"
linestretch: 1.3
indent: true
bibliographystyle: apa
plass:
  page: {width: 6in, height: 9in}
  landscape: true
  hyphenate: false
  number-equations: false
  page-numbers: {show: false, format: "i", align: right, place: top, start: 3}
  header: {text: "{section}", align: left, first-page: true}
  footer: {text: "Econ 0100 · {page}", align: right, first-page: false}
  footnotes: {numbering: "a", separator: full}
  math-macros: |
    \R = \mathbb{R}
keywords: "voting, econ"   # an unknown key, carried verbatim
---

# Settings

Every setting lives in the YAML block above, each at a value other than its default (the custom page size included); pandoc ignores the `plass:` key.

```{=bibtex}
@book{arrow1951,
  author = {Arrow, Kenneth J.},
  title = {Social Choice and Individual Values},
  publisher = {Wiley},
  year = {1951}
}
```
