# Nested comments

Every comment below sits inside another block. Each is kept and never printed: it moves to the nearest top-level boundary, before its block when nothing printed precedes it there, after it otherwise.

::: solution

<!-- ED: first thing in the solution: moves before it. -->

The answer is four pasties.

<!-- ED: last thing in the solution: moves after it. -->

:::

::: {.columns gutter=1em}

::: {.column}

The left cell.

:::

::: {.column}

<!-- ED: in the second column: the first column printed, so after the grid. -->

The right cell.

:::

:::

- The first item.
- The second item.

  <!-- ED: in a list item. -->

> A quoted line.
>
> <!-- ED: in a quote. -->

| Item | Note |
|:-----|:-----|
| a    | b <!-- ED: in a cell. --> |

A paragraph with an inline <!-- ED: inline. --> comment in it.

<div class="aside">
<!-- ED: first thing in a div element: moves before it, as in a ::: div. -->
<span>Kept as source.</span>
</div>

<section>
<!-- ED: in another element, after its printed first line: moves after it. -->
</section>

The last paragraph.
