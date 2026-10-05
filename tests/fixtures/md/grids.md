# Grids

Shares written as fractions, `[2, 2]`: equal columns.

::: {.columns gutter=1em}

::: {.column width=2fr}

Two shares.

:::

::: {.column width=2fr}

Two shares.

:::

:::

Shares written as percentages, `[60, 40]`.

::: {.columns gutter=1em}

::: {.column width=60%}

Sixty percent: $P = 20 - 4C$.

:::

::: {.column width=40%}

Forty percent.

:::

:::

Shares `[1, 2]` as the writer spells them.

::: {.columns gutter=1em}

::: {.column width=33.333%}

One third.

:::

::: {.column width=66.667%}

Two thirds.

:::

:::

Shares written as bare numbers, `[1.5, 1]`: the same grid as `[60, 40]`.

::: {.columns gutter=1.5em}

::: {.column width=1.5}

A share and a half.

:::

::: {.column width=1}

One share.

:::

:::

Three columns and two rows: one `.columns` div per row, the second marked `.continued`, so both rows are one grid.

::: {.columns gutter=1em}

::: {.column}

Row one, left.

:::

::: {.column}

Row one, middle.

:::

::: {.column}

Row one, right.

:::

:::

::: {.columns .continued gutter=1em}

::: {.column}

Row two, left.

:::

::: {.column}

Row two, middle.

:::

::: {.column}

Row two, right.

:::

:::

Two adjacent grids with equal shares and gutter stay two grids: the second div is not marked `.continued`.

::: {.columns gutter=1em}

::: {.column}

First grid, left.

:::

::: {.column}

First grid, right.

:::

:::

::: {.columns gutter=1em}

::: {.column}

Second grid, left.

:::

::: {.column}

Second grid, right.

:::

:::
