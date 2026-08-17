import { Schema, type NodeSpec } from 'prosemirror-model';
import { schema as base } from 'prosemirror-schema-basic';
import { addListNodes } from 'prosemirror-schema-list';
import { tableNodes } from 'prosemirror-tables';
import { DEFAULT_SETTINGS } from './settings';

/** DOM serialization is used for clipboard copies as well as rendering.
 * Keep path/remote/SVG sources in inert data attributes so creating a
 * detached clipboard <img> cannot itself trigger document-controlled I/O. */
function serializedImageAttrs(node: { attrs: { src?: unknown; alt?: unknown; title?: unknown } }) {
  const src = String(node.attrs.src ?? '');
  const attrs: Record<string, string> = {
    'data-image-src': src,
    alt: String(node.attrs.alt ?? ''),
  };
  if (node.attrs.title) attrs.title = String(node.attrs.title);
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
  attrs: { src: { default: '' }, label: { default: '' }, name: { default: '' } },
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
      class: 'ts-figure',
    },
    ['img', serializedImageAttrs({ attrs: { src: node.attrs.src, alt: '' } })],
    ['figcaption', 0],
  ],
};

// A footnote: an inline marker whose editable body is rendered at the bottom
// Inline raw Typst: an escape hatch mid-sentence, the inline twin of the
// raw-Typst island block. Renders as its compiled self; the source is the
// document's truth and exports verbatim. `#h(1fr)` and other fr content is
// FLEXIBLE — the paginator measures the line's slack and hands it over
// (see inline-raw.ts), the one atom whose width layout decides.
const typstInline: NodeSpec = {
  group: 'inline',
  inline: true,
  atom: true,
  attrs: { src: { default: '' } },
  parseDOM: [
    {
      tag: 'span[data-typst]',
      getAttrs: (el) => ({ src: (el as HTMLElement).getAttribute('data-typst') ?? '' }),
    },
  ],
  toDOM: (node) => ['span', { 'data-typst': node.attrs.src, class: 'ts-inline-raw' }, node.attrs.src],
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
    align: {
      default: null,
      getFromDOM: (dom) => (dom as HTMLElement).style.textAlign || null,
      setDOMAttr: (value, attrs) => {
        if (value) attrs.style = ((attrs.style as string) ?? '') + `text-align:${value};`;
      },
    },
  },
});

const nodes = addListNodes(base.spec.nodes, 'paragraph block*', 'block')
  .append(tables)
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
  .update('image', {
    ...base.spec.nodes.get('image')!,
    parseDOM: [
      {
        tag: 'img[src], img[data-image-src]',
        getAttrs: (el: HTMLElement | string) => {
          if (typeof el === 'string') return false;
          return {
            src: el.getAttribute('data-image-src') ?? el.getAttribute('src') ?? '',
            alt: el.getAttribute('alt'),
            title: el.getAttribute('title'),
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
        class: `ts-table-${node.attrs.style}`,
      },
      ['tbody', 0],
    ],
  })
  .update('doc', {
    content: 'block+',
    attrs: {
      settings: { default: DEFAULT_SETTINGS },
      // { name: string, content: string } | null — the document's BibTeX data
      bib: { default: null },
    },
  })
  // Language/params tag on code blocks; 'typst-raw' marks a raw-Typst island
  // that the exporter passes through verbatim.
  .update('code_block', {
    ...base.spec.nodes.get('code_block')!,
    attrs: { params: { default: '' } },
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
  .addToEnd('abstract', abstract);

export const schema = new Schema({ nodes, marks: base.spec.marks });
