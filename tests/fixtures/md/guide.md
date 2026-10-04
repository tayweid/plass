---
title: "ECON 0100 | Vignette A1 | PPF | Solutions"
author: "Taylor J. Weidman and Siobhán O'Connor"
date: 2026-10-04
papersize: us-letter
margin: {top: 1in, right: 0.5in, bottom: 1in, left: 0.5in}
fontsize: 12.5pt
plass:
  page-numbers: {show: true, format: "1", align: center, place: bottom, start: 1}
  header: {text: "{section}", align: right, first-page: false}
  footnotes: {numbering: "1", separator: rule}
---

<!-- ED: Solution guide for the teaching team. Answers and working sit in red solution blocks; everything else is what students see. -->

*Solution guide for the teaching team. Answers and working are in the red blocks; everything else is what students see.*

Colin Creevey can bake $20$ cornish pasties ($P$) or $5$ cauldron cakes ($C$) in one day. Set up Colin's PPF on an $x,y$ graph with pasties ($P$) on the vertical and cakes ($C$) on the horizontal. Label the axes and the intercepts.

::: solution

::: {.columns gutter=1em cols=2}

::: {.column}

Intercepts: $20$ pasties on the vertical axis (a full day on pasties) and $5$ cakes on the horizontal (a full day on cakes). The PPF is the line between them, @eq:ppf. The Q2 bundle $(2, 10)$ is marked below the frontier.

:::

::: {.column}

![](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNDAiIGhlaWdodD0iMTUwIiB2aWV3Qm94PSIwIDAgMjQwIDE1MCI+PHBhdGggZD0iTTIwIDEwVjEzMEgyMzAiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzAwMCIgc3Ryb2tlLXdpZHRoPSIxLjUiLz48cGF0aCBkPSJNMjAgMzBMMTkwIDEzMCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjYzAwMDAwIiBzdHJva2Utd2lkdGg9IjIiLz48Y2lyY2xlIGN4PSI2MiIgY3k9IjgwIiByPSI0IiBmaWxsPSIjYzAwMDAwIi8+PGNpcmNsZSBjeD0iNjIiIGN5PSI5NiIgcj0iNCIgZmlsbD0iIzAwMCIvPjwvc3ZnPg==){width=100%}

:::

:::

