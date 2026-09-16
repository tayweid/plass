import { Schema, type Node as PMNode, type NodeSpec } from 'prosemirror-model';
import { schema as base } from 'prosemirror-schema-basic';
import { addListNodes } from 'prosemirror-schema-list';
import { tableNodes } from 'prosemirror-tables';
import { DEFAULT_SETTINGS } from './settings';
import { normalizeInsetPt, normalizeTableColumns } from './table-geometry';

function imageWidthPct(value: unknown): number | null {
  const n = typeof value === 'string' && value ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 100 ? n : null;
}

function columnsFromDOM(el: HTMLElement): string[] | null {
  try { return normalizeTableColumns(JSON.parse(el.getAttribute('data-column-widths') || 'null')); }
  catch { return null; }
}

/** DOM serialization is used for clipboard copies as well as rendering.
 * Keep path/remote/SVG sources in inert data attributes so creating a
 * detached clipboard <img> cannot itself trigger document-controlled I/O. */
function serializedImageAttrs(node: { attrs: { src?: unknown; alt?: unknown; title?: unknown; widthPct?: unknown } }) {
  const src = String(node.attrs.src ?? '');
  const attrs: Record<string, string> = {
    'data-image-src': src,
    alt: String(node.attrs.alt ?? ''),
  };
  if (node.attrs.title) attrs.title = String(node.attrs.title);
  const width = imageWidthPct(node.attrs.widthPct);
  if (width !== null) attrs['data-width-pct'] = String(width);
  if (/^data:image\/(?:png|jpe?g|gif|webp);/i.test(src) || /^blob:/i.test(src)) attrs.src = src;
  return attrs;
}

const mathInline: NodeSpec = {
  group: 'inline',
  inline: true,
  atom: true,
  attrs: { src: { default: '' } },
  parseDOM: [
    {
      tag: 'span[data-math]',
      getAttrs: (el) => ({ src: (el as HTMLElement).getAttribute('data-math') ?? '' }),
    },
  ],
  toDOM: (node) => ['span', { 'data-math': node.attrs.src, class: 'math-inline' }, node.attrs.src],
};

const pageBreak: NodeSpec = {
  group: 'block',
  atom: true,
  selectable: true,
  parseDOM: [{ tag: 'div[data-page-break]' }],
  toDOM: () => ['div', { 'data-page-break': '', class: 'ts-pagebreak', contenteditable: 'false' }],
};

const numberingRestart: NodeSpec = {
  group: 'block',
  atom: true,
  selectable: true,
  parseDOM: [{ tag: 'div[data-numbering-restart]' }],
  toDOM: () => ['div', { 'data-numbering-restart': '', class: 'ts-numrestart', contenteditable: 'false' }],
};

// Front matter: title, authors, date — centered textblocks — and the
// abstract (a narrower block of paragraphs; its "Abstract" heading is
// painted by CSS and emitted by the exporter, never stored).
const docTitle: NodeSpec = {
  group: 'block',
  content: 'inline*',
  defining: true,
  parseDOM: [{ tag: 'div[data-doc-title]' }],
  toDOM: () => ['div', { 'data-doc-title': '', class: 'ts-doctitle' }, 0],
};

const docAuthors: NodeSpec = {
  group: 'block',
  content: 'inline*',
  defining: true,
  parseDOM: [{ tag: 'div[data-doc-authors]' }],
  toDOM: () => ['div', { 'data-doc-authors': '', class: 'ts-docauthors' }, 0],
};

const docDate: NodeSpec = {
  group: 'block',
  content: 'inline*',
  defining: true,
  parseDOM: [{ tag: 'div[data-doc-date]' }],
  toDOM: () => ['div', { 'data-doc-date': '', class: 'ts-docdate' }, 0],
};

const abstract: NodeSpec = {
  group: 'block',
  content: 'paragraph+',
  defining: true,
  parseDOM: [{ tag: 'div[data-abstract]' }],
  toDOM: () => ['div', { 'data-abstract': '', class: 'ts-abstract' }, 0],
};

