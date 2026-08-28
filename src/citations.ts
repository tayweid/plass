// Citations: cite bibliography entries with live "[n]" numbering (first-use
// order, matching IEEE style in the PDF export) and a generated reference
// list. The BibTeX source lives in a document attribute — autosaved,
// undoable, and embedded in the .typ export so files stay self-contained.

import { Plugin, PluginKey, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView, type NodeView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from './schema';
import { parseBibTeX, bibAuthors, bibVenue, isPortableCitationKey, type BibEntry } from './bibtex';
import { INPUT_LIMITS, InputLimitError, readBoundedText, textSizeError } from './input-limits';
import { transactionTouchesNodeTypes } from './transaction-impact';
import {
  documentPreviewManagerFor,
  type ManagedDocumentPreviewView,
  type PreparedDocumentPublication,
  type TypstEmbedPreviewManager,
} from './raw-preview';
import type { TypstDocumentSvgPublication } from './typst-document-publication';
import { getSettings } from './settings';

export interface DocBib {
  name: string;
  content: string;
}

const parseCache = new WeakMap<DocBib, BibEntry[]>();

export function getBib(state: EditorState): BibEntry[] {
  const bib = state.doc.attrs.bib as DocBib | null;
  if (!bib?.content) return [];
  let entries = parseCache.get(bib);
  if (!entries) {
    entries = parseBibTeX(bib.content);
    parseCache.set(bib, entries);
  }
  return entries;
}

/** Citation keys in first-use order. */
export function citeOrder(doc: PMNode): Map<string, number> {
  const order = new Map<string, number>();
  doc.descendants((node) => {
    if (node.type.name === 'citation') {
      const key = node.attrs.key as string;
      if (key && !order.has(key)) order.set(key, order.size + 1);
    }
    return true;
  });
  return order;
}

export const citeKey = new PluginKey<DecorationSet>('citations');
const CITATION_NODES = new Set(['citation', 'bibliography']);

function build(state: EditorState): DecorationSet {
  const order = citeOrder(state.doc);
  const known = new Set(getBib(state).filter((e) => isPortableCitationKey(e.key)).map((e) => e.key));
  const decos: Decoration[] = [];
  state.doc.descendants((node, pos) => {
    if (node.type.name === 'citation') {
      const key = node.attrs.key as string;
      const n = order.get(key);
      const text = known.has(key) && n ? `[${n}]` : '[?]';
      decos.push(
        Decoration.node(pos, pos + node.nodeSize, {
          'data-cite-num': text,
          title: `@${key}${known.has(key) ? '' : ' — not found in bibliography'}`,
        }),
      );
      return false;
    }
    if (node.type.name === 'bibliography') {
      // A change to the cited set or the bib data must re-render the view.
      const bib = state.doc.attrs.bib as DocBib | null;
      const sig = [...order.keys()].join('|') + '#' + (bib?.content.length ?? 0);
      decos.push(Decoration.node(pos, pos + node.nodeSize, { 'data-bib-sig': sig }));
      return false;
    }
    return true;
  });
  return DecorationSet.create(state.doc, decos);
}

export function citationsPlugin() {
  return new Plugin<DecorationSet>({
    key: citeKey,
    state: {
      init: (_, state) => build(state),
      apply: (tr, val, _old, newState) => {
        if (!tr.docChanged) return val;
        return transactionTouchesNodeTypes(tr, CITATION_NODES)
          ? build(newState)
          : val.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations: (state) => citeKey.getState(state),
      handleClickOn(view, _pos, node) {
        if (node.type.name !== 'citation') return false;
        let target = -1;
        view.state.doc.descendants((n, p) => {
          if (target < 0 && n.type.name === 'bibliography') target = p;
          return target < 0;
        });
        if (target >= 0) {
          const dom = view.nodeDOM(target);
          if (dom instanceof HTMLElement) dom.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return true;
        }
        return false;
      },
    },
  });
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const PT_TO_PX = 4 / 3;

function bibliographyCrop(
  publication: PreparedDocumentPublication,
  x: number,
  y: number,
  width: number,
  height: number,
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `${x} ${y} ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  const image = document.createElementNS(SVG_NS, 'image');
  image.setAttribute('href', publication.objectUrl);
  image.setAttribute('x', String(publication.viewBox[0]));
  image.setAttribute('y', String(publication.viewBox[1]));
  image.setAttribute('width', String(publication.viewBox[2]));
  image.setAttribute('height', String(publication.viewBox[3]));
  image.setAttribute('preserveAspectRatio', 'none');
  image.setAttribute('data-exact-document-publication', '');
  svg.appendChild(image);
  return svg;
}

/** Renders the cited entries, in citation order, from the document bib. */
export class BibliographyView implements NodeView, ManagedDocumentPreviewView {
  dom: HTMLElement;
  private destroyed = false;
  private readonly manager: TypstEmbedPreviewManager;
  private renderedResult: TypstDocumentSvgPublication | null = null;
  private regionKey = '';
  private fallbackBib: DocBib | null = null;
  private fallbackOrder = '';

  constructor(
    _node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    this.dom = document.createElement('div');
    this.dom.className = 'ts-bibliography';
    this.dom.setAttribute('data-bibliography', '');
    this.render();
    this.manager = documentPreviewManagerFor(view);
    this.manager.register(this);
  }

  private render() {
    const state = this.view.state;
    const entries = getBib(state);
    const order = citeOrder(state.doc);
    const byKey = new Map(entries.map((e) => [e.key, e]));

    const cited = [...order.entries()].sort((a, b) => a[1] - b[1]);
    this.fallbackBib = state.doc.attrs.bib as DocBib | null;
    this.fallbackOrder = cited.map(([key, number]) => `${number}:${key}`).join('|');
    const ink = document.createElement('div');
    ink.className = 'bib-ink';
    ink.contentEditable = 'false';
    const fallback = document.createElement('div');
    fallback.className = 'bib-dom';
    const status = document.createElement('div');
    status.className = 'bib-preview-status';
    status.setAttribute('role', 'status');
    const head = document.createElement('div');
    head.className = 'bib-head';
    const heading = document.createElement('span');
    heading.textContent = 'References';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'bib-edit-btn';
    edit.contentEditable = 'false';
    edit.textContent = 'Edit';
    head.append(heading, edit);
    fallback.appendChild(head);
    if (!cited.length) {
      const empty = document.createElement('div');
      empty.className = 'bib-empty';
      empty.textContent = entries.length
        ? 'Cited works appear here — type @ to cite.'
        : 'No bibliography loaded — click Edit, then Import .bib…';
      fallback.appendChild(empty);
    } else {
      for (const [key, n] of cited) {
        const item = document.createElement('div');
        item.className = 'bib-item';
        const number = document.createElement('span');
        number.className = 'bib-n';
        number.textContent = `[${n}]`;
        const detail = document.createElement('span');
        const e = byKey.get(key);
        if (!e) {
          detail.textContent = `@${key} — not found in bibliography`;
        } else {
          const authors = bibAuthors(e);
          const title = e.fields.title ?? '';
          const venue = bibVenue(e);
          const year = e.fields.year ?? '';
          const tail = [venue, year].filter(Boolean).join(', ');
          if (authors) detail.append(document.createTextNode(`${authors}. `));
          const titleEl = document.createElement('i');
          titleEl.textContent = title;
          detail.appendChild(titleEl);
          if (title) detail.append(document.createTextNode('. '));
          if (tail) detail.append(document.createTextNode(`${tail}.`));
        }
        item.append(number, detail);
        fallback.appendChild(item);
      }
    }
    this.dom.replaceChildren(ink, fallback, status);
    this.dom.classList.remove('bib-has-ink', 'bib-proof');
    this.dom.style.removeProperty('--bib-exact-height');
    this.renderedResult = null;
    this.regionKey = '';
    this.dom.dataset.previewState = this.needsDocumentPreview() ? 'pending' : 'empty';
    edit.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      editBibliography(this.view);
    });
    const editHover = document.createElement('button');
    editHover.type = 'button';
    editHover.className = 'bib-edit-btn bib-edit-float';
    editHover.contentEditable = 'false';
    editHover.textContent = 'Edit';
    editHover.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      editBibliography(this.view);
    });
    this.dom.appendChild(editHover);
  }

  update(node: PMNode): boolean {
    if (node.type !== schema.nodes.bibliography) return false;
    this.render();
    this.manager.invalidate(this.view.state.doc);
    return true;
  }

  needsDocumentPreview(): boolean {
    const bib = this.view.state.doc.attrs.bib as DocBib | null;
    return !!bib?.content && citeOrder(this.view.state.doc).size > 0;
  }

  retainedDocumentPreview(): TypstDocumentSvgPublication | null {
    return this.renderedResult;
  }

  pending(): void {
    if (!this.needsDocumentPreview()) return;
    const bib = this.view.state.doc.attrs.bib as DocBib | null;
    const order = [...citeOrder(this.view.state.doc).entries()]
      .map(([key, number]) => `${number}:${key}`).join('|');
    if (bib !== this.fallbackBib || order !== this.fallbackOrder) this.render();
    this.dom.dataset.previewState = 'pending';
    const status = this.dom.querySelector<HTMLElement>('.bib-preview-status');
    if (status) status.textContent = this.renderedResult
      ? 'Updating exact references; showing the last good publication.'
      : 'Updating exact references…';
  }

  applyDocumentPreview(result: TypstDocumentSvgPublication, doc: PMNode): boolean {
    if (this.destroyed || !this.needsDocumentPreview()) return false;
    const pos = this.getPos();
    const publication = this.manager.publicationFor(result);
    const index = pos === undefined ? null : this.manager.regionIndexAt(doc, pos, 'preview');
    const meta = index === null ? null : publication?.previewRegions.get(index);
    if (!meta || meta.kind !== 'bibliography' || !publication) {
      this.compileError('The exact document did not expose bibliography geometry.');
      return false;
    }
    const key = [index, meta.start.page, meta.start.x, meta.start.y,
      meta.end.page, meta.end.x, meta.end.y].join(':');
    if (result === this.renderedResult && key === this.regionKey) return false;
    const previousHeight = this.dom.getBoundingClientRect().height;
    const status = this.dom.querySelector<HTMLElement>('.bib-preview-status');
    if (meta.start.page !== meta.end.page) {
      this.dom.classList.remove('bib-has-ink');
      this.dom.classList.add('bib-proof');
      this.dom.dataset.previewState = 'proof';
      if (status) status.textContent =
        `References span ${meta.end.page - meta.start.page + 1} Typst pages — open Proof for exact output.`;
      this.renderedResult = result;
      this.regionKey = key;
      return true;
    }
    const pageTop = publication.pageY[meta.start.page - 1];
    if (pageTop === undefined) {
      this.compileError('The bibliography page could not be located.');
      return false;
    }
    const start = pageTop + meta.start.y;
    const end = pageTop + meta.end.y;
    const height = end - start;
    const settings = getSettings(this.view.state);
    const cropX = meta.start.x;
    const right = publication.viewBox[0] + publication.viewBox[2] - settings.marginRight * 72;
    const width = right - cropX;
    if (!(height > 0.05) || !(width > 0.05)) {
      this.compileError('The bibliography region was empty or reversed.');
      return false;
    }
    const svg = bibliographyCrop(publication, cropX, start, width, height);
    svg.style.display = 'block';
    svg.style.width = `${width * PT_TO_PX}px`;
    svg.style.height = `${height * PT_TO_PX}px`;
    const holder = this.dom.querySelector<HTMLElement>('.bib-ink');
    if (!holder) return false;
    holder.replaceChildren(svg);
    this.dom.classList.add('bib-has-ink');
    this.dom.classList.remove('bib-proof');
    this.dom.style.setProperty('--bib-exact-height', `${height * PT_TO_PX}px`);
    this.dom.dataset.previewState = 'ready';
    if (status) status.textContent = '';
    this.renderedResult = result;
    this.regionKey = key;
    return Math.abs(previousHeight - height * PT_TO_PX) > 0.5;
  }

  compileError(message: string): void {
    if (this.destroyed || !this.needsDocumentPreview()) return;
    this.dom.dataset.previewState = 'error';
    const status = this.dom.querySelector<HTMLElement>('.bib-preview-status');
    if (status) status.textContent = this.renderedResult
      ? `Exact update failed; showing the last good references. ${message}`
      : `${message} References remain exact in Proof/PDF.`;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.manager.unregister(this);
  }

  selectNode() {
    this.dom.classList.add('bib-selected');
  }

  deselectNode() {
    this.dom.classList.remove('bib-selected');
  }

  ignoreMutation() {
    return true;
  }
}

const BIB_TEMPLATE = `% BibTeX — one entry per work, e.g.:
@article{smith21,
  author  = {Smith, Jane and Doe, John},
  title   = {A Paper Title},
  journal = {Journal of Examples},
  year    = {2021}
}
`;

let bibEditorOpen = false;

/** In-app editor for the document's BibTeX source. */
export function editBibliography(view: EditorView, message: (m: string) => void = () => {}) {
  if (bibEditorOpen) return;
  bibEditorOpen = true;

  const bib = view.state.doc.attrs.bib as DocBib | null;

  const overlay = document.createElement('div');
  overlay.className = 'bib-editor-overlay';
  overlay.innerHTML = `
    <div class="bib-editor" role="dialog" aria-label="Edit bibliography">
      <div class="bib-editor-head">
        <span>Bibliography (BibTeX)</span>
        <span class="bib-editor-count"></span>
      </div>
      <textarea class="bib-editor-text" spellcheck="false"></textarea>
      <div class="bib-editor-foot">
        <span class="bib-editor-hint">Stored inside the document · <kbd>⌘Enter</kbd> save · <kbd>Esc</kbd> cancel</span>
        <span class="bib-editor-actions">
          <button type="button" class="bib-import">Import .bib…</button>
          <button type="button" class="bib-dl">Download .bib</button>
          <button type="button" class="bib-cancel">Cancel</button>
          <button type="button" class="bib-save">Save</button>
        </span>
      </div>
    </div>`;
  const panel = overlay.querySelector('.bib-editor') as HTMLElement;
  const text = overlay.querySelector('.bib-editor-text') as HTMLTextAreaElement;
  const count = overlay.querySelector('.bib-editor-count') as HTMLElement;
  text.value = bib?.content ?? BIB_TEMPLATE;

  overlay.querySelector('.bib-import')?.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.bib,text/plain';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        text.value = await readBoundedText(file, INPUT_LIMITS.bibliographyBytes, file.name);
      } catch (error) {
        console.warn('Could not import bibliography', error);
        message(error instanceof InputLimitError ? error.message : `Could not read ${file.name}`);
        return;
      }
      updateCount();
      text.focus();
    });
    input.click();
  });

  const updateCount = () => {
    if (textSizeError(text.value, INPUT_LIMITS.bibliographyBytes, 'Bibliography')) {
      count.textContent = 'Over 4 MiB limit';
      return;
    }
    const n = parseBibTeX(text.value).length;
    count.textContent = `${n} entr${n === 1 ? 'y' : 'ies'}`;
  };
  updateCount();
  text.addEventListener('input', updateCount);

  const close = () => {
    overlay.remove();
    bibEditorOpen = false;
    view.focus();
  };

  const save = () => {
    // eslint-disable-next-line no-control-regex
    const content = text.value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
    const sizeError = textSizeError(content, INPUT_LIMITS.bibliographyBytes, 'Bibliography');
    if (sizeError) {
      message(sizeError);
      return;
    }
    const entries = parseBibTeX(content);
    const value = content ? { name: bib?.name ?? 'references.bib', content } : null;
    view.dispatch(view.state.tr.setDocAttribute('bib', value));
    message(content ? `Bibliography saved — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}` : 'Bibliography removed');
    close();
  };

  overlay.querySelector('.bib-save')!.addEventListener('click', save);
  overlay.querySelector('.bib-cancel')!.addEventListener('click', close);
  overlay.querySelector('.bib-dl')!.addEventListener('click', () => {
    const blob = new Blob([text.value], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = bib?.name ?? 'references.bib';
    a.click();
    URL.revokeObjectURL(a.href);
  });
  overlay.addEventListener('mousedown', (e) => {
    if (!panel.contains(e.target as Node)) close();
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
    }
  });

  document.body.appendChild(overlay);
  // Defer: menu handlers re-focus the editor after running their action.
  setTimeout(() => text.focus(), 0);
}
