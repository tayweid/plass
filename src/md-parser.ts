// Markdown -> PM doc (.md open path).
//
// Built on markdown-it (the reference CommonMark+GFM tokenizer) rather than
// a hand-rolled parser: arbitrary markdown from collaborators is edge-case
// country. Everything Plass-specific happens around the tokenizer:
//
//   - math is extracted BEFORE tokenization ($x$ and $$ blocks would be
//     mangled by emphasis rules) and restored from sentinels afterward
//   - [@key] becomes a citation, @tag:id an equation/figure reference
//   - ```typst fences become raw-Typst islands (the same never-destroy
//     policy as the Typst importer), ```bibtex becomes the document's
//     embedded bibliography
//   - YAML frontmatter carries the standard title/author/date keys and
//     nothing app-specific — unknown keys are reported, not silently eaten
//
// Anything markdown expresses that the model can't (inline HTML) degrades
// to plain text with a warning.

import MarkdownIt from 'markdown-it';
import footnotePlugin from 'markdown-it-footnote';
import type { Node as PMNode, Mark } from 'prosemirror-model';
import { schema } from './schema';
import { DEFAULT_SETTINGS, type DocSettings } from './settings';
import { INPUT_LIMITS, textSizeError } from './input-limits';
import { trimSpaceBeforeMarker } from './collapse-spaces';

export interface MdImport {
  doc: PMNode;
  warnings: string[];
}

interface MdToken {
  type: string;
  tag: string;
  content: string;
  info: string;
  children: MdToken[] | null;
  meta: { id?: number } | null;
  attrGet(name: string): string | null;
  hidden: boolean;
}

// Math placeholders use a private-use character: markdown-it passes it
// through verbatim (NUL would be rewritten to U+FFFD per CommonMark).
const S = '\uE000';