const mathDisplay: NodeSpec = {
  group: 'block',
  atom: true,
  attrs: { src: { default: '' }, label: { default: '' }, numbered: { default: null } },
  parseDOM: [
    {
      tag: 'div[data-math]',
      getAttrs: (el) => ({
        src: (el as HTMLElement).getAttribute('data-math') ?? '',
        label: (el as HTMLElement).getAttribute('data-label') ?? '',
        numbered:
          (el as HTMLElement).getAttribute('data-numbered') === 'on'
            ? true
            : (el as HTMLElement).getAttribute('data-numbered') === 'off'
              ? false
              : null,
      }),
    },
  ],
  toDOM: (node) => [
    'div',
    { 'data-math': node.attrs.src, 'data-label': node.attrs.label, class: 'math-display' },
    node.attrs.src,
  ],
};

// A figure: image + editable inline caption. The "Figure N" prefix is painted
// by the numbering plugin, never stored.
const figure: NodeSpec = {
  group: 'block',
  content: 'inline*',
  // `title`: a Markdown image title (`![alt](src "title")`), carried for
  // the .md round trip; Typst has no use for it.
  attrs: { src: { default: '' }, label: { default: '' }, name: { default: '' }, title: { default: '' }, widthPct: { default: null } },
  draggable: true,
  isolating: true,
  parseDOM: [
    {
      tag: 'figure[data-figure]',
      contentElement: 'figcaption',
      getAttrs: (el) => ({
        src:
          (el as HTMLElement).getAttribute('data-image-src') ??
          (el as HTMLElement).querySelector('img')?.getAttribute('data-image-src') ??
          (el as HTMLElement).querySelector('img')?.getAttribute('src') ??
          '',
        label: (el as HTMLElement).getAttribute('data-label') ?? '',
        name: (el as HTMLElement).getAttribute('data-name') ?? '',
        widthPct: imageWidthPct((el as HTMLElement).getAttribute('data-width-pct')),
      }),
    },
  ],
  toDOM: (node) => [
    'figure',
    {
      'data-figure': '',
      'data-image-src': node.attrs.src,
      'data-label': node.attrs.label,
      'data-name': node.attrs.name,
      'data-width-pct': imageWidthPct(node.attrs.widthPct),
      class: 'ts-figure',
    },
    ['img', serializedImageAttrs({ attrs: { src: node.attrs.src, alt: '', widthPct: node.attrs.widthPct } })],
    ['figcaption', 0],
  ],
};

// A footnote: an inline marker whose editable body is rendered at the bottom
// Inline raw Typst: an escape hatch mid-sentence, the inline twin of the
// raw-Typst island block. Renders as its compiled self; the source is the
// document's truth and exports verbatim. `#h(1fr)` and other fr content is
// Inline island: raw Typst (`#h(1fr)` in a .typ file) or inline HTML
// (`<sub>2</sub>`, an inline `<!-- comment -->` in a .md file; `lang:
// 'html'`). Kept verbatim in its own file, shown and printed as inline
// code, never run (Typst on rails).
const typstInline: NodeSpec = {
  group: 'inline',
  inline: true,
  atom: true,
  attrs: { src: { default: '' }, lang: { default: 'typst' } },
  parseDOM: [
    {
      tag: 'span[data-typst]',
      getAttrs: (el) => ({
        src: (el as HTMLElement).getAttribute('data-typst') ?? '',
        lang: (el as HTMLElement).getAttribute('data-lang') ?? 'typst',
      }),
    },
  ],
  toDOM: (node) => [
    'span',
    { 'data-typst': node.attrs.src, 'data-lang': node.attrs.lang === 'typst' ? null : node.attrs.lang, class: 'ts-inline-raw' },
    node.attrs.src,
  ],
};

// of the page the marker lands on (positioned by the paginator). The
// superscript number is painted by the numbering plugin, never stored.
const footnote: NodeSpec = {
  group: 'inline',
  inline: true,
  content: 'inline*',
  isolating: true,
  parseDOM: [{ tag: 'span[data-footnote]', contentElement: '.fn-body' }],
  toDOM: () => ['span', { 'data-footnote': '', class: 'ts-footnote' }, ['div', { class: 'fn-body' }, 0]],
};

