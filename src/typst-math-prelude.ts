// The Typst definitions native math converted from LaTeX may name.
//
// math-convert.ts turns LaTeX into Typst math with mitex's converter, whose
// output calls a few handles that are not in Typst's standard library
// (`frac` with LaTeX's argument order, `mitexsqrt`, `aligned`, the colour
// and phantom handles, …). mitex itself evaluated that output inside its
// `mitex-scope`; Plass prints it as ordinary math and defines, at the top
// of the document, exactly the handles the document's math names.
//
// Derived from mitex 0.2.7 (https://github.com/mitex-rs/mitex,
// Apache-2.0, © the mitex authors; license text in src/mitex/LICENSE and
// the distributed THIRD_PARTY_NOTICES.txt): every entry of
// `specs/latex/standard.typ` that puts a value into `mitex-scope`, with the
// helpers those values use. Modified by Plass: each scope entry is written
// as a top-level `#let` of the value the spec computes (the `define-*`
// wrappers that build the converter's spec are gone; the value is the
// same expression), and `set`, a Typst keyword no `#let` can bind, is
// `mitexset` (math-convert.ts renames the call). Nothing else is changed:
// the identity of every formula's ink with `#mi`/`#mitex` rests on these
// being the same values.

interface Definition {
  /** The name a formula's Typst calls (or, for a helper, a definition). */
  name: string;
  /** The `#let` line(s). */
  typst: string;
  /** Prelude names this definition's value uses. */
  uses?: readonly string[];
  /** A helper: only ever emitted because a handle uses it. */
  helper?: true;
}

const def = (name: string, value: string, uses?: readonly string[]): Definition => ({
  name,
  typst: `#let ${name} = ${value}`,
  uses,
});
const helper = (name: string, typst: string, uses?: readonly string[]): Definition => ({ name, typst, uses, helper: true });

const STR = ['get-tex-str'] as const;
const GREEDY = ['_greedy-handle'] as const;
const COLOR = ['get-tex-color'] as const;