export function mdToDoc(src: string): MdImport {
  const warnings: string[] = [];
  src = src.replace(/\r\n?/g, '\n');

  // ---------- frontmatter ----------
  const settings: DocSettings = { ...DEFAULT_SETTINGS };
  let title: string | null = null;
  let authors: string | null = null;
  let date: string | null = null;
  if (src.startsWith('---\n')) {
    const end = src.indexOf('\n---\n', 4);
    if (end > 0) {
      for (const line of src.slice(4, end).split('\n')) {
        const m = /^(\w[\w-]*):\s*(.*)$/.exec(line);
        if (!m) continue;
        const key = m[1].toLowerCase();
        const value = m[2].trim().replace(/^["']|["']$/g, '');
        if (key === 'title') title = value;
        else if (key === 'author' || key === 'authors') authors = value;
        else if (key === 'date') date = value;
        else if (value) {
          warnings.push(`frontmatter "${key}" has no Plass equivalent — dropped`);
        }
      }
      src = src.slice(end + 5);
    }
  }

  // ---------- math extraction (fence- and code-span-aware) ----------
  const inlineMath: string[] = [];
  const displayMath: Array<{ src: string; label: string }> = [];
  {
    const out: string[] = [];
    const lines = src.split('\n');
    let fence: string | null = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const open = /^(```+|~~~+)/.exec(line);
      if (fence) {
        out.push(line);
        if (open && open[1].startsWith(fence[0]) && open[1].length >= fence.length) fence = null;
        continue;
      }
      if (open) {
        fence = open[1];
        out.push(line);
        continue;
      }
      // Display block: $$ ... $$ (single- or multi-line), optional {#label}.
      const d = /^\s*\$\$(.*)$/.exec(line);
      if (d) {
        let body = '';
        let label = '';
        const closeSame = /^(.*?)\$\$\s*(?:\{#([\w:.-]+)\})?\s*$/.exec(d[1]);
        if (closeSame && closeSame[1].trim()) {
          body = closeSame[1].trim();
          label = closeSame[2] ?? '';
        } else {
          const buf: string[] = [];
          if (d[1].trim()) buf.push(d[1].trim());
          let j = i + 1;
          for (; j < lines.length; j++) {
            const c = /^(.*?)\$\$\s*(?:\{#([\w:.-]+)\})?\s*$/.exec(lines[j]);
            if (c) {
              if (c[1].trim()) buf.push(c[1].trim());
              label = c[2] ?? '';
              break;
            }
            buf.push(lines[j]);
          }
          if (j >= lines.length) {
            out.push(line); // unclosed — leave as text
            continue;
          }
          i = j;
          body = buf.join('\n');
        }
        out.push(`${S}B${displayMath.length}${S}`);
        displayMath.push({ src: body, label });
        continue;
      }
      // Inline math outside code spans: $x$ (no surrounding spaces inside).
      out.push(
        line
          .split(/(`[^`]*`)/)
          .map((seg, k) => {
            if (k % 2 === 1) return seg;
            return seg.replace(/(?<!\\)\$(\S(?:[^$\n]*?\S)?)\$(?!\d)/g, (_, body: string) => {
              inlineMath.push(body);
              return `${S}M${inlineMath.length - 1}${S}`;
            });
          })
          .join(''),
      );
    }
    src = out.join('\n');
  }

  // ---------- tokenize ----------
  const md = new MarkdownIt({ html: false }).use(footnotePlugin);
  const tokens = md.parse(src, {}) as unknown as MdToken[];

  // Footnote definitions (markdown-it emits them at the stream tail).
  const footnoteDefs = new Map<number, PMNode[]>();
  {
    let current = -1;
    let bufs: PMNode[][] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type === 'footnote_open') {
        current = t.meta?.id ?? -1;
        bufs = [];
      } else if (t.type === 'footnote_close') {
        if (bufs.length > 1) warnings.push('multi-paragraph footnote flattened');
        footnoteDefs.set(
          current,
          bufs.flatMap((b, k) => (k > 0 ? [schema.text(' '), ...b] : b)),
        );
        current = -1;
      } else if (current >= 0 && t.type === 'inline') {
        bufs.push(parseInline(t.children ?? []));
      }
    }
  }

  const { paragraph, heading, blockquote, code_block, horizontal_rule } = schema.nodes;
  const pendingFigures: PMNode[] = [];
  let bib: { name: string; content: string } | null = null;
  let sawBibNode = false;

  function textWithRefs(text: string, marks: readonly Mark[]): PMNode[] {
    const out: PMNode[] = [];
    const re = new RegExp(
      `${S}M(\\d+)${S}|` + String.raw`\[@([\w:.-]+)\]|(?<![\w@])@([A-Za-z][\w-]*:[\w-]+(?:\.[\w-]+)*)`,
      'g',
    );
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(schema.text(text.slice(last, m.index), marks));
      if (m[1] !== undefined) out.push(schema.nodes.math_inline.create({ src: inlineMath[+m[1]] }));
      else if (m[2] !== undefined) out.push(schema.nodes.citation.create({ key: m[2] }));
      else out.push(schema.nodes.eq_ref.create({ label: m[3] }));
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(schema.text(text.slice(last), marks));
    return out;
  }

  function parseInline(children: MdToken[]): PMNode[] {
    const out: PMNode[] = [];
    let marks: Mark[] = [];
    for (let ti = 0; ti < children.length; ti++) {
      const t = children[ti];
      switch (t.type) {
        case 'text':
          if (t.content) out.push(...textWithRefs(t.content, marks));
          break;
        case 'code_inline': {
          // `#h(1fr)`{=typst} — pandoc's raw attribute — is inline raw
          // Typst, the mirror of the ```typst fence for block islands.
          const after = children[ti + 1];
          if (after?.type === 'text' && after.content.startsWith('{=typst}')) {
            out.push(schema.nodes.typst_inline.create({ src: t.content }));
            after.content = after.content.slice('{=typst}'.length);
            break;
          }
          out.push(schema.text(t.content, [...marks, schema.marks.code.create()]));
          break;
        }
        case 'strong_open':
          marks = [...marks, schema.marks.strong.create()];
          break;
        case 'em_open':
          marks = [...marks, schema.marks.em.create()];
          break;
        case 'link_open':
          marks = [...marks, schema.marks.link.create({ href: t.attrGet('href') ?? '', title: t.attrGet('title') })];
          break;
        case 's_open':
          marks = [...marks, schema.marks.strike.create()];
          break;
        case 'strong_close':
        case 'em_close':
        case 'link_close':
        case 's_close':
          marks = marks.slice(0, -1);
          break;
        case 'softbreak':
          out.push(schema.text(' ', marks));
          break;
        case 'hardbreak':
          out.push(schema.nodes.hard_break.create());
          break;
        case 'image': {
          const cap = t.children?.length ? parseInline(t.children) : t.content ? [schema.text(t.content)] : [];
          pendingFigures.push(schema.nodes.figure.create({ src: t.attrGet('src') ?? '' }, cap));
          break;
        }
        case 'footnote_ref': {
          const body = footnoteDefs.get(t.meta?.id ?? -1) ?? [];
          trimSpaceBeforeMarker(out);
          out.push(schema.nodes.footnote.create(null, body));
          break;
        }
        case 'html_inline':
          if (t.content.trim()) {
            warnings.push('inline HTML kept as plain text');
            out.push(schema.text(t.content, marks));
          }
          break;
        default:
          if (t.content) out.push(...textWithRefs(t.content, marks));
      }
    }
    return out;
  }

  /** Consume tokens from `i` until the matching close token; returns blocks. */
  function parseBlocks(i: number, closeType: string | null): { nodes: PMNode[]; next: number } {
    const nodes: PMNode[] = [];
    const flushFigures = () => {
      while (pendingFigures.length) nodes.push(pendingFigures.shift()!);
    };
    while (i < tokens.length) {
      const t = tokens[i];
      if (closeType && t.type === closeType) return { nodes, next: i + 1 };
      switch (t.type) {
        case 'heading_open': {
          const level = Math.min(3, +t.tag.slice(1));
          if (+t.tag.slice(1) > 3) warnings.push(`h${t.tag.slice(1)} demoted to h3 (Plass has three levels)`);
          const inline = tokens[i + 1];
          nodes.push(heading.create({ level }, parseInline(inline?.children ?? [])));
          i += 3;
          break;
        }
        case 'paragraph_open': {
          const inline = tokens[i + 1];
          const kids = inline?.children ?? [];
          const only = kids.filter((k) => k.type !== 'text' || k.content.trim() !== '');
          const dm = only.length === 1 && only[0].type === 'text' && new RegExp(`^${S}B(\\d+)${S}$`).exec(only[0].content.trim());
          if (dm) {
            const d = displayMath[+dm[1]];
            nodes.push(schema.nodes.math_display.create({ src: d.src, label: d.label }));
          } else if (only.length === 1 && only[0].type === 'image') {
            parseInline(only);
            flushFigures();
          } else {
            const content = parseInline(kids);
            if (content.length) nodes.push(paragraph.create(null, content));
            flushFigures();
          }
          i += 3;
          break;
        }
        case 'fence': {
          const lang = t.info.trim().toLowerCase();
          const body = t.content.replace(/\n$/, '');
          if (lang === 'typst') {
            nodes.push(code_block.create({ params: 'typst-raw' }, body ? [schema.text(body)] : []));
          } else if ((lang === 'bibtex' || lang === 'bib') && !bib) {
            const sizeError = textSizeError(body, INPUT_LIMITS.bibliographyBytes, 'Embedded bibliography');
            if (sizeError) {
              warnings.push(`${sizeError} — preserved as a code block`);
              nodes.push(code_block.create({ params: t.info.trim() }, body ? [schema.text(body)] : []));
            } else {
              bib = { name: 'references.bib', content: body };
              nodes.push(schema.nodes.bibliography.create());
              sawBibNode = true;
            }
          } else {
            nodes.push(code_block.create({ params: t.info.trim() }, body ? [schema.text(body)] : []));
          }
          i++;
          break;
        }
        case 'blockquote_open': {
          const inner = parseBlocks(i + 1, 'blockquote_close');
          // The serializer writes the abstract as a quote led by
          // "**Abstract.**" — recognize it coming back.
          const first = inner.nodes[0];
          const lead = first?.firstChild;
          if (
            first?.type === paragraph &&
            lead?.isText &&
            lead.marks.some((m) => m.type === schema.marks.strong) &&
            /^Abstract\.?\s*$/.test(lead.text ?? '')
          ) {
            const rest = first.content.content.slice(1);
            while (rest.length && rest[0].isText && !rest[0].text?.trim()) rest.shift();
            const paras = [paragraph.create(null, rest), ...inner.nodes.slice(1)];
            nodes.push(schema.nodes.abstract.create(null, paras));
          } else {
            nodes.push(blockquote.create(null, inner.nodes.length ? inner.nodes : [paragraph.create()]));
          }
          i = inner.next;
          break;
        }
        case 'bullet_list_open': {
          const items = parseListItems(i + 1, 'bullet_list_close');
          nodes.push(schema.nodes.bullet_list.create(null, items.nodes));
          i = items.next;
          break;
        }
        case 'ordered_list_open': {
          const items = parseListItems(i + 1, 'ordered_list_close');
          const start = t.attrGet('start');
          nodes.push(schema.nodes.ordered_list.create(start ? { order: +start } : null, items.nodes));
          i = items.next;
          break;
        }
        case 'hr':
          nodes.push(horizontal_rule.create());
          i++;
          break;
        case 'table_open': {
          const table = parseTableTokens(i);
          nodes.push(table.node);
          i = table.next;
          break;
        }
        case 'html_block':
          warnings.push('HTML block kept as a code block');
          nodes.push(code_block.create({ params: 'html' }, [schema.text(t.content.replace(/\n$/, ''))]));
          i++;
          break;
        case 'footnote_block_open': {
          // Definitions were consumed in the pre-pass.
          let d = 1;
          i++;
          while (i < tokens.length && d > 0) {
            if (tokens[i].type === 'footnote_block_open') d++;
            if (tokens[i].type === 'footnote_block_close') d--;
            i++;
          }
          break;
        }
        default:
          i++;
      }
    }
    return { nodes, next: i };
  }

  function parseListItems(i: number, closeType: string): { nodes: PMNode[]; next: number } {
    const items: PMNode[] = [];
    while (i < tokens.length && tokens[i].type !== closeType) {
      if (tokens[i].type === 'list_item_open') {
        const inner = parseBlocks(i + 1, 'list_item_close');
        items.push(
          schema.nodes.list_item.create(null, inner.nodes.length ? inner.nodes : [paragraph.create()]),
        );
        i = inner.next;
      } else i++;
    }
    return { nodes: items, next: i + 1 };
  }

  function parseTableTokens(i: number): { node: PMNode; next: number } {
    const rows: PMNode[] = [];
    let cells: PMNode[] = [];
    let header = false;
    while (i < tokens.length && tokens[i].type !== 'table_close') {
      const t = tokens[i];
      if (t.type === 'thead_open') header = true;
      else if (t.type === 'thead_close') header = false;
      else if (t.type === 'tr_open') cells = [];
      else if (t.type === 'tr_close') rows.push(schema.nodes.table_row.create(null, cells));
      else if (t.type === 'th_open' || t.type === 'td_open') {
        const inline = tokens[i + 1];
        const style = t.attrGet('style') ?? '';
        const align = /center/.test(style) ? 'center' : /right/.test(style) ? 'right' : null;
        const type = header || t.type === 'th_open' ? schema.nodes.table_header : schema.nodes.table_cell;
        cells.push(
          type.create({ align }, [paragraph.create(null, parseInline(inline?.children ?? []))]),
        );
        i++; // skip the inline
      }
      i++;
    }
    return { node: schema.nodes.table.create({ style: 'booktabs' }, rows), next: i + 1 };
  }

  const { nodes: body } = parseBlocks(0, null);

  const front: PMNode[] = [];
  if (title) front.push(schema.nodes.doc_title.create(null, [schema.text(title)]));
  if (authors) front.push(schema.nodes.doc_authors.create(null, [schema.text(authors)]));
  if (date) front.push(schema.nodes.doc_date.create(null, [schema.text(date)]));

  const blocks = [...front, ...body];
  if (bib && !sawBibNode) blocks.push(schema.nodes.bibliography.create());
  if (!blocks.length) blocks.push(paragraph.create());
  const doc = schema.nodes.doc.create({ settings, bib }, blocks);
  return { doc, warnings };
}