// A citation of a bibliography entry. The "[n]" is painted by the citations
// plugin (first-use order, matching IEEE style in the PDF) — never stored.
const citation: NodeSpec = {
  group: 'inline',
  inline: true,
  atom: true,
  attrs: { key: { default: '' } },
  parseDOM: [
    {
      tag: 'span[data-cite]',
      getAttrs: (el) => ({ key: (el as HTMLElement).getAttribute('data-cite') ?? '' }),
    },
  ],
  toDOM: (node) => ['span', { 'data-cite': node.attrs.key, class: 'ts-cite' }],
};

// The reference list. Content is generated (cited entries from the document
// bibliography, in citation order) by its node view.
const bibliography: NodeSpec = {
  group: 'block',
  atom: true,
  selectable: true,
  parseDOM: [{ tag: 'div[data-bibliography]' }],
  toDOM: () => ['div', { 'data-bibliography': '', class: 'ts-bibliography' }],
};

// A live reference to a labeled equation or figure. The displayed text is
// painted by the numbering plugin via a decoration attribute — never stored.
const eqRef: NodeSpec = {
  group: 'inline',
  inline: true,
  atom: true,
  attrs: { label: { default: '' } },
  parseDOM: [
    {
      tag: 'span[data-eq-ref]',
      getAttrs: (el) => ({ label: (el as HTMLElement).getAttribute('data-eq-ref') ?? '' }),
    },
  ],
  toDOM: (node) => ['span', { 'data-eq-ref': node.attrs.label, class: 'eq-ref' }],
};

const tables = tableNodes({
  tableGroup: 'block',
  cellContent: 'block+',
  cellAttributes: {
    valign: {
      default: null,
      getFromDOM: (dom) => ['top', 'middle', 'bottom'].includes((dom as HTMLElement).style.verticalAlign) ? (dom as HTMLElement).style.verticalAlign : null,
      setDOMAttr: (value, attrs) => {
        if (typeof value === 'string' && ['top', 'middle', 'bottom'].includes(value)) attrs.style = ((attrs.style as string) ?? '') + `vertical-align:${value};`;
      },
    },
    align: {
      default: null,
      getFromDOM: (dom) => (dom as HTMLElement).style.textAlign || null,
      setDOMAttr: (value, attrs) => {
        // Cell alignment controls the last line while the paragraph keeps
        // Typst's justification on wrapped lines. Paragraphs set their own
        // text-align, but inherit text-align-last from the cell.
        if (value) attrs.style = ((attrs.style as string) ?? '') + `text-align:${value};text-align-last:${value === 'decimal' ? 'right' : value};`;
      },
    },
    // A fill preset (table-fills.ts): '' | 'gray' | 'yellow' | 'blue'.
    fill: {
      default: '',
      getFromDOM: (dom) => (dom as HTMLElement).getAttribute('data-fill') ?? '',
      setDOMAttr: (value, attrs) => {
        if (value) attrs['data-fill'] = value;
      },
    },
  },
});

const listNodes = addListNodes(base.spec.nodes, 'paragraph block*', 'block');
/** Item pitch. Typst spaces a tight list's items by leading (Plass: leading +
 *  0.25em, the calibrated `list.spacing`) and a loose one's by paragraph
 *  spacing; Markdown reads looseness from blank lines between items, Typst
 *  markup the same. `data-tight="0"` paints the loose pitch. */
const withTight = (name: 'bullet_list' | 'ordered_list') => {
  const spec = listNodes.get(name)!;
  const tag = name === 'bullet_list' ? 'ul' : 'ol';
  return {
    ...spec,
    attrs: { ...(spec.attrs ?? {}), tight: { default: true } },
    parseDOM: [
      {
        tag,
        getAttrs: (el: HTMLElement | string) => {
          if (typeof el === 'string') return { tight: true };
          const attrs: Record<string, unknown> = { tight: el.getAttribute('data-tight') !== '0' };
          if (name === 'ordered_list') attrs.order = el.hasAttribute('start') ? +el.getAttribute('start')! : 1;
          return attrs;
        },
      },
    ],
    toDOM(node: PMNode) {
      const attrs: Record<string, string> = {};
      if (!node.attrs.tight) attrs['data-tight'] = '0';
      if (name === 'ordered_list' && (node.attrs.order as number) !== 1) attrs.start = String(node.attrs.order);
      return [tag, attrs, 0] as const;
    },
  };
};