/** In emission order: a definition comes after everything it uses. */
const DEFINITIONS: readonly Definition[] = [
  // Helpers (standard.typ §0 and §1).
  helper(
    'mitex-color-map',
    String.raw`#let mitex-color-map = (
  "red": rgb(255, 0, 0),
  "green": rgb(0, 255, 0),
  "blue": rgb(0, 0, 255),
  "cyan": rgb(0, 255, 255),
  "magenta": rgb(255, 0, 255),
  "yellow": rgb(255, 255, 0),
  "black": rgb(0, 0, 0),
  "white": rgb(255, 255, 255),
  "gray": rgb(128, 128, 128),
  "lightgray": rgb(192, 192, 192),
  "darkgray": rgb(64, 64, 64),
  "brown": rgb(165, 42, 42),
  "orange": rgb(255, 165, 0),
  "pink": rgb(255, 182, 193),
  "purple": rgb(128, 0, 128),
  "teal": rgb(0, 128, 128),
  "olive": rgb(128, 128, 0),
)`,
  ),
  helper(
    'get-tex-str-from-arr',
    String.raw`#let get-tex-str-from-arr(arr) = arr.filter(it => it != [ ] and it != [#math.zws]).map(it => it.text).sum()`,
  ),
  helper(
    'get-tex-str',
    String.raw`#let get-tex-str(tex) = if tex.has("children") {
  get-tex-str-from-arr(tex.children)
} else {
  tex.text
}`,
    ['get-tex-str-from-arr'],
  ),
  helper(
    'get-tex-color',
    String.raw`#let get-tex-color(model, spec) = {
  let model = if type(model) == content and model.has("text") {
    model.text
  } else if type(model) == str {
    model
  } else {
    model
  }

  let s = if type(spec) == str {
    spec
  } else if type(spec) == content and spec.has("text") {
    spec.text
  } else if (
    type(spec) == content and spec.has("children")
  ) {
    spec.children.map(it => if it.has("text") { it.text } else { "" }).join("")
  } else {
    ""
  }

  if model == none {
    mitex-color-map.at(lower(s), default: none)
  } else if model == "gray" {
    luma(float(s) * 100%)
  } else if model == "rgb" {
    rgb(..s.split(",").map(x => float(x) * 100%))
  } else if model == "RGB" {
    rgb(..s.split(",").map(x => int(x)))
  } else if model == "HTML" {
    rgb("#" + s)
  } else if model == "cmyk" {
    cmyk(..s.split(",").map(x => float(x) * 100%))
  } else {
    none
  }
}`,
    ['mitex-color-map'],
  ),
  helper('_greedy-handle', String.raw`#let _greedy-handle(fn) = (..args) => $fn(#args.pos().sum())$`),
  // arrow-handle's and limits-handle's handles, without the spec wrapper.
  helper('mitex-arrow', String.raw`#let mitex-arrow(arrow-sym) = it => $limits(stretch(#arrow-sym)^#it)$`),
  helper('mitex-limits', String.raw`#let mitex-limits(wrap) = it => math.limits(wrap(it))`),
  helper(
    'call-or-ignore',
    String.raw`#let call-or-ignore(fn) = (..args) => if args.pos().len() > 0 {
  fn(..args)
} else {
  math.zws
}`,
  ),
  helper('ignore-me', String.raw`#let ignore-me = (..args) => { }`),

  // The scope entries, in standard.typ's order (§2).
  def('mitexcite', 'it => cite(label(get-tex-str(it)))', STR),
  def('mitexlabel', 'ignore-me', ['ignore-me']),
  def('mitexref', 'it => ref(label(get-tex-str(it)))', STR),
  def('mitexcaption', 'ignore-me', ['ignore-me']),
  def('miteximage', 'ignore-me', ['ignore-me']),
  def('negthinspace', 'h(-(3/18) * 1em)'),
  def('negthinmedspace', 'h(-(3/18) * 1em)'),
  def('negmedspace', 'h(-(4/18) * 1em)'),
  def('negthickspace', 'h(-(5/18) * 1em)'),
  def('enspace', 'h((1/2) * 1em)'),
  def('phantom', 'hide'),
  def('hphantom', 'it => box(height: 0pt, hide(it))'),
  def('vphantom', 'it => box(width: 0pt, hide(it))'),
  def('smash', 'it => box(height: 0pt, align(bottom, $#it$))'),
  def('lvert', 'math.class("opening", "|")'),
  def('rvert', 'math.class("closing", "|")'),
  def('lVert', 'math.class("opening", "||")'),
  def('rVert', 'math.class("closing", "||")'),
  def('mitexdisplay', '_greedy-handle(math.display)', GREEDY),
  def('mitexinline', '_greedy-handle(math.inline)', GREEDY),
  def('mitexscript', '_greedy-handle(math.script)', GREEDY),
  def('mitexsscript', '_greedy-handle(math.sscript)', GREEDY),
  def('mitexbold', '_greedy-handle(it => math.bold(math.upright(it)))', GREEDY),
  def('mitexupright', '_greedy-handle(math.upright)', GREEDY),
  def('mitexitalic', '_greedy-handle(math.italic)', GREEDY),
  def('mitexsans', '_greedy-handle(math.sans)', GREEDY),
  def('mitexfrak', '_greedy-handle(math.frak)', GREEDY),
  def('mitexmono', '_greedy-handle(math.mono)', GREEDY),
  def('mitexcal', '_greedy-handle(math.cal)', GREEDY),
  def('mitexmathbf', 'it => math.bold(math.upright(it))'),
  def(
    'mathscr',
    String.raw`it => {
  let s = get-tex-str(it)
  s.clusters().map(x => $scr(#x)$).join()
}`,
    STR,
  ),
  def('mathbin', 'it => math.class("binary", it)'),
  def('mathclose', 'it => math.class("closing", it)'),
  def('mathinner', 'it => math.class("fence", it)'),
  def('mathop', 'it => math.class("unary", it)'),
  def('mathopen', 'it => math.class("opening", it)'),
  def('mathord', 'it => math.class("normal", it)'),
  def('mathpunct', 'it => math.class("punctuation", it)'),
  def('mathrel', 'it => math.class("relation", it)'),
  def('big', 'it => math.lr(size: 1.2em, it)'),
  def('Big', 'it => math.lr(size: 1.8em, it)'),
  def('bigg', 'it => math.lr(size: 2.4em, it)'),
  def('Bigg', 'it => math.lr(size: 3em, it)'),
  def(
    'mitexcolor',
    String.raw`(model, texcolor, ..args) => {
  let color = get-tex-color(model, texcolor)
  if color != none {
    text(fill: color, args.pos().sum())
  } else {
    args.pos().sum()
  }
}`,
    COLOR,
  ),
  def(
    'colortext',
    String.raw`(model, texcolor, body) => {
  let color = get-tex-color(model, texcolor)
  if color != none {
    text(fill: color, body)
  } else {
    body
  }
}`,
    COLOR,
  ),
  def(
    'mitexcolorbox',
    String.raw`(model, texcolor, body) => {
  let color = get-tex-color(model, texcolor)
  if color != none {
    box(fill: color, inset: (x: 3pt), outset: (y: 3pt), radius: 2pt, body)
  } else {
    body
  }
}`,
    COLOR,
  ),
  def('frac', '(num, den) => $(num)/(den)$'),
  def('cfrac', '(num, den) => $display((num)/(den))$'),
  def('dfrac', '(num, den) => $display((num)/(den))$'),
  def('tfrac', '(num, den) => $inline((num)/(den))$'),
  def('dbinom', '(n, k) => $display(binom(#n, #k))$'),
  def('tbinom', '(n, k) => $inline(binom(#n, #k))$'),
  def('stackrel', '(sup, base) => $limits(base)^(sup)$'),
  def('substack', 'it => it'),
  def('overset', '(sup, base) => $limits(base)^(sup)$'),
  def('underset', '(sub, base) => $limits(base)_(sub)$'),
  def('mitexnot', 'it => math.cancel(angle: 20deg, it)'),
  def('xcancel', 'math.cancel'),
  def('bcancel', 'math.cancel.with(inverted: true)'),
  def('sout', 'math.cancel.with(angle: 90deg)'),
  def('mitexoverbrace', 'mitex-limits(math.overbrace)', ['mitex-limits']),
  def('mitexunderbrace', 'mitex-limits(math.underbrace)', ['mitex-limits']),
  def('mitexoverbracket', 'mitex-limits(math.overbracket)', ['mitex-limits']),
  def('mitexunderbracket', 'mitex-limits(math.underbracket)', ['mitex-limits']),
  def('boxed', 'it => box(stroke: 0.5pt, inset: 6pt, $it$)'),
  def('ngeqq', String.raw`math.cancel(angle: 20deg, "\u{2267}")`),
  def('nleqslant', 'math.cancel(angle: 20deg, length: 1em, math.lt.eq.slant)'),
  def('nleqq', String.raw`math.cancel(angle: 20deg, "\u{2266}")`),
  def('nsubseteqq', String.raw`math.cancel(angle: 20deg, length: 1em, "\u{2AC5}")`),
  def('nsupseteqq', String.raw`math.cancel(angle: 20deg, length: 1em, "\u{2AC6}")`),
  def('arctg', 'math.op("arctg")'),
  def('ch', 'math.op("ch")'),
  def('cth', 'math.op("cth")'),
  def('th', 'math.op("th")'),
  def('arcctg', 'math.op("arcctg")'),
  def('cosec', 'math.op("cosec")'),
  def('cotg', 'math.op("cotg")'),
  def('injlim', String.raw`math.op("inj\u{2009}lim", limits: true)`),
  def('mathclap', 'it => box(width: 0pt, $it$)'),
  def('mathring', 'it => math.circle(it)'),
  def('overgroup', String.raw`it => $accent(it, \u{0311})$`),
  def('undergroup', String.raw`it => $accent(it, \u{032e})$`),
  def('overleftharpoon', String.raw`it => $accent(it, \u{20d0})$`),
  def('overleftrightarrow', String.raw`it => $accent(it, \u{20e1})$`),
  def('overlinesegment', String.raw`it => $accent(it, \u{20e9})$`),
  def('overrightharpoon', String.raw`it => $accent(it, \u{20d1})$`),
  def('underbar', 'it => $underline(it)$'),
  def('plim', 'math.op("plim", limits: true)'),
  def('projlim', String.raw`math.op("proj\u{2009}lim", limits: true)`),
  def('raisebox', '(sp, it) => text(baseline: -eval(get-tex-str(sp)), it)', STR),
  def('sh', 'math.op("sh")'),
  def('smallint', '$inline(integral)$'),
  def('thickapprox', '$bold(approx)$'),
  def('thicksim', '$bold(tilde)$'),
  def('varDelta', '$italic(Delta)$'),
  def('varGamma', '$italic(Gamma)$'),
  def('varLambda', '$italic(Lambda)$'),
  def('varOmega', '$italic(Omega)$'),
  def('varPhi', '$italic(Phi)$'),
  def('varPi', '$italic(Pi)$'),
  def('varPsi', '$italic(Psi)$'),
  def('varSigma', '$italic(Sigma)$'),
  def('varTheta', '$italic(Theta)$'),
  def('varUpsilon', '$italic(Upsilon)$'),
  def('varXi', '$italic(Xi)$'),
  ...(
    [
      ['xleftarrow', 'math.arrow.l'],
      ['xrightarrow', 'math.arrow.r'],
      ['xLeftarrow', 'math.arrow.l.double'],
      ['xRightarrow', 'math.arrow.r.double'],
      ['xleftrightarrow', 'math.arrow.l.r'],
      ['xLeftrightarrow', 'math.arrow.l.r.double'],
      ['xhookleftarrow', 'math.arrow.l.hook'],
      ['xhookrightarrow', 'math.arrow.r.hook'],
      ['xtwoheadleftarrow', 'math.arrow.l.twohead'],
      ['xtwoheadrightarrow', 'math.arrow.r.twohead'],
      ['xleftharpoonup', 'math.harpoon.lt'],
      ['xrightharpoonup', 'math.harpoon.rt'],
      ['xleftharpoondown', 'math.harpoon.lb'],
      ['xrightharpoondown', 'math.harpoon.rb'],
      ['xleftrightharpoons', 'math.harpoons.ltrb'],
      ['xrightleftharpoons', 'math.harpoons.rtlb'],
      ['xtofrom', 'math.arrows.rl'],
      ['xmapsto', 'math.arrow.r.bar'],
      ['xlongequal', 'math.eq'],
    ] as const
  ).map(([name, arrow]) => def(name, `mitex-arrow(${arrow})`, ['mitex-arrow'])),
  def('pmod', 'it => $quad (mod thick it)$'),
  def('pod', 'it => $quad (it)$'),
  // mitex-scope's `set` (see the header).
  def('mitexset', String.raw`it => $\{it\}$`),
  def('Set', String.raw`it => $lr(\{it\})$`),
  def('bra', 'it => $chevron.l it|$'),
  def('Bra', 'it => $lr(chevron.l it|)$'),
  def('ket', 'it => $|it chevron.r$'),
  def('Ket', 'it => $lr(|it chevron.r)$'),
  def('braket', 'it => $chevron.l it chevron.r$'),
  def('Braket', 'it => $lr(chevron.l it chevron.r)$'),
  def('fbox', 'it => box(stroke: 0.5pt, $it$)'),
  def('hbox', 'it => it'),
  // matrix-handle: the value is math.mat with the delimiter (it ignores a
  // handle argument, so smallmatrix is the plain matrix).
  def('matrix', 'math.mat.with(delim: none)'),
  def('pmatrix', 'math.mat.with(delim: "(")'),
  def('bmatrix', 'math.mat.with(delim: "[")'),
  def('Bmatrix', 'math.mat.with(delim: "{")'),
  def('vmatrix', 'math.mat.with(delim: "|")'),
  def('Vmatrix', 'math.mat.with(delim: "||")'),
  def('smallmatrix', 'math.mat.with(delim: none)'),
  def(
    'mitexarray',
    String.raw`(arg0: ("l",), ..args) => {
  if args.pos().len() == 0 {
    return
  }
  if type(arg0) != str {
    if arg0.has("children") {
      arg0 = arg0.children.filter(it => it != [ ] and it != [#math.zws])
        .map(it => it.text)
        .filter(it => it == "l" or it == "c" or it == "r")
    } else {
      arg0 = (arg0.text,)
    }
  }
  let matrix = args.pos().map(row => if type(row) == array { row } else { (row,) } )
  let n = matrix.len()
  let m = calc.max(..matrix.map(row => row.len()))
  matrix = matrix.map(row => row + (m - row.len()) * (none,))
  let array-at(arr, pos) = {
    arr.at(calc.min(pos, arr.len() - 1))
  }
  let align-map = ("l": left, "c": center, "r": right)
  set align(align-map.at(array-at(arg0, 0)))
  pad(y: 0.2em, grid(
    columns: m,
    column-gutter: 0.5em,
    row-gutter: 0.5em,
    ..matrix.flatten().map(it => $it$)
  ))
}`,
  ),
  def('aligned', 'call-or-ignore(it => pad(y: 0.2em, block(math.op(math.display(it)))))', ['call-or-ignore']),
  def('alignedat', '(arg0: none, it) => pad(y: 0.2em, block(math.op(it)))'),
  def('rcases', 'math.cases.with(reverse: true)'),
  def('KaTeX', 'math.upright($K A T E X$)'),
  def('LaTeX', 'math.upright($L A T E X$)'),
  def('TeX', 'math.upright($T E X$)'),
  def('middle', 'it => math.mid(it)'),
  def('operatorname', 'it => math.op(math.upright(it))'),
  {
    name: 'operatornamewithlimits',
    typst: '#let operatornamewithlimits(it) = math.op(limits: true, math.upright(it))',
  },
  def('vspace', 'it => v(eval(get-tex-str(it)))', STR),
  def('hspace', 'it => h(eval(get-tex-str(it)))', STR),
  def('textmath', 'it => it'),
  def('textmd', 'it => it'),
  def('textnormal', 'it => it'),
  def('textbf', 'math.bold'),
  def('textit', 'math.italic'),
  def('textrm', 'math.upright'),
  def('textup', 'math.upright'),
  def('textsf', 'math.sans'),
  def('texttt', 'math.mono'),
  def('atop', '(a, b) => $mat(delim: #none, #a; #b)$'),
  def('binom', 'math.binom'),
  def('brace', '(n, k) => $mat(delim: "{", #n;; #k)$'),
  def('brack', '(n, k) => $mat(delim: "[", #n;; #k)$'),
  def(
    'mitexsqrt',
    String.raw`(..args) => {
  if args.pos().len() == 1 {
    $sqrt(#args.pos().at(0))$
  } else if args.pos().len() == 2 {
    $root(
      #args.pos().at(0).children.filter(it => it != [\[] and it != [\]]).sum(),
      #args.pos().at(1)
    )$
  } else {
    panic("unexpected args in sqrt")
  }
}`,
  ),
];

const BY_NAME = new Map(DEFINITIONS.map((d) => [d.name, d]));

/** The names a formula's Typst may call: every definition but the helpers. */
export const MATH_HANDLE_NAMES: readonly string[] = DEFINITIONS.filter((d) => !d.helper).map((d) => d.name);

/**
 * The prelude for a set of converted formulas: the `#let` definitions of
 * every handle their Typst names, with the helpers those use, in
 * dependency order; '' when they name none. A name counts when it appears
 * as a whole identifier (letters and digits), which may over-include — a
 * `\text{frac}` brings `frac` — and never under-includes.
 */
export function mathPrelude(formulas: Iterable<string>): string {
  const wanted = new Set<string>();
  const want = (name: string) => {
    const d = BY_NAME.get(name);
    if (!d || wanted.has(name)) return;
    wanted.add(name);
    for (const used of d.uses ?? []) want(used);
  };
  for (const typ of formulas) {
    for (const [word] of typ.matchAll(/\p{L}[\p{L}\p{Nd}]*/gu)) {
      if (!BY_NAME.get(word)?.helper) want(word);
    }
  }
  return DEFINITIONS.filter((d) => wanted.has(d.name))
    .map((d) => d.typst + '\n')
    .join('');
}
