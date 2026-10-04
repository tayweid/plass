# Tables

A bare pipe table; a caption line after it is its caption.

| Name | Score | Note |
|:-----|------:|:----:|
| a    | 12.5  | x    |
| b    | 3.25  | y    |

: A bare pipe table with a caption line

Everything a pipe table cannot say rides on a wrapping `.table` div.

::: {#tbl:results .table caption="Results" style=grid density=compact inset=9pt columns="auto 1fr 2fr" font-size=0.85em decimal="1" rules="1:light 3:none" fills="r0:gray-dark r2c1:yellow" valign="r1c2:middle" spans="r3c0:2x1" aligns="r2c2:center"}

| Name                | Score | Note |
|:--------------------|------:|-----:|
| a                   | 12.5  | x    |
| b                   | 3.25  | y    |
| c spans two columns |       | z    |

:::

A table whose first row is not a header is written with a blank header row.

::: {.table caption="A headerless table"}

|                |               |
|----------------|---------------|
| $|x|$          | `a|b`         |
| a \| b         | $P = 20 - 4C$ |

:::

As @tbl:results shows.