/** The grid rail (grid-editor.ts): rows of cells holding any block
 *  content; `columns` are fraction shares (Typst `fr`), `gutter` is em.
 *  The grid element carries the CSS variables its rows lay out by. */
const parseShares = (text: string | null): number[] => {
  const shares = (text ?? '')
    .split(/[\s,]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  return shares.length ? shares : [1, 1];
};
const gridSpecs: Record<string, NodeSpec> = {
  grid: {
    group: 'block',
    content: 'grid_row+',
    isolating: true,
    attrs: { columns: { default: [1, 1] }, gutter: { default: 1 } },
    parseDOM: [
      {
        tag: 'div.ts-grid',
        getAttrs: (el: HTMLElement | string) =>
          typeof el === 'string'
            ? null
            : { columns: parseShares(el.getAttribute('data-columns')), gutter: Number(el.getAttribute('data-gutter')) || 1 },
      },
    ],
    toDOM(node) {
      const columns = node.attrs.columns as number[];
      const gutter = node.attrs.gutter as number;
      return [
        'div',
        {
          class: 'ts-grid',
          'data-columns': columns.join(' '),
          'data-gutter': String(gutter),
          style: `--grid-cols: ${columns.map((c) => `${c}fr`).join(' ')}; --grid-gutter: ${gutter}em`,
        },
        0,
      ];
    },
  },
  grid_row: {
    content: 'grid_cell+',
    parseDOM: [{ tag: 'div.ts-grid-row' }],
    toDOM: () => ['div', { class: 'ts-grid-row' }, 0],
  },
  grid_cell: {
    content: 'block+',
    isolating: true,
    parseDOM: [{ tag: 'div.ts-grid-cell' }],
    toDOM: () => ['div', { class: 'ts-grid-cell' }, 0],
  },
};

// An editorial comment (editor-comments.ts): plain text between top-level
// blocks, shown on the page as a strip that is visibly not paper, kept in
// the working file, absent from every rendered export. Not in the `block`
// group on purpose: only the document accepts it, never a list item, a
// quote, a cell, or a footnote. `code` keeps input rules and the printed-
// form normalizer out of it; the note holds exactly what was typed.
const editorComment: NodeSpec = {
  content: 'text*',
  marks: '',
  code: true,
  defining: true,
  isolating: true,
  parseDOM: [{ tag: 'div[data-editor-comment]', contentElement: '.editor-comment-text', preserveWhitespace: 'full' }],
  toDOM: () => ['div', { 'data-editor-comment': '', class: 'editor-comment' }, ['div', { class: 'editor-comment-text' }, 0]],
};

const nodes = listNodes
  .update('bullet_list', withTight('bullet_list'))
  .update('ordered_list', withTight('ordered_list'))
  .append(tables)
  .append(gridSpecs)
  // The rule under a row: '' (the style preset's), 'light', 'heavy', or
  // 'none' (table-rules.ts).
  .update('table_row', {
    ...tables.table_row,
    attrs: { rule: { default: '' } },
    parseDOM: [{ tag: 'tr', getAttrs: (el) => ({ rule: (el as HTMLElement).getAttribute('data-rule') ?? '' }) }],
    toDOM: (node) => ['tr', { 'data-rule': (node.attrs.rule as string) || null }, 0],
  })
  // Paragraphs may be kept together across page breaks (block(breakable:
  // false) on export; the paginator treats them as atomic).
  .update('paragraph', {
    ...base.spec.nodes.get('paragraph')!,
    // keep: held together across page breaks. align: null = justified body
    // text (the default); 'center'/'right' lay out via the browser (like
    // table cells) — short display lines, not oracle-broken prose.
    attrs: { keep: { default: false }, align: { default: null } },
    parseDOM: [
      {
        tag: 'p',
        getAttrs: (el: HTMLElement | string) =>
          typeof el === 'string'
            ? { keep: false, align: null }
            : { keep: el.getAttribute('data-keep') === '1', align: el.getAttribute('data-align') || null },
      },
    ],
    toDOM(node) {
      const attrs: Record<string, string> = {};
      if (node.attrs.keep) {
        attrs['data-keep'] = '1';
        attrs.class = 'ts-keep';
      }
      if (node.attrs.align) attrs['data-align'] = node.attrs.align as string;
      return ['p', attrs, 0];
    },
  })
  // Quotes carry a kind: null = Typst's #quote(block: true) (plain
  // indentation); 'solution' = the solution preset (left rule, red text —
  // a #block with a left stroke and inset on export). Same container, same
  // pagination model; only the export wrapper and the paint differ.
  .update('blockquote', {
    ...base.spec.nodes.get('blockquote')!,
    attrs: { kind: { default: null } },
    parseDOM: [
      {
        tag: 'blockquote',
        getAttrs: (el: HTMLElement | string) =>
          typeof el === 'string' ? { kind: null } : { kind: el.getAttribute('data-kind') || null },
      },
    ],
    toDOM(node) {
      return node.attrs.kind ? ['blockquote', { 'data-kind': node.attrs.kind as string }, 0] : ['blockquote', 0];
    },
  })
  .update('image', {
    ...base.spec.nodes.get('image')!,
    attrs: { ...base.spec.nodes.get('image')!.attrs, widthPct: { default: null } },
    parseDOM: [
      {
        tag: 'img[src], img[data-image-src]',
        getAttrs: (el: HTMLElement | string) => {
          if (typeof el === 'string') return false;
          return {
            src: el.getAttribute('data-image-src') ?? el.getAttribute('src') ?? '',
            alt: el.getAttribute('alt'),
            title: el.getAttribute('title'),
            widthPct: imageWidthPct(el.getAttribute('data-width-pct')),
          };
        },
      },
    ],
    toDOM: (node) => ['img', serializedImageAttrs(node)],
  })
  // Headings carry an optional label so they can be @-referenced; the
  // "1.2"-style number is painted by the numbering plugin, never stored.
  .update('heading', {
    ...base.spec.nodes.get('heading')!,
    attrs: { level: { default: 1 }, label: { default: '' } },
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({
      tag: `h${level}`,
      getAttrs: (el: HTMLElement | string) => ({
        level,
        label: typeof el === 'string' ? '' : (el.getAttribute('data-label') ?? ''),
      }),
    })),
    toDOM: (node) => [`h${node.attrs.level}`, { 'data-label': node.attrs.label }, 0],
  })
  // Table style presets (booktabs is the academic default: horizontal rules
  // only). Mirrored by editor CSS and by stroke/hline emission on export.
  .update('table', {
    ...tables.table,
    // style: screen preset; params: raw Typst #table arguments passed through
    // verbatim on export (full-control escape hatch).
    attrs: {
      style: { default: 'booktabs' },
      params: { default: '' },
      caption: { default: '' },
      label: { default: '' },
      fontSize: { default: '' },
      // Cell inset preset: '' (Typst's 5pt), 'compact' (3pt), 'roomy'
      // (8pt) — table-density.ts.
      density: { default: '' },
      columnWidths: { default: null },
      insetPt: { default: null },
    },
    parseDOM: [
      {
        tag: 'table',
        getAttrs: (el) => ({
          style: (el as HTMLElement).getAttribute('data-style') || 'booktabs',
          params: (el as HTMLElement).getAttribute('data-params') || '',
          caption: (el as HTMLElement).getAttribute('data-caption') || '',
          label: (el as HTMLElement).getAttribute('data-label') || '',
          fontSize: (el as HTMLElement).getAttribute('data-font-size') || '',
          density: (el as HTMLElement).getAttribute('data-density') || '',
          columnWidths: columnsFromDOM(el as HTMLElement),
          insetPt: (el as HTMLElement).hasAttribute('data-inset-pt') ? normalizeInsetPt(Number((el as HTMLElement).getAttribute('data-inset-pt'))) : null,
        }),
      },
    ],
    toDOM: (node) => [
      'table',
      {
        'data-style': node.attrs.style,
        'data-params': node.attrs.params,
        'data-caption': node.attrs.caption,
        'data-label': node.attrs.label,
        'data-font-size': node.attrs.fontSize,
        'data-density': (node.attrs.density as string) || null,
        'data-column-widths': node.attrs.columnWidths ? JSON.stringify(node.attrs.columnWidths) : null,
        'data-inset-pt': normalizeInsetPt(node.attrs.insetPt),
        style: normalizeInsetPt(node.attrs.insetPt) !== null ? `--cell-inset:${node.attrs.insetPt}pt` : null,
        class: `ts-table-${node.attrs.style}`,
      },
      ['tbody', 0],
    ],
  })
  .update('doc', {
    // Editorial comments are accepted here and nowhere else.
    content: '(block | editor_comment)+',
    attrs: {
      settings: { default: DEFAULT_SETTINGS },
      // { name: string, content: string } | null — the document's BibTeX data
      bib: { default: null },
      // Markdown frontmatter lines Plass has no field for (unknown keys,
      // YAML lists and block scalars), kept verbatim from .md open to .md
      // save. Never rendered; .typ has no home for it.
      frontmatter: { default: '' },
    },
  })
  // Language/params tag on code blocks. Two values mark islands — content
  // the page keeps but does not run: 'typst-raw' (unknown Typst from a .typ
  // file, or typed in the source view; the .typ save keeps it verbatim) and
  // 'md-raw' (an HTML block or `<!-- comment -->` from a .md file; the .md
  // save keeps it verbatim). Both show as a code block in the page and
  // print as one in the PDF, so page and print agree and nothing is hidden.
  .update('code_block', {
    ...base.spec.nodes.get('code_block')!,
    // `tight` (md-raw islands only): which sides had no blank line in the
    // .md file — '', 'before', 'after', 'both' — so the save reproduces
    // the file's own spacing around a comment. Never rendered.
    attrs: { params: { default: '' }, tight: { default: '' } },
    parseDOM: [
      {
        tag: 'pre',
        preserveWhitespace: 'full',
        getAttrs: (el) => ({
          params: (el as HTMLElement).getAttribute('data-params') ?? '',
          tight: (el as HTMLElement).getAttribute('data-tight') ?? '',
        }),
      },
    ],
    toDOM: (node) => [
      'pre',
      { 'data-params': (node.attrs.params as string) || null, 'data-tight': (node.attrs.tight as string) || null },
      ['code', 0],
    ],
  })
  .addToEnd('math_inline', mathInline)
  .addToEnd('typst_inline', typstInline)
  .addToEnd('math_display', mathDisplay)
  .addToEnd('figure', figure)
  .addToEnd('footnote', footnote)
  .addToEnd('citation', citation)
  .addToEnd('bibliography', bibliography)
  .addToEnd('eq_ref', eqRef)
  .addToEnd('page_break', pageBreak)
  .addToEnd('numbering_restart', numberingRestart)
  .addToEnd('doc_title', docTitle)
  .addToEnd('doc_authors', docAuthors)
  .addToEnd('doc_date', docDate)
  .addToEnd('abstract', abstract)
  .addToEnd('editor_comment', editorComment);

// Strikethrough is not in schema-basic; Typst has it natively (#strike),
// so it round-trips through both formats. Paint-only — line-through never
// changes glyph metrics, so the measurer treats it as plain text.
const marks = base.spec.marks.addToEnd('strike', {
  parseDOM: [
    { tag: 's' },
    { tag: 'del' },
    { tag: 'strike' },
    { style: 'text-decoration=line-through' },
  ],
  toDOM() {
    return ['s', 0] as const;
  },
});

export const schema = new Schema({ nodes, marks });