$$
P = 20 - 4C
$$ {#eq:ppf}

:::

## Q1 | Opportunity Cost

What is Colin's opportunity cost of producing $1$ cake? Of $1$ pasty?

Opportunity cost of 1C: \_\_\_\_\_\_\_\_\_\_

Opportunity cost of 1P: \_\_\_\_\_\_\_\_\_\_

::: solution

<!-- ED: keep the reciprocal point; students miss it every term. -->

**1C:** $4$ pasties. **1P:** $\frac{1}{4}$ cake.

A full day is $20P$ or $5C$, so $5C = 20P$ and $1C = 4P$: one cake costs four pasties. Flip it for the other direction:

$$
1P = \frac{1}{4} C
$$ {.unnumbered}

The two opportunity costs are always reciprocals. The $4$ is also the absolute slope of the PPF in @eq:ppf: pasties given up per extra cake.[^slope]

:::

[^slope]: The slope is constant because Colin's skill does not depend on how much of either good he already bakes; a bowed-out frontier would make it change along the curve.

## Q2 | Feasibility

Suppose Colin bakes $10$ pasties and $2$ cakes in one day. Is this inefficient, efficient, or unattainable? Use a graph or algebra to justify your answer.

Inefficient, Efficient, Unattainable: \_\_\_\_\_\_\_\_\_\_

::: solution

**Inefficient.**

*Graph:* at $C = 2$ the frontier allows $P = 20 - 4(2) = 12$, and $(2, 10)$ sits below it, so the bundle is inefficient: Colin could bake two more pasties without giving up a cake.

*Algebra (time check):* each good takes a share of the day, and the shares add up.

::: {#tbl:time .table caption="Share of the day each good takes" decimal="3"}

| Good    | Quantity | Fraction of the day | Share |
|:--------|---------:|:-------------------:|------:|
| Cakes   | $2$      | $\frac{2}{5}$       | 0.40  |
| Pasties | $10$     | $\frac{10}{20}$     | 0.50  |
| Total   |          | $\frac{9}{10}$      | 0.90  |

:::

Under a full day is inefficient, exactly one day efficient, over one day unattainable. Table @tbl:time puts the bundle at $\frac{9}{10}$ of a day. ~~A bundle on the axis is always efficient.~~ {++Either justification earns full credit.++}

<!-- ED: the struck sentence is wrong at the origin; leave it struck until the rubric is updated. -->

:::

\newpage

## Q3 | Next Best Alternative

In his free afternoon Colin would rather bake for the Gryffindor party than photograph the Quidditch match, and he'd prefer either over taking a nap. What is Colin's opportunity cost of baking?

Opportunity cost of baking before the invitation: \_\_\_\_\_\_\_\_\_\_

Then Dennis invites him to Hogsmeade, which Colin likes more than photographing the match but less than baking. What is his opportunity cost of baking now?

Opportunity cost of baking after the invitation: \_\_\_\_\_\_\_\_\_\_

::: solution

**Before:** photographing the Quidditch match. **After:** the trip to Hogsmeade.

Opportunity cost is the single next-best alternative, not the sum of everything forgone [@mankiw2020]. Before the invitation the ranking is baking $>$ photographing $>$ napping, so the cost of baking is the photography he gives up; the nap is not part of it, since he would not have napped anyway. Hogsmeade slots in between: baking $>$ Hogsmeade $>$ photographing $>$ napping. Baking is still his best option, but it now costs more: the best thing he gives up is the Hogsmeade trip.

The common mistake is "the match and Hogsmeade"; only one alternative can be next best.[^next]

:::

[^next]: Students who list two alternatives usually mean the right thing; a short note in the margin is enough.

## Q4 | Gains From Trade

Colin's friend Ginny can bake $12$ pasties or $6$ cakes in one day. Who has the comparative advantage in cakes? Suggest a trade that leaves both better off.

::: solution

Ginny's opportunity cost of one cake is $\frac{12}{6} = 2$ pasties; Colin's is $4$ pasties. Ginny gives up less to bake a cake, so she has the comparative advantage in cakes, and Colin has it in pasties.

Any price between their opportunity costs works:

$$
2 < p_C < 4
$$ {#eq:price}

At $p_C = 3$ pasties per cake, by @eq:price both gain: Ginny sells a cake for more than the $2$ pasties it costs her, and Colin buys one for less than the $4$ pasties it would cost him to bake it himself. Specialization and trade move both of them to bundles outside their own frontiers, which neither could reach alone.

A careful answer also checks the totals. If each spends the whole day on the good of their comparative advantage, Colin bakes $20$ pasties and Ginny bakes $6$ cakes. Trading $2$ cakes for $6$ pasties leaves Colin with $14$ pasties and $2$ cakes, and Ginny with $6$ pasties and $4$ cakes. On his own, Colin could have $2$ cakes and only $12$ pasties; Ginny, with $6$ pasties, could have had only $3$ cakes. Both end up with more of one good and no less of the other.

:::

<!-- ED: Q5 (the bowed-out frontier) moves to the A2 vignette next term. -->

## Teaching note

The graphs above are embedded SVGs, so the file is complete on its own. The block below is Typst kept as source: Plass shows and prints it as code and never runs it.

```{=typst}
#align(center)[#text(size: 9pt)[Graph code lives in the course repository.]]
```

## References

```{=bibtex}
@book{mankiw2020,
  author = {Mankiw, N. Gregory},
  title = {Principles of Economics},
  edition = {9},
  publisher = {Cengage},
  year = {2020}
}
```
