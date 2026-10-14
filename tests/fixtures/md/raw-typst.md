# Raw Typst

The fence below is the escape hatch: kept in the file, shown and printed as code, never run.

```{=typst}
#rect(width: 2cm, height: 1cm)[Typst kept as source]
```

A plain `typst` fence is a code listing, not a hatch:

```typst
#let x = 1
```

A listing's attribute block names its language by its first class:

```{#lst:setup .python}
x = 1
```

Any other raw format is a listing too, never run:

```{=latex}
\vspace{1em}
```
