// PM doc -> Markdown (.md save path): Pandoc Markdown, the mirror of
// md-parser (docs/MARKDOWN-SOURCE-PLAN.md "The format";
// docs/MARKDOWN-FORMAT.md). Standard CommonMark/pandoc forms wherever the
// model maps — the typing syntax IS Markdown — and pandoc's own extensions
// for the rest:
//
//   - fenced divs, with a blank line before and after every `:::` line:
//     `::: solution`, one `::: {.columns gutter=1em}` per grid row (later
//     rows `.continued`) holding `::: {.column width=60%}` cells,
//     `::: {.table …}` around a pipe table that needs more than the pipe
//     table says (md-tables.ts), `::: center` / `::: right` /
//     `::: {.keep}` around one paragraph; an outer fence is longer than
//     the ones it holds
//   - attribute blocks: `# Title {#sec:x}`, `$$ … $$ {#eq:x .unnumbered}`,
//     `![Caption](src){#fig:x width=60%}`
//   - `<!-- … -->` editorial comments, `\newpage`, ```` ```{=typst} ````
//     islands, the ```` ```{=bibtex} ```` bibliography where its node is,
//     `[@a; @b]` citation groups and bare `@eq:x` references
//   - the YAML front matter (md-frontmatter.ts): the settings that are not
//     the defaults, the roman restart, and the title, author, date and
//     abstract written as body text is
//
// What Markdown cannot say is reported through `warn`, never dropped
// silently.

import MarkdownIt from 'markdown-it';
import type { Node as PMNode, Mark } from 'prosemirror-model';
import type { DocSettings } from './settings';
import { commentToMd } from './editor-comments-format';
import { writeAttrBlock, writeFenceAttrs, readAttrBlock, type PandocAttrs } from './md-attrs';
import { pipeTableMd, tableDivAttrs } from './md-tables';
import { readFrontmatter, writeFrontmatter, type TextKey } from './md-frontmatter';
import { readFrontText } from './md-parser';

