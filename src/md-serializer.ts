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
//   - only the standard title/author/date keys ride in YAML frontmatter
//     (settings are the next step's)
//
// What Markdown cannot say is reported through `warn`, never dropped
// silently.

import type { Node as PMNode, Mark } from 'prosemirror-model';
import { DEFAULT_SETTINGS, type DocSettings } from './settings';
import { commentToMd } from './editor-comments-format';
import { writeAttrBlock, writeFenceAttrs, readAttrBlock, type PandocAttrs } from './md-attrs';
import { pipeTableMd, tableDivAttrs } from './md-tables';

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

/** A number as Markdown writes it: at most three decimals, no trailing
 *  zeros. */
const num = (n: number) => String(Math.round(n * 1000) / 1000);

/** Serialize to Markdown. `offsets`, when given, receives the text offset
 *  at which each top-level block's serialization begins (index = position
 *  of the block in `doc`); blocks that produce no Markdown of their own
 *  (title/author/date live in the frontmatter) get the offset of whatever
 *  follows them. Block-level caret mapping for the source view
 *  (SOURCE-VIEW.md, decision 5). */
export function docToMd(doc: PMNode, warn: (m: string) => void = () => {}, offsets?: number[]): string {
  let out: string[] = [];
  const footnotes: string[] = [];

  // ---------- frontmatter ----------
  {
    const fm: string[] = [];
    doc.forEach((n) => {
      if (n.type.name === 'doc_title' && n.textContent) fm.push(`title: "${n.textContent.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
      if (n.type.name === 'doc_authors' && n.textContent) fm.push(`author: "${n.textContent.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
      if (n.type.name === 'doc_date' && n.textContent) fm.push(`date: "${n.textContent.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    });
    // Frontmatter the import had no field for comes back verbatim.
    const extra = ((doc.attrs.frontmatter as string | undefined) ?? '').replace(/^\n+|\n+$/g, '');
    if (extra) fm.push(extra);
    const s = doc.attrs.settings as DocSettings;
    if (JSON.stringify(s) !== JSON.stringify(DEFAULT_SETTINGS)) {
      warn('document settings (page, font, numbering) are not yet stored in Markdown — they reopen at the defaults');
    }
    if (fm.length) out.push(`---\n${fm.join('\n')}\n---`);
  }

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

  const esc = (text: string): string =>
    text
      .replace(/([\\`*$])/g, '\\$1')
      // Brackets only where they would read as a link, reference, footnote
      // or citation: `[note]` alone is text and stays readable.
      .replace(/\[(?=[@^])/g, '\\[')
      .replace(/\](?=[([])/g, '\\]')
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
      // `^[` opens an inline footnote.
      .replace(/(?<!\\)\^(?=\[)/g, '\\^')
      // Raw HTML and character references would be read as markup.
      .replace(/<(?=[A-Za-z/!?])/g, '\\<')
      .replace(/&(?=#?[A-Za-z0-9]+;)/g, '\\&')
      // Underscores: every one in a run of two or more (a blank to fill in
      // would otherwise be read as emphasis delimiters), and a lone one at
      // a word boundary; snake_case stays bare.
      .replace(/_{2,}/g, (run) => run.replace(/_/g, '\\_'))
      .replace(/(^|\s)_(?!\\)/g, '$1\\_')
      .replace(/(?<!\\)_(?=\s|$)/g, '\\_');

  /** Escape what would start a block at the head of a line of paragraph
   *  text: a heading, a quote, a list item, a div fence, a code fence, a
   *  setext underline or rule, a reference definition. */
  const escLines = (md: string): string =>
    md
      .split('\n')
      .map((line) =>
        line
          .replace(/^([ \t]*)([#>])/, '$1\\$2')
          .replace(/^([ \t]*)([-+])(?=[ \t]|$)/, '$1\\$2')
          .replace(/^([ \t]*)(\d{1,9})([.)])(?=[ \t]|$)/, '$1$2\\$3')
          .replace(/^([ \t]*)(:{3,})/, '$1\\$2')
          .replace(/^([ \t]*)(=+[ \t]*)$/, '$1\\$2')
          .replace(/^([ \t]*)(-[- \t]*)$/, '$1\\$2')
          .replace(/^(\[[^\]]*\]):/, '$1\\:'),
      )
      .join('\n');

  /** A run of adjacent citations as one pandoc group. */
  const citeGroup = (keys: string[]) => `[${keys.map((k) => `@${k}`).join('; ')}]`;

  /** Inline content. `alt` escapes every bracket (an image's caption). */
  const inline = (node: PMNode, alt = false): string => {
    let md = '';
    // Text and inline math sharing strong/em/strike marks form one wrapped
    // run (`**$2$ drinks**`), as the .typ exporter does; other atoms close
    // the run.
    let run = '';
    let sig = '';
    const signature = (child: PMNode) =>
      ['strong', 'em', 'strike'].filter((n) => child.marks.some((m: Mark) => m.type.name === n)).join(',');
    const flush = () => {
      if (run) {
        let t = run;
        if (sig.includes('strong')) t = `**${t}**`;
        if (sig.includes('em')) t = `*${t}*`;
        if (sig.includes('strike')) t = `~~${t}~~`;
        md += t;
      }
      run = '';
    };
    /** What the text so far ends in, across the open run. */
    const tail = () => (run || md).slice(-1);
    const children: PMNode[] = [];
    node.forEach((child) => children.push(child));
    /** Text the next node starts with (for the guards below). */
    const nextText = (k: number) => {
      const next = children[k + 1];
      return next?.isText && !next.marks.some((m) => m.type.name === 'code' || m.type.name === 'link') ? next.text ?? '' : '';
    };
    for (let k = 0; k < children.length; k++) {
      const child = children[k];
      if (child.isText && child.text) {
        const marks = child.marks;
        const has = (name: string) => marks.some((m: Mark) => m.type.name === name);
        const s = signature(child);
        if (s !== sig) {
          flush();
          sig = s;
        }
        let t: string;
        if (has('code')) {
          const fence = '`'.repeat(longestRun(child.text, '`') + 1);
          const pad = /^`|`$|^ .* $/.test(child.text) ? ' ' : '';
          t = fence + pad + child.text + pad + fence;
        } else {
          t = esc(child.text);
          if (alt) t = t.replace(/(?<!\\)([[\]])/g, '\\$1');
          // A `{` right after code or an image would read as its
          // attributes; `(`/`[` right after a citation's `]` as a link.
          if ((/^[{]/.test(t) && /[`)]$/.test(tail())) || (/^[([]/.test(t) && tail() === ']')) t = '\\' + t;
        }
        const link = marks.find((m: Mark) => m.type.name === 'link');
        if (link) {
          const title = link.attrs.title as string | null;
          t = `[${t}](${link.attrs.href as string}${title ? ` "${title.replace(/"/g, '\\"')}"` : ''})`;
        }
        run += t;
        continue;
      }
      if (child.type.name === 'math_inline') {
        const s = signature(child);
        if (s !== sig) {
          flush();
          sig = s;
        }
        // One line: a formula's soft break reads back as its space.
        run += `$${(child.attrs.src as string).replace(/\s*\n\s*/g, ' ')}$`;
        continue;
      }
      flush();
      sig = '';
      switch (child.type.name) {
        // Pandoc's raw-attribute syntax: standard markdown that other
        // tools understand as "Typst-only", and round-trips here.
        case 'typst_inline': {
          const src = child.attrs.src as string;
          if (child.attrs.lang === 'html') md += src;
          else {
            const fence = '`'.repeat(longestRun(src, '`') + 1);
            const pad = /^`|`$/.test(src) ? ' ' : '';
            md += `${fence}${pad}${src}${pad}${fence}{=typst}`;
          }
          break;
        }
        case 'citation': {
          const keys = [child.attrs.key as string];
          while (children[k + 1]?.type.name === 'citation') keys.push(children[++k].attrs.key as string);
          md += citeGroup(keys);
          break;
        }
        case 'eq_ref': {
          const label = child.attrs.label as string;
          if (!NAMESPACE.test(label)) warn(`the reference @${label} reads back as a citation — Markdown references are @eq:, @fig:, @sec: and @tbl: labels`);
          // Bare unless a letter or digit glues it to the text around it.
          const glued = /[\p{L}\p{N}_]$/u.test(tail()) || KEY_CONTINUES.test(nextText(k)) || children[k + 1]?.type.name === 'citation';
          md += glued ? `[@${label}]` : `@${label}`;
          break;
        }
        case 'hard_break':
          md += '\\\n';
          break;
        case 'image': {
          const src = String(child.attrs.src ?? '');
          const altText = String(child.attrs.alt ?? '').replace(/([\\[\]])/g, '\\$1');
          const title = String(child.attrs.title ?? '');
          if (src.startsWith('data:')) warn('embedded image written as a data: URL — consider a project folder');
          const destination = src.replace(/([\\()\s])/g, (c) => (c === ' ' ? '%20' : `\\${c}`));
          const width = child.attrs.widthPct != null ? `{width=${num(child.attrs.widthPct as number)}%}` : '';
          md += `![${altText}](${destination}${title ? ` "${title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : ''})${width}`;
          break;
        }
        case 'footnote': {
          const n = footnotes.length + 1;
          footnotes.push(inline(child));
          md += `[^${n}]`;
          break;
        }
        default:
          md += esc(child.textContent);
      }
    }
    flush();
    return md;
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

  /** Whether `next` may follow `prev` on the next line inside a tight
   *  list item: a blank line between an item's blocks makes the whole list
   *  loose, so a sublist or a fenced listing follows directly (both may
   *  interrupt a paragraph; an ordered sublist only from 1). */
  const tightAfter = (next: PMNode) =>
    next.type.name === 'bullet_list' ||
    (next.type.name === 'ordered_list' && ((next.attrs.order as number) || 1) === 1) ||
    (next.type.name === 'code_block' && next.attrs.params !== 'md-raw');

  /** Blocks in a container, joined by a blank line (in a tight list item,
   *  by a line break where Markdown allows); a paragraph next to a table
   *  keeps a leading `:` from reading as the table's caption. */
  const blocks = (parent: PMNode, tight = false): string => {
    let md = '';
    const kids: PMNode[] = [];
    parent.forEach((c) => kids.push(c));
    kids.forEach((child, k) => {
      const nearTable = kids[k - 1]?.type.name === 'table' || kids[k + 1]?.type.name === 'table';
      const text = block(child, nearTable);
      if (text) md += (md ? (tight && tightAfter(child) ? '\n' : '\n\n') : '') + text;
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
        let text = escLines(inline(node));
        if (!text) return '';
        if (nearTable) text = text.replace(/^:/, '\\:').replace(/^([Tt]able):/, '$1\\:');
        // A lone image with a caption is a figure to pandoc; the no-break
        // space after it keeps it an image in its paragraph.
        const only = node.childCount === 1 ? node.firstChild : null;
        if (only?.type.name === 'image' && only.attrs.alt) text += '\u00a0';
        const classes = [...(node.attrs.keep ? ['keep'] : []), ...(node.attrs.align === 'center' || node.attrs.align === 'right' ? [node.attrs.align as string] : [])];
        if (node.attrs.align && node.attrs.align !== 'center' && node.attrs.align !== 'right') warn(`paragraph alignment "${node.attrs.align as string}" has no Markdown form — dropped`);
        return classes.length ? div(divDepth(node), writeFenceAttrs({ id: '', classes, kvs: [] }), text) : text;
      }
      case 'heading': {
        let text = inline(node);
        // Text that would read as the heading's own attributes or closing
        // hashes.
        if (/\}\s*$/.test(text)) {
          const at = text.lastIndexOf('{');
          if (at >= 0 && readAttrBlock(text.trimEnd(), at)?.end === text.trimEnd().length) text = text.slice(0, at) + '\\' + text.slice(at);
        }
        text = text.replace(/(\s)(#+\s*)$/, '$1\\$2');
        const label = node.attrs.label as string;
        return `${'#'.repeat(node.attrs.level as number)} ${text}${label ? ' ' + writeAttrBlock({ id: label, classes: [], kvs: [] }) : ''}`;
      }
      case 'math_display': {
        const numbered = node.attrs.numbered as boolean | null;
        const attrs: PandocAttrs = { id: (node.attrs.label as string) || '', classes: numbered === false ? ['unnumbered'] : numbered === true ? ['numbered'] : [], kvs: [] };
        // No blank line inside a formula (pandoc ends it there).
        const src = (node.attrs.src as string).replace(/\n[ \t]*(?=\n)/g, '');
        return `$$\n${src}\n$$${attrs.id || attrs.classes.length ? ' ' + writeAttrBlock(attrs) : ''}`;
      }
      case 'editor_comment':
        return commentToMd(node.textContent);
      case 'code_block': {
        const params = node.attrs.params as string;
        // A Markdown island is the file's own text: back verbatim.
        if (params === 'md-raw') return node.textContent;
        const info = params === 'typst-raw' ? '{=typst}' : params;
        const ticks = '`'.repeat(Math.max(3, longestRun(node.textContent, '`') + 1));
        return `${ticks}${info}\n${node.textContent}\n${ticks}`;
      }
      case 'blockquote': {
        if (node.attrs.kind === 'solution') return div(divDepth(node), 'solution', blocks(node));
        return quote(blocks(node));
      }
      case 'abstract': {
        const inner: string[] = [];
        node.forEach((child, _o, i) => inner.push((i === 0 ? '**Abstract.** ' : '') + block(child)));
        return quote(inner.join('\n\n'));
      }
      case 'bullet_list':
      case 'ordered_list': {
        const ordered = node.type.name === 'ordered_list';
        const start = (node.attrs.order as number) || 1;
        const items: string[] = [];
        node.forEach((item, _o, i) => {
          const marker = ordered ? `${start + i}. ` : '- ';
          const hang = ' '.repeat(marker.length);
          // Every line after the first hangs under the marker; the blank
          // line between an item's blocks stays blank.
          items.push(marker + blocks(item, node.attrs.tight !== false).replace(/\n(?!\n)/g, `\n${hang}`));
        });
        // A loose list keeps the blank lines between its items.
        return items.join(node.attrs.tight === false ? '\n\n' : '\n');
      }
      case 'figure': {
        const src = node.attrs.src as string;
        if (src.startsWith('data:')) warn('embedded figure written as a data: URL — consider a project folder');
        const caption = inline(node, true);
        // An image with no caption and no label is not a figure to pandoc;
        // a label (made up when there is none) keeps it one.
        const label = (node.attrs.label as string) || (caption ? '' : freshLabel());
        const kvs: Array<[string, string]> = node.attrs.widthPct != null ? [['width', `${num(node.attrs.widthPct as number)}%`]] : [];
        const attrs = label || kvs.length ? writeAttrBlock({ id: label, classes: [], kvs }) : '';
        const title = node.attrs.title as string;
        const destination = src.replace(/([\\()\s])/g, (c) => (c === ' ' ? '%20' : `\\${c}`));
        return `![${caption}](${destination}${title ? ` "${title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : ''})${attrs}`;
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
        const total = shares.reduce((a, b) => a + b, 0);
        const equal = shares.every((s) => s === shares[0]);
        const depth = divDepth(node);
        const rows: string[] = [];
        node.forEach((row, _o, r) => {
          const cells: string[] = [];
          row.forEach((cell, _c, c) => {
            const share = shares[c] ?? shares[shares.length - 1] ?? 1;
            const kvs: Array<[string, string]> = equal ? [] : [['width', `${num((share / total) * 100)}%`]];
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
      case 'numbering_restart':
        warn('the front-matter page-number restart is not yet stored in Markdown — dropped');
        return '';
      case 'bibliography': {
        const bib = doc.attrs.bib as { name: string; content: string } | null;
        if (!bib?.content) return '';
        wroteBib = true;
        const ticks = '`'.repeat(Math.max(3, longestRun(bib.content, '`') + 1));
        return `${ticks}{=bibtex}\n${bib.content.trim()}\n${ticks}`;
      }
      case 'doc_title':
      case 'doc_authors':
      case 'doc_date':
        return ''; // frontmatter
      default:
        warn(`"${node.type.name}" has no Markdown form — dropped`);
        return '';
    }
  };
  let wroteBib = false;

  // Chunks join with a blank line between them — one newline where a
  // Markdown island was tight against its neighbour in the file. A block's
  // offset is where its chunk starts in that joined text, counted the same
  // way the final join lays it out, so the two cannot drift.
  const blockChunks: Array<{ text: string; sepBefore: string }> = [];
  let prevTightAfter = false;
  const top: PMNode[] = [];
  doc.forEach((node) => top.push(node));
  top.forEach((node, k) => {
    const nearTable = top[k - 1]?.type.name === 'table' || top[k + 1]?.type.name === 'table';
    const text = block(node, nearTable);
    const island = node.type.name === 'code_block' && node.attrs.params === 'md-raw';
    const tight = island ? (node.attrs.tight as string) : '';
    const tightBefore = tight === 'before' || tight === 'both';
    blockChunks.push({ text, sepBefore: tightBefore || prevTightAfter ? '\n' : '\n\n' });
    prevTightAfter = island && (tight === 'after' || tight === 'both');
  });
  let body = out.join('\n\n');
  let pos = body.length;
  let emitted = body.length > 0;
  const starts: number[] = [];
  for (const chunk of blockChunks) {
    const start = emitted ? pos + chunk.sepBefore.length : pos;
    starts.push(start);
    if (chunk.text) {
      body += (emitted ? chunk.sepBefore : '') + chunk.text;
      pos = start + chunk.text.length;
      emitted = true;
    }
  }
  if (offsets) {
    offsets.length = 0;
    offsets.push(...starts);
  }
  out = [body];

  if (footnotes.length) {
    out.push(footnotes.map((f, i) => `[^${i + 1}]: ${f}`).join('\n'));
  }

  // A bibliography with no node of its own (the node was deleted) still
  // rides along, at the end.
  const bib = doc.attrs.bib as { name: string; content: string } | null;
  if (bib?.content && !wroteBib) out.push('```{=bibtex}\n' + bib.content.trim() + '\n```');

  return out.filter(Boolean).join('\n\n') + '\n';
}