const NAMESPACE = /^(?:eq|fig|sec|tbl):/;
// A character a citation key may continue with (pandoc: letters, digits,
// `_`, or internal punctuation before one of those).
const KEY_CONTINUES = /^(?:[\p{L}\p{N}_]|[:.#$%&\-+?<>~/][\p{L}\p{N}_])/u;

/** The longest run of `ch` in `text`. */
function longestRun(text: string, ch: string): number {
  let best = 0;
  for (const m of text.matchAll(new RegExp(`\\${ch}+`, 'g'))) best = Math.max(best, m[0].length);
  return best;
}

/** A code span (or a raw span's code) holding `text`: a fence one backtick
 *  longer than any run inside, and a space inside each end where the
 *  reader would otherwise take one away (CommonMark's rule, which the
 *  reader follows: one space off each end when both ends have one and the
 *  span is not all spaces) or a backtick would touch the fence. */
function codeSpan(text: string): string {
  const fence = '`'.repeat(longestRun(text, '`') + 1);
  const pad = /^`|`$/.test(text) || (/^ [\s\S]* $/.test(text) && text.trim()) ? ' ' : '';
  return fence + pad + text + pad + fence;
}

/** markdown-it's own normalization of a destination, which the reader
 *  applies to every address but a `data:` URL. */
let normalizer: { normalizeLink(url: string): string } | null = null;

/** A link's or an image's destination as Markdown writes it: outside a
 *  `data:` URL, as the reader will hold it after reading it back
 *  (markdown-it's percent-encoding: white space, a backslash, a backtick,
 *  angle brackets, non-ASCII), so the next save writes the same; inside
 *  one, white space percent-encoded (a space would end it) and a backslash
 *  escaped. A parenthesis is escaped in both (one unbalanced would end the
 *  destination). */
const destination = (href: string) => {
  if (/^data:/i.test(href)) return href.replace(/[\\()]|\s/g, (c) => (/\s/.test(c) ? encodeURIComponent(c) : `\\${c}`));
  normalizer ??= new MarkdownIt();
  return normalizer.normalizeLink(href).replace(/[()]/g, '\\$&');
};

/** A number as Markdown writes it: at most three decimals, no trailing
 *  zeros. */
const num = (n: number) => String(Math.round(n * 1000) / 1000);

/** Grid shares as the reader holds them: each over the smallest, to three
 *  decimals (md-parser's `canonicalShares`). */
const canonical = (shares: number[]) => {
  const min = Math.min(...shares);
  return shares.map((s) => Math.round((s / min) * 1000) / 1000);
};

/** Each share's percent of the row, to three decimals or, when three would
 *  read back as other shares (`1:12` is 7.692%/92.308%, which reads as
 *  `[1, 12.001]`), to as many as it takes; `Nfr` (read exactly) if none
 *  does. */
function percents(shares: number[]): string[] {
  const want = canonical(shares).join();
  const total = shares.reduce((a, b) => a + b, 0);
  for (let digits = 3; digits <= 12; digits++) {
    const scale = 10 ** digits;
    const written = shares.map((s) => String(Math.round((s / total) * 100 * scale) / scale));
    if (written.every((w) => Number(w) > 0) && canonical(written.map(Number)).join() === want) return written.map((w) => `${w}%`);
  }
  return canonical(shares).map((s) => `${s}fr`);
}

/** An ordered-list marker at the head of a line, by pandoc's fancy_lists
 *  and example_lists: a number, a letter, a roman numeral, `#` or an
 *  example `@`, closed by `.` or `)` or wrapped in parentheses, then a
 *  space, a tab or the line's end. */
const LIST_MARK = /^([ \t]*)(\(?)(\d{1,9}|[a-zA-Z]|[ivxlcdm]+|[IVXLCDM]+|#|@)([.)])([ \t]*)/;

/** A line whose head pandoc would read as an ordered-list marker, with its
 *  delimiter escaped (`a\)`, `(iv\)`). One capital letter and a period
 *  open a list only before two spaces, a tab or the line's end, so
 *  `B. Russell` stays as written. */
function escMarker(line: string): string {
  const m = LIST_MARK.exec(line);
  if (!m) return line;
  const [all, lead, paren, mark, delim, gap] = m;
  if (paren && delim !== ')') return line;
  const ends = all.length === line.length;
  if (!ends && !gap) return line;
  if (!paren && delim === '.' && /^[A-Z]$/.test(mark) && !ends && gap.length < 2 && !gap.includes('\t')) return line;
  const at = lead.length + paren.length + mark.length;
  return line.slice(0, at) + '\\' + line.slice(at);
}

/** Serialize to Markdown. `offsets`, when given, receives the text offset
 *  at which each top-level block's serialization begins (index = position
 *  of the block in `doc`); blocks that produce no Markdown of their own
 *  (title/author/date live in the frontmatter) get the offset of whatever
 *  follows them. Block-level caret mapping for the source view
 *  (SOURCE-VIEW.md, decision 5). */
export function docToMd(doc: PMNode, warn: (m: string) => void = () => {}, offsets?: number[]): string {
  const out: string[] = [];
  /** Plass's notes, label and text, written after the body. */
  const footnotes: Array<[string, string]> = [];

  // Labels in use, so an uncaptioned figure written with a made-up label
  // (its only Markdown form as a figure) takes one nobody else has.
  const labels = new Set<string>();
  doc.descendants((n) => {
    if (n.attrs.label) labels.add(n.attrs.label as string);
    return true;
  });
  const freshLabel = () => {
    let k = 1;
    while (labels.has(`fig:figure-${k}`)) k++;
    labels.add(`fig:figure-${k}`);
    return `fig:figure-${k}`;
  };

  // Footnote labels that content kept as source (an island) uses: Plass's
  // own notes are numbered around them, so a kept `[^1]` never meets
  // another note's definition.
  const islandNotes = new Set<string>();
  doc.descendants((n) => {
    if (n.type.name === 'code_block' && n.attrs.params === 'md-raw') for (const m of n.textContent.matchAll(/\[\^([^\]\s]+)\]/g)) islandNotes.add(m[1]);
    return !n.isTextblock;
  });
  let noteNo = 0;
  const nextNote = () => {
    do noteNo++;
    while (islandNotes.has(String(noteNo)));
    return String(noteNo);
  };

  /** Text as Markdown writes it. `brackets` escapes every bracket (a
   *  link's text, an image's caption), where one would end the label. */
  const esc = (text: string, brackets = false): string =>
    (brackets
      ? text.replace(/([\\`*$[\]])/g, '\\$1')
      : text
          .replace(/([\\`*$])/g, '\\$1')
          // Brackets only where they would read as a link, reference,
          // footnote or citation: `[note]` alone is text and stays readable.
          .replace(/\[(?=[@^])/g, '\\[')
          .replace(/\](?=[([])/g, '\\]')
    )
      // `@word` would be a citation; after a letter or digit it is not
      // (`a@b.org`).
      .replace(/(?<![\p{L}\p{N}_])@(?=[\p{L}\p{N}_])/gu, '\\@')
      // `~x~` and `^x^` are pandoc's sub- and superscript, `~~x~~` a
      // strike: every `~` or `^` in a run of text that holds two of them.
      .replace(/\S+/g, (run) => {
        let r = run;
        if ((r.match(/~/g) ?? []).length > 1) r = r.replace(/~/g, '\\~');
        if ((r.match(/\^/g) ?? []).length > 1) r = r.replace(/\^/g, '\\^');
        return r;
      })
      // `^[` opens an inline footnote (a caret an even run of backslashes
      // precedes is unescaped: `\\` is a backslash).
      .replace(/(?<=(?:^|[^\\])(?:\\\\)*)\^(?=\[)/g, '\\^')
      // Raw HTML and character references would be read as markup.
      .replace(/<(?=[A-Za-z/!?])/g, '\\<')
      .replace(/&(?=#?[A-Za-z0-9]+;)/g, '\\&')
      // Underscores: every one in a run of two or more (a blank to fill in
      // would otherwise be read as emphasis delimiters), and a lone one at
      // a word boundary (before an escape too: `_\$` opens emphasis);
      // snake_case stays bare.
      .replace(/_{2,}/g, (run) => run.replace(/_/g, '\\_'))
      .replace(/(^|\s)_/g, '$1\\_')
      .replace(/(?<!\\)_(?=\s|$)/g, '\\_');

  /** Escape what would start a block at the head of a line of paragraph
   *  text: a heading, a quote, a list item (pandoc's fancy and example
   *  markers too), a div fence, a code fence, a setext underline or rule,
   *  a reference definition, a line block, a definition. */
  const escLines = (md: string): string =>
    md
      .split('\n')
      .map((line) =>
        escMarker(
          line
            .replace(/^([ \t]*)([#>])/, '$1\\$2')
            .replace(/^([ \t]*)([-+])(?=[ \t]|$)/, '$1\\$2')
            .replace(/^([ \t]*)(:{3,})/, '$1\\$2')
            .replace(/^([ \t]*)(=+[ \t]*)$/, '$1\\$2')
            .replace(/^([ \t]*)(-[- \t]*)$/, '$1\\$2')
            .replace(/^(\[[^\]]*\]):/, '$1\\:')
            .replace(/^([ \t]*)([|:~])(?=[ \t]|$)/, '$1\\$2'),
        ),
      )
      .join('\n');

  /** A run of adjacent citations as one pandoc group. */
  const citeGroup = (keys: string[]) => `[${keys.map((k) => `@${k}`).join('; ')}]`;

  /** Inline content. `brackets` escapes every bracket (an image's caption,
   *  a link's text). Strong, emphasis and strike are delimiter pairs held open across
   *  neighbours that share them, outer marks staying outer (`*a **b** c*`),
   *  so overlapping marks nest instead of colliding (`***Note.**** …*`
   *  would read back with literal asterisks); a text's edge whitespace
   *  moves outside the delimiters that open or close around it, where
   *  CommonMark needs it. Inline math takes part like text, so a formula
   *  stays inside its span (`**$2$ drinks**`, as the .typ exporter does);
   *  other atoms carry their own marks (usually none). */
  const inline = (node: PMNode, brackets = false): string => {
    let md = '';
    /** The last character written (reading `md` itself would flatten the
     *  growing string on every call). */
    let last = '';
    /** Where the last formula written ends. */
    let mathEnd = -1;
    const put = (s: string) => {
      if (!s) return;
      // `^[` opens an inline footnote and `![` an image: a caret that ended
      // the text before a citation group, a footnote marker or a link is
      // escaped, and a bang before a link (`![^1]` and `![@k]` are text).
      if (s[0] === '[' && (last === '^' || (last === '!' && !/^\[[@^]/.test(s)))) {
        let slashes = 0;
        while (md[md.length - 2 - slashes] === '\\') slashes++;
        if (slashes % 2 === 0) md = md.slice(0, -1) + '\\' + last;
      }
      md += s;
      last = s[s.length - 1];
    };
    /** Where what is written is one inline to pandoc (a formula, a code or
     *  raw span, a link, an image, a citation, a footnote marker) or a
     *  delimiter: a `~` or `^` there never pairs with one outside. */
    const opaque: Array<[number, number]> = [];
    const putWhole = (s: string) => {
      put(s);
      if (s) opaque.push([md.length - s.length, md.length]);
    };
    const DELIM: Record<string, string> = { strike: '~~', strong: '**', em: '*' };
    /** A delimiter. A text `~` right before a strike's `~~`, opening or
     *  closing, would join its run (`~~~x~~` opens a fence at a line's
     *  start; `~~x~~~` closes before the text's `~`): it is escaped. */
    const putDelim = (mark: string) => {
      if (mark === 'strike' && last === '~') {
        let slashes = 0;
        while (md[md.length - 2 - slashes] === '\\') slashes++;
        if (slashes % 2 === 0) md = md.slice(0, -1) + '\\~';
      }
      putWhole(DELIM[mark]);
    };
    let active: string[] = [];
    /** Whitespace that ended the last text, written once the marks around
     *  it have closed. */
    let pending = '';
    const marksOf = (child: PMNode) => Object.keys(DELIM).filter((n) => child.marks.some((m: Mark) => m.type.name === n));
    const children: PMNode[] = [];
    node.forEach((child) => children.push(child));
    /** How many children from `at` on carry `mark`: the mark that runs
     *  longest opens outermost, so it need not close and reopen. */
    const spanOf = (at: number, mark: string) => {
      let n = 0;
      while (at + n < children.length && marksOf(children[at + n]).includes(mark)) n++;
      return n;
    };
    /** Close the open marks `want` lacks (the innermost first), write the
     *  held whitespace, then open what `want` adds — after `lead`, the
     *  text's leading whitespace, which is returned when nothing opens. */
    const moveTo = (want: string[], lead = '', at = -1): string => {
      let keep = 0;
      while (keep < active.length && want.includes(active[keep])) keep++;
      for (let k = active.length - 1; k >= keep; k--) putDelim(active[k]);
      active = active.slice(0, keep);
      put(pending);
      pending = '';
      const opening = want.filter((m) => !active.includes(m));
      if (at >= 0) opening.sort((a, b) => spanOf(at, b) - spanOf(at, a));
      if (opening.length) {
        put(lead);
        lead = '';
      }
      for (const m of opening) {
        putDelim(m);
        active.push(m);
      }
      return lead;
    };
    /** Text the next node starts with (for the guards below). */
    const nextText = (k: number) => {
      const next = children[k + 1];
      // A delimiter written between them (the two differ in strong,
      // emphasis or strike) ends a citation key there.
      const delimited = !!next && marksOf(next).join() !== marksOf(children[k]).join();
      return next?.isText && !delimited && !next.marks.some((m) => m.type.name === 'code' || m.type.name === 'link') ? next.text ?? '' : '';
    };
    /** Where the printed text ends: a line break after it (spaces around
     *  it aside) prints nothing in Typst and has no Markdown form (`\`
     *  there is a literal backslash), so it is left out. */
    let solidEnd = children.length;
    const blank = (c: PMNode) => c.type.name === 'hard_break' || (c.isText && /^[ \t\n]*$/.test(c.text ?? '') && !c.marks.some((m: Mark) => m.type.name === 'code'));
    while (solidEnd > 0 && blank(children[solidEnd - 1])) solidEnd--;
    if (children.slice(solidEnd).filter((c) => c.type.name === 'hard_break').length > 1) {
      warn('line breaks at the end of a paragraph have no Markdown form — dropped (Typst printed the first as nothing, the others as blank lines)');
    }
    for (let k = 0; k < children.length; k++) {
      const child = children[k];
      const link = child.isText ? child.marks.find((m: Mark) => m.type.name === 'link') : undefined;
      if (link) {
        // A link is one `[…](…)` over every text it spans: the marks they
        // all share stay outside it, the rest are written inside (a
        // delimiter in a link's text pairs only there).
        let end = k;
        while (end + 1 < children.length && children[end + 1].isText && children[end + 1].marks.some((m: Mark) => m.eq(link))) end++;
        const run = children.slice(k, end + 1);
        const shared = marksOf(child).filter((name) => run.every((c) => marksOf(c).includes(name)));
        moveTo(shared, '', k);
        const label = inline(
          node.type.create(
            node.attrs,
            run.map((c) => c.mark(c.marks.filter((m: Mark) => m.type.name !== 'link' && !shared.includes(m.type.name)))),
          ),
          true,
        );
        const title = link.attrs.title as string | null;
        putWhole(`[${label}](${destination(link.attrs.href as string)}${title ? ` "${title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : ''})`);
        k = end;
        continue;
      }
      if (child.isText && child.text) {
        const marks = child.marks;
        const has = (name: string) => marks.some((m: Mark) => m.type.name === name);
        const want = marksOf(child);
        // Code is written exactly; other text gives its edge whitespace to
        // the delimiters' outside.
        const [, lead, inner, trail] = has('code') ? ['', '', child.text, ''] : /^(\s*)([\s\S]*?)(\s*)$/.exec(child.text)!;
        if (!inner) {
          // Whitespace alone cannot open a mark in Markdown: it keeps
          // only the marks already open around it.
          moveTo(active.filter((m) => want.includes(m)));
          pending += lead + trail;
          continue;
        }
        const rest = moveTo(want, lead, k);
        put(rest);
        let t: string;
        if (has('code')) t = codeSpan(inner);
        else {
          t = esc(inner, brackets);
          // A `{` right after code or an image would read as its
          // attributes; `(`/`[` right after a citation's `]` as a link.
          const tail = last;
          if ((/^[{]/.test(t) && /[`)]$/.test(tail)) || (/^[([]/.test(t) && tail === ']')) t = '\\' + t;
          // A `~` right after a strike's `~~` would join its run.
          if (t[0] === '~' && tail === '~') t = '\\' + t;
          // A digit right after a formula's closing `$` would unmake the
          // formula (pandoc's rule): the digit is written as its character
          // reference, which reads back as the digit.
          if (md.length === mathEnd && /^\d/.test(t)) t = `&#${t.charCodeAt(0)};${t.slice(1)}`;
        }
        if (has('code')) putWhole(t);
        else put(t);
        pending = trail;
        continue;
      }
      moveTo(marksOf(child), '', k);
      switch (child.type.name) {
        case 'math_inline': {
          // One line: a formula's soft break reads back as its space. Spaces
          // at its edges print nothing and would unmake it (`$ y $` is
          // text), so they go, but for one a backslash escapes (TeX's
          // control space: `$x\ $` is a formula, `$x\$` an escaped dollar);
          // a formula of spaces alone prints nothing and has no form (`$$`
          // opens display math).
          const line = (child.attrs.src as string).replace(/\s*\n\s*/g, ' ').replace(/^\s+/, '');
          let src = line.replace(/\s+$/, '');
          // (A formula ending in a lone backslash gets the space too: `\$`
          // would be an escaped dollar.)
          if ((/\\+$/.exec(src)?.[0].length ?? 0) % 2) src += ' ';
          if (!src) {
            warn('an empty inline formula has no Markdown form — dropped');
            break;
          }
          putWhole(`$${src}$`);
          mathEnd = md.length;
          break;
        }
        // Pandoc's raw-attribute syntax: standard markdown that other
        // tools understand as "Typst-only", and round-trips here.
        case 'typst_inline': {
          const src = child.attrs.src as string;
          putWhole(child.attrs.lang === 'html' ? src : `${codeSpan(src)}{=typst}`);
          break;
        }
        case 'citation':
        case 'eq_ref': {
          // A run of adjacent citations and references is one pandoc group
          // (`[@eq:x][@a]` would be literal brackets to pandoc); the reader
          // splits it back by the namespace rule.
          const keyOf = (n: PMNode) => {
            if (n.type.name === 'citation') return n.attrs.key as string;
            const label = n.attrs.label as string;
            if (!NAMESPACE.test(label)) warn(`the reference @${label} reads back as a citation — Markdown references are @eq:, @fig:, @sec: and @tbl: labels`);
            return label;
          };
          const keys = [keyOf(child)];
          const ref = (n: PMNode | undefined) => n?.type.name === 'citation' || n?.type.name === 'eq_ref';
          while (ref(children[k + 1]) && marksOf(children[k + 1]).join() === marksOf(child).join()) keys.push(keyOf(children[++k]));
          if (keys.length > 1 || child.type.name === 'citation') {
            putWhole(citeGroup(keys));
            break;
          }
          // A lone reference is bare unless a letter or digit glues it to
          // the text around it.
          const glued = /[\p{L}\p{N}_]$/u.test(last) || KEY_CONTINUES.test(nextText(k)) || ref(children[k + 1]);
          putWhole(glued ? `[@${keys[0]}]` : `@${keys[0]}`);
          break;
        }
        case 'hard_break':
          if (k < solidEnd) put('\\\n');
          break;
        case 'image': {
          const src = String(child.attrs.src ?? '');
          const altText = String(child.attrs.alt ?? '').replace(/([\\[\]])/g, '\\$1');
          const title = String(child.attrs.title ?? '');
          if (src.startsWith('data:')) warn('embedded image written as a data: URL — consider a project folder');
          const width = child.attrs.widthPct != null ? `{width=${num(child.attrs.widthPct as number)}%}` : '';
          putWhole(`![${altText}](${destination(src)}${title ? ` "${title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : ''})${width}`);
          break;
        }
        case 'footnote': {
          const n = nextNote();
          // The note's text starts a line of its own, `[^n]: …`: what
          // would read there as a list, quote or heading is escaped, and
          // leading spaces (code, or dropped) go.
          footnotes.push([n, escLines(inline(child).replace(/^[ \t]+/, ''))]);
          putWhole(`[^${n}]`);
          break;
        }
        default:
          put(esc(child.textContent));
      }
    }
    moveTo([]);
    return unpaired(md, opaque);
  };

  /** `~x~` and `^x^` are pandoc's sub- and superscript, and their content
   *  may run across marks and atoms (`x^**2**^`, `a~$x$~b`) as long as no
   *  space or line break comes between: of two such `~` (or `^`) in the
   *  written text, the first is escaped. (A pair inside one run of text
   *  was escaped already.) */
  const unpaired = (md: string, opaque: Array<[number, number]>): string => {
    let out = '';
    const open: Record<string, number> = {};
    let k = 0;
    for (let i = 0; i < md.length; i++) {
      while (k < opaque.length && opaque[k][1] <= i) k++;
      if (k < opaque.length && opaque[k][0] <= i) {
        out += md.slice(i, opaque[k][1]);
        i = opaque[k][1] - 1;
        continue;
      }
      const c = md[i];
      if (c === '\\') {
        out += md.slice(i, i + 2);
        i++;
      } else if (c === ' ' || c === '\t' || c === '\n') {
        delete open['~'];
        delete open['^'];
        out += c;
      } else if (c === '~' || c === '^') {
        const at = open[c];
        if (at !== undefined) {
          out = out.slice(0, at) + '\\' + out.slice(at);
          const other = c === '~' ? '^' : '~';
          if (open[other] !== undefined && open[other] > at) open[other]++;
        }
        open[c] = out.length;
        out += c;
      } else out += c;
    }
    return out;
  };

  /** How many div levels a block's Markdown nests: an outer fence is one
   *  colon longer per level inside it, so every fence pairs at a glance. */
  const divDepth = (node: PMNode): number => {
    let inner = 0;
    node.forEach((child) => {
      inner = Math.max(inner, divDepth(child));
    });
    switch (node.type.name) {
      case 'paragraph':
        return node.attrs.align || node.attrs.keep ? 1 : 0;
      case 'table':
        return tableDivAttrs(node) ? 1 : 0;
      case 'blockquote':
        return inner + (node.attrs.kind === 'solution' ? 1 : 0);
      case 'grid':
        return inner + 2;
      default:
        return inner;
    }
  };
  const fence = (depth: number) => ':'.repeat(2 + depth);
  const div = (depth: number, attrs: string, body: string) =>
    body ? `${fence(depth)} ${attrs}\n\n${body}\n\n${fence(depth)}` : `${fence(depth)} ${attrs}\n\n${fence(depth)}`;

  /** Whether `next` may follow `prev` on the next line inside a tight list
   *  item: a blank line between an item's blocks makes the whole list
   *  loose, so what may interrupt a paragraph, for markdown-it and pandoc
   *  alike, follows a plain paragraph directly — a sublist (an ordered one
   *  only from 1), a fenced listing — and display math, which the reader
   *  splits out of the paragraph it is in, so the paragraph it splits off
   *  follows the formula directly too. (A pipe table may not: pandoc reads
   *  its lines as the paragraph's text.) */
  const plainParagraph = (n: PMNode) => n.type.name === 'paragraph' && !n.attrs.align && !n.attrs.keep;
  const tightAfter = (prev: PMNode, next: PMNode) =>
    (plainParagraph(prev) || prev.type.name === 'math_display') &&
    (next.type.name === 'bullet_list' ||
      (next.type.name === 'ordered_list' && ((next.attrs.order as number) || 1) === 1) ||
      (next.type.name === 'code_block' && next.attrs.params !== 'md-raw') ||
      next.type.name === 'math_display' ||
      (prev.type.name === 'math_display' && plainParagraph(next)));

  /** A block that writes nothing (an empty paragraph). */
  const silent = (n: PMNode) => n.type.name === 'paragraph' && n.childCount === 0;

  /** Whether a list item's blocks need a blank line between them, which
   *  makes its whole list loose. */
  const needsBlank = (item: PMNode): boolean => {
    const kids: PMNode[] = [];
    item.forEach((c) => {
      if (!silent(c)) kids.push(c);
    });
    return kids.some((c, k) => k > 0 && !tightAfter(kids[k - 1], c));
  };

  /** Blocks in a container, joined by a blank line (in a tight list item,
   *  by a line break where Markdown allows); a paragraph next to a table
   *  keeps a leading `:` from reading as the table's caption. */
  const blocks = (parent: PMNode, tight = false): string => {
    let md = '';
    const kids: PMNode[] = [];
    parent.forEach((c) => kids.push(c));
    let prev: PMNode | null = null;
    kids.forEach((child, k) => {
      const nearTable = kids[k - 1]?.type.name === 'table' || kids[k + 1]?.type.name === 'table';
      const text = block(child, nearTable);
      if (!text) return;
      md += (md ? (tight && prev && tightAfter(prev, child) ? '\n' : '\n\n') : '') + text;
      prev = child;
    });
    return md;
  };

  const quote = (body: string) =>
    body
      .split('\n')
      .map((line) => (line ? `> ${line}` : '>'))
      .join('\n');

  const block = (node: PMNode, nearTable = false): string => {
    switch (node.type.name) {
      case 'paragraph': {
        // Spaces at a paragraph's edges never print, and Markdown drops
        // them on read (four leading ones would make it code).
        let text = escLines(inline(node).replace(/^[ \t]+|[ \t]+$/g, ''));
        if (!text) return '';
        if (nearTable) text = text.replace(/^:/, '\\:').replace(/^([Tt]able):/, '$1\\:');
        // A lone image with a caption is a figure to pandoc; the no-break
        // space after it keeps it an image in its paragraph (the reader
        // drops that space again). Spaces beside it do not count, and an alt
        // of spaces alone is no caption (the reader's test). An image
        // inside emphasis is no figure (pandoc's figure is an image alone in
        // its paragraph), so it needs no space.
        const solid: PMNode[] = [];
        node.forEach((c) => {
          if (!(c.isText && /^[ \t\n]*$/.test(c.text ?? ''))) solid.push(c);
        });
        const marked = (c: PMNode) => c.marks.some((m) => ['em', 'strong', 'strike'].includes(m.type.name));
        // No-break spaces after a lone image are that space to the reader,
        // which drops them all: they print nothing at the paragraph's end,
        // so the image is written alone.
        const image = solid.find((c) => c.type.name === 'image');
        const after = image ? solid.slice(solid.indexOf(image) + 1) : [];
        if (image && solid[0] === image && !marked(image) && after.length && after.every((c) => c.isText && /^[ \t\n\u00a0]*$/.test(c.text ?? ''))) {
          text = escLines(inline(node.type.create(node.attrs, [image])));
          solid.length = 1;
        }
        if (solid.length === 1 && solid[0].type.name === 'image' && String(solid[0].attrs.alt ?? '').trim() && !marked(solid[0])) text += '\u00a0';
        const classes = [...(node.attrs.keep ? ['keep'] : []), ...(node.attrs.align === 'center' || node.attrs.align === 'right' ? [node.attrs.align as string] : [])];
        if (node.attrs.align && node.attrs.align !== 'center' && node.attrs.align !== 'right') warn(`paragraph alignment "${node.attrs.align as string}" has no Markdown form — dropped`);
        return classes.length ? div(divDepth(node), writeFenceAttrs({ id: '', classes, kvs: [] }), text) : text;
      }
      case 'heading': {
        // A heading is one line: a line break in it is written as a space.
        const kids: PMNode[] = [];
        node.forEach((c) => kids.push(c.type.name === 'hard_break' ? node.type.schema.text(' ', c.marks) : c));
        if (kids.some((c, k) => c !== node.child(k))) warn('a line break in a heading has no Markdown form — written as a space');
        // Spaces at its edges never print, and Markdown drops them on read.
        let text = inline(node.type.create(node.attrs, kids)).replace(/^[ \t]+|[ \t]+$/g, '');
        // Text that would read as the heading's own attributes or closing
        // hashes.
        if (/\}\s*$/.test(text)) {
          const at = text.lastIndexOf('{');
          if (at >= 0 && readAttrBlock(text.trimEnd(), at)?.end === text.trimEnd().length) text = text.slice(0, at) + '\\' + text.slice(at);
        }
        // A closing run of hashes (the whole text included: `# #` is an
        // empty heading) is escaped.
        text = text.replace(/(^|\s)(#+\s*)$/, '$1\\$2');
        const label = node.attrs.label as string;
        return `${'#'.repeat(node.attrs.level as number)} ${text}${label ? ' ' + writeAttrBlock({ id: label, classes: [], kvs: [] }) : ''}`;
      }
      case 'math_display': {
        const numbered = node.attrs.numbered as boolean | null;
        const attrs: PandocAttrs = { id: (node.attrs.label as string) || '', classes: numbered === false ? ['unnumbered'] : numbered === true ? ['numbered'] : [], kvs: [] };
        // No blank line inside a formula (pandoc ends it there), and a
        // line of spaces is a blank line: those lines go. A formula with no
        // text is `$$` over `$$`, which pandoc and the reader read as an
        // empty formula.
        const src = (node.attrs.src as string)
          .split('\n')
          .filter((line) => line.trim())
          .join('\n');
        return `$$\n${src ? src + '\n' : ''}$$${attrs.id || attrs.classes.length ? ' ' + writeAttrBlock(attrs) : ''}`;
      }
      case 'editor_comment':
        return commentToMd(node.textContent);
      case 'code_block': {
        const params = node.attrs.params as string;
        // A Markdown island is the file's own text: back verbatim.
        if (params === 'md-raw') return node.textContent;
        const info = params === 'typst-raw' ? '{=typst}' : params;
        // A backtick in the info string unmakes a backtick fence (the line
        // is text): such a block is fenced with tildes.
        const ch = info.includes('`') ? '~' : '`';
        const ticks = ch.repeat(Math.max(3, longestRun(node.textContent, ch) + 1));
        return `${ticks}${info}\n${node.textContent}\n${ticks}`;
      }
      case 'blockquote': {
        if (node.attrs.kind === 'solution') return div(divDepth(node), 'solution', blocks(node));
        return quote(blocks(node));
      }
      case 'bullet_list':
      case 'ordered_list': {
        const ordered = node.type.name === 'ordered_list';
        const start = (node.attrs.order as number) || 1;
        // An item whose blocks Markdown must set apart with a blank line (a
        // second paragraph, a quote, a div, a table) makes the list loose:
        // a tight list cannot hold it.
        let tight = node.attrs.tight !== false;
        if (tight && node.content.content.some(needsBlank)) {
          tight = false;
          warn('a tight list whose item has blocks Markdown must set apart with a blank line (a second paragraph, a quote, a div, a table) is saved loose — its items take paragraph spacing');
        }
        const items: string[] = [];
        node.forEach((item, _o, i) => {
          const marker = ordered ? `${start + i}. ` : '- ';
          const hang = ' '.repeat(marker.length);
          // Every line after the first hangs under the marker; the blank
          // line between an item's blocks stays blank.
          items.push(marker + blocks(item, tight).replace(/\n(?!\n)/g, `\n${hang}`));
        });
        // A loose list keeps the blank lines between its items.
        return items.join(tight ? '\n' : '\n\n');
      }
      case 'figure': {
        const src = node.attrs.src as string;
        if (src.startsWith('data:')) warn('embedded figure written as a data: URL — consider a project folder');
        // Spaces at a caption's edges never print, and a caption of spaces
        // alone is no caption to the reader (or pandoc): it reads back as
        // an image in a paragraph unless a label keeps it a figure.
        const written = inline(node, true);
        const caption = written.trim() ? written.replace(/^[ \t]+|[ \t]+$/g, '') : '';
        // An image with no caption and no label is not a figure to pandoc;
        // a label (made up when there is none) keeps it one.
        let label = node.attrs.label as string;
        if (!label && !caption) {
          label = freshLabel();
          warn('a figure with no caption and no label is saved with a made-up label (fig:figure-N) so that it stays a figure');
        }
        const kvs: Array<[string, string]> = node.attrs.widthPct != null ? [['width', `${num(node.attrs.widthPct as number)}%`]] : [];
        const attrs = label || kvs.length ? writeAttrBlock({ id: label, classes: [], kvs }) : '';
        const title = node.attrs.title as string;
        return `![${caption}](${destination(src)}${title ? ` "${title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : ''})${attrs}`;
      }
      case 'table': {
        const attrs = tableDivAttrs(node, warn);
        const pipe = pipeTableMd(node, (p) => inline(p), warn);
        if (!pipe) return '';
        if (!attrs) return pipe;
        return div(divDepth(node), writeFenceAttrs({ id: attrs.id, classes: attrs.classes, kvs: attrs.keyvals }), pipe);
      }
      case 'grid': {
        // One `.columns` div per row; rows after the first `.continued`.
        // Equal shares write no width; others their percent of the row.
        const shares = node.attrs.columns as number[];
        const equal = shares.every((s) => s === shares[0]);
        const widths = equal ? [] : percents(shares);
        const depth = divDepth(node);
        const rows: string[] = [];
        node.forEach((row, _o, r) => {
          const cells: string[] = [];
          row.forEach((cell, _c, c) => {
            const kvs: Array<[string, string]> = equal ? [] : [['width', widths[c] ?? widths[widths.length - 1]]];
            cells.push(div(depth - 1, writeFenceAttrs({ id: '', classes: ['column'], kvs }), blocks(cell)));
          });
          const head = writeAttrBlock({ id: '', classes: r ? ['columns', 'continued'] : ['columns'], kvs: [['gutter', `${num(node.attrs.gutter as number)}em`]] });
          rows.push(div(depth, head, cells.join('\n\n')));
        });
        return rows.join('\n\n');
      }
      case 'horizontal_rule':
        return '---';
      case 'page_break':
        return '\\newpage';
      case 'bibliography': {
        const bib = doc.attrs.bib as { name: string; content: string } | null;
        if (!bib?.content) return '';
        wroteBib = true;
        const ticks = '`'.repeat(Math.max(3, longestRun(bib.content, '`') + 1));
        return `${ticks}{=bibtex}\n${bib.content.trim()}\n${ticks}`;
      }
      // The front matter's: written there (frontMatter below).
      case 'doc_title':
      case 'doc_authors':
      case 'doc_date':
      case 'abstract':
      case 'numbering_restart':
        return '';
      default:
        warn(`"${node.type.name}" has no Markdown form — dropped`);
        return '';
    }
  };
  let wroteBib = false;

  /** The YAML front matter (md-frontmatter.ts): the settings that are not
   *  the defaults; the title, author, date and abstract written as body
   *  text is (a title keeps its `$x$` and `*em*`); the roman restart as its
   *  key, wherever its block is; and the lines the file had that Plass does
   *  not interpret, as they were. */
  const frontMatter = (): string => {
    const of: Record<string, PMNode[]> = { doc_title: [], doc_authors: [], doc_date: [], abstract: [] };
    let restart = false;
    doc.forEach((n) => {
      if (Object.hasOwn(of, n.type.name)) of[n.type.name].push(n);
      if (n.type.name === 'numbering_restart') restart = true;
    });
    // A title, author or date is one run of inlines, as pandoc reads a YAML
    // string (no block can start in it); spaces at its edges print nothing.
    const line = (n: PMNode) => inline(n).replace(/^[ \t]+|[ \t]+$/g, '');
    const one = (nodes: PMNode[], what: string, sep: string): string | null => {
      if (!nodes.length) return null;
      if (nodes.length > 1) warn(`${nodes.length} ${what} blocks are saved as one — the front matter holds one ${what}`);
      return nodes.map(line).join(sep);
    };
    // The abstract is paragraphs, each on a line of its own, a blank line
    // between: pandoc reads a block of lines as blocks, so what would open
    // one at a paragraph's head is escaped, as in the body.
    let abstractMd: string | null = null;
    if (of.abstract.length) {
      if (of.abstract.length > 1) warn(`${of.abstract.length} abstract blocks are saved as one — the front matter holds one abstract`);
      const paras: string[] = [];
      for (const a of of.abstract) {
        a.forEach((p) => {
          if (p.attrs.align || p.attrs.keep) warn('alignment and keep on a paragraph of the abstract have no Markdown form — dropped');
          const text = escLines(line(p));
          if (text) paras.push(text);
        });
      }
      abstractMd = paras.join('\n\n');
    }
    // A title, author, date or abstract line the file holds as written (an
    // escape that reads as LaTeX, `date: "\today"`): written back so while
    // the document's block is what that line reads as — not yet edited.
    const extra = (doc.attrs.frontmatter as string | undefined) ?? '';
    const asWritten: TextKey[] = [];
    if (/^(?:title|author|date|abstract)[ \t]*:/m.test(extra)) {
      const kept = readFrontmatter(`---\n${extra}\n---\n`);
      const fields: Array<[TextKey, string | null, PMNode[]]> = [
        ['title', kept.titleMd, of.doc_title],
        ['author', kept.authorsMd, of.doc_authors],
        ['date', kept.dateMd, of.doc_date],
        ['abstract', kept.abstractMd, of.abstract],
      ];
      for (const [key, text, nodes] of fields) {
        if (text === null || nodes.length !== 1) continue;
        if (readFrontText(key, text)?.content.eq(nodes[0].content)) asWritten.push(key);
      }
    }
    const bib = doc.attrs.bib as { content?: string } | null;
    return writeFrontmatter(
      {
        titleMd: one(of.doc_title, 'title', ' '),
        authorsMd: one(of.doc_authors, 'author', ', '),
        dateMd: one(of.doc_date, 'date', ' '),
        abstractMd,
        settings: doc.attrs.settings as Partial<DocSettings> | null,
        frontMatterRestart: restart,
        extra,
        asWritten,
        // A `bibliography:` line the reader carried while its sidecar was
        // unread goes once the document holds a bibliography (the body's
        // {=bibtex} block); until then it stays, so nothing is lost.
        keptBibliography: bib?.content ? 'drop' : 'write',
      },
      warn,
    );
  };

  // ---------- front matter ----------
  // The settings, the title block and the roman restart, before the body
  // (so a footnote in the title is note 1, as it reads).
  {
    const fm = frontMatter();
    if (fm) out.push(fm);
  }

  // Chunks join with a blank line between them — one newline where a
  // Markdown island was tight against its neighbour in the file. A block's
  // offset is where its chunk starts in that joined text, counted the same
  // way the final join lays it out, so the two cannot drift.
  const blockChunks: Array<{ text: string; sepBefore: string; open: boolean }> = [];
  let prevTightAfter = false;
  const top: PMNode[] = [];
  doc.forEach((node) => top.push(node));
  top.forEach((node, k) => {
    const nearTable = top[k - 1]?.type.name === 'table' || top[k + 1]?.type.name === 'table';
    let text = block(node, nearTable);
    // A `%` that opens the file (no front matter before it) starts pandoc's
    // title block.
    if (!out.length && !blockChunks.some((c) => c.text) && node.type.name === 'paragraph') text = text.replace(/^%/, '\\%');
    const island = node.type.name === 'code_block' && node.attrs.params === 'md-raw';
    const tight = island ? (node.attrs.tight as string) : '';
    const tightBefore = tight === 'before' || tight === 'both';
    blockChunks.push({ text, sepBefore: tightBefore || prevTightAfter ? '\n' : '\n\n', open: island && leavesOpen(text) });
    prevTightAfter = island && (tight === 'after' || tight === 'both');
  });

  // What follows the body: the notes, and a bibliography with no node of
  // its own (the node was deleted), which still rides along.
  const tail: string[] = [];
  if (footnotes.length) tail.push(footnotes.map(([n, f]) => `[^${n}]: ${f}`).join('\n'));
  const bib = doc.attrs.bib as { name: string; content: string } | null;
  if (bib?.content && !wroteBib) tail.push('```{=bibtex}\n' + bib.content.trim() + '\n```');
  // A file that ends in source left open (an unclosed `::: aside`) would
  // take the tail into it on the next read: the tail goes before it.
  let last = blockChunks.length - 1;
  while (last >= 0 && !blockChunks[last].text) last--;
  const tailBefore = tail.length && last >= 0 && blockChunks[last].open ? last : -1;

  let body = out.join('\n\n');
  let pos = body.length;
  let emitted = body.length > 0;
  const starts: number[] = [];
  blockChunks.forEach((chunk, k) => {
    let sep = chunk.sepBefore;
    if (k === tailBefore) {
      const text = tail.splice(0).join('\n\n');
      body += (emitted ? '\n\n' : '') + text;
      pos = body.length;
      emitted = true;
      sep = '\n\n';
    }
    const start = emitted ? pos + sep.length : pos;
    starts.push(start);
    if (chunk.text) {
      body += (emitted ? sep : '') + chunk.text;
      pos = start + chunk.text.length;
      emitted = true;
    }
  });
  if (offsets) {
    offsets.length = 0;
    offsets.push(...starts);
  }
  return [body, ...tail].filter(Boolean).join('\n\n') + '\n';
}

/** Whether Markdown kept as source leaves a fenced div, a code fence or an
 *  HTML element open at its end, so that what is written after it would
 *  read as inside it. Its lines are read as the top level reads them. */
function leavesOpen(text: string): boolean {
  let fence: { ch: string; len: number } | null = null;
  let html: RegExp | null = null;
  let divs = 0;
  for (const line of text.split('\n')) {
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.ch && close[1].length >= fence.len) fence = null;
      continue;
    }
    if (html) {
      if (html.test(line)) html = null;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (open && !(open[1][0] === '`' && line.slice(open[0].length).includes('`'))) {
      fence = { ch: open[1][0], len: open[1].length };
      continue;
    }
    const start = HTML_ENDS.find(([re]) => re.test(line));
    if (start && !start[1].test(line)) html = start[1];
    else if (/^:{3,}[ \t]*$/.test(line)) divs = Math.max(0, divs - 1);
    // An opener's class word is any run of non-spaces (`:::"{.c}` opens
    // a div to the reader, as to pandoc).
    else if (/^:{3,}[ \t]*(?:\{|[^ \t]+[ \t]*:*[ \t]*$)/.test(line)) divs++;
  }
  return fence !== null || html !== null || divs > 0;
}

/** The HTML blocks that run to an end marker, not to a blank line
 *  (CommonMark's start conditions 1 to 5), with that marker. */
const HTML_ENDS: Array<[RegExp, RegExp]> = [
  [/^ {0,3}<(?:script|pre|style|textarea)(?=[\s>]|$)/i, /<\/(?:script|pre|style|textarea)>/i],
  [/^ {0,3}<!--/, /-->/],
  [/^ {0,3}<\?/, /\?>/],
  [/^ {0,3}<![A-Z]/, />/],
  [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
];
