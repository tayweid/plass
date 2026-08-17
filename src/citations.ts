// Citations: cite bibliography entries with live "[n]" numbering (first-use
// order, matching IEEE style in the PDF export) and a generated reference
// list. The BibTeX source lives in a document attribute — autosaved,
// undoable, and embedded in the .typ export so files stay self-contained.

import { Plugin, PluginKey, type Command, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView, type NodeView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from './schema';
import { parseBibTeX, bibAuthors, bibVenue, isPortableCitationKey, type BibEntry } from './bibtex';
import { INPUT_LIMITS, InputLimitError, readBoundedText, textSizeError } from './input-limits';
import { mountTypstSvg } from './safe-svg';

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
      apply: (tr, val, _old, newState) => (tr.docChanged ? build(newState) : val),
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

/** Renders the cited entries, in citation order, from the document bib. */
export class BibliographyView implements NodeView {
  dom: HTMLElement;
  private inkKey = '';
  private inkTimer = 0;
  private destroyed = false;

  constructor(
    _node: PMNode,
    private view: EditorView,
  ) {
    this.dom = document.createElement('div');
    this.dom.className = 'ts-bibliography';
    this.dom.setAttribute('data-bibliography', '');
    this.render();
  }

  /**
   * Exact PDF rendering: compile the export's own #bibliography through the
   * in-app Typst (hidden citations establish first-use numbering) and show
   * that SVG. The DOM list below is the instant fallback while compiling.
   */
  private scheduleInk() {
    clearTimeout(this.inkTimer);
    this.inkTimer = window.setTimeout(() => void this.compileInk(), 300);
  }

  private async compileInk() {
    if (this.destroyed) return;
    const state = this.view.state;
    const bib = state.doc.attrs.bib as { content?: string } | null;
    const order = citeOrder(state.doc);
    const keys = [...order.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([k]) => k)
      .filter(isPortableCitationKey);
    if (!bib?.content || !keys.length) return;
    // Measure the column from the editor root — the node view's own box
    // may not be laid out yet when this first runs.
    const widthPx = this.view.dom.clientWidth || 576;
    const { getSettings } = await import('./settings');
    const { parityRules, textSetLine } = await import('./typ-serializer');
    const { compileSvg, FONT_FALLBACK } = await import('./pdf');
    const s = getSettings(state);
    const src =
      `#set page(width: ${(widthPx * 0.75).toFixed(2)}pt, height: auto, margin: 0pt)\n` +
      parityRules(s) +
      textSetLine(s, FONT_FALLBACK) +
      '\n' +
      `#place(hide[${keys.map((k) => '@' + k).join(' ')}])\n` +
      `#bibliography(bytes(${JSON.stringify(bib.content)}), title: "References", style: "ieee")\n`;
    if (src === this.inkKey) return;
    const svg = await compileSvg(src);
    if (this.destroyed || !svg) return;
    this.inkKey = src;
    const holder = this.dom.querySelector('.bib-ink');
    if (!holder) return;
    const svgEl = mountTypstSvg(holder, svg);
    if (svgEl) {
      svgEl.style.width = `${(parseFloat(svgEl.getAttribute('width') ?? '0') * 4) / 3}px`;
      svgEl.style.height = 'auto';
    }
    this.dom.classList.add('bib-has-ink');
    const { scheduleTypeset } = await import('./typeset-plugin');
    scheduleTypeset(this.view);
  }

  private render() {
    const state = this.view.state;
    const entries = getBib(state);
    const order = citeOrder(state.doc);
    const byKey = new Map(entries.map((e) => [e.key, e]));

    const cited = [...order.entries()].sort((a, b) => a[1] - b[1]);
    const ink = document.createElement('div');
    ink.className = 'bib-ink';
    ink.contentEditable = 'false';
    const fallback = document.createElement('div');
    fallback.className = 'bib-dom';
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
        : 'No bibliography loaded — click Edit, or File → Import bibliography (.bib).';
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
    this.dom.replaceChildren(ink, fallback);
    this.dom.classList.remove('bib-has-ink');
    this.inkKey = '';
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
    this.scheduleInk();
  }

  update(node: PMNode): boolean {
    if (node.type !== schema.nodes.bibliography) return false;
    this.render();
    return true;
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.inkTimer);
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

/** Insert a citation; ensure a bibliography block exists at the end. */
export function insertCitation(view: EditorView, key: string, from?: number, to?: number) {
  const { state } = view;
  const node = schema.nodes.citation.create({ key });
  let tr =
    from !== undefined && to !== undefined
      ? state.tr.replaceWith(from, to, node)
      : state.tr.replaceSelectionWith(node);
  let hasBib = false;
  tr.doc.descendants((n) => {
    if (n.type.name === 'bibliography') hasBib = true;
    return !hasBib;
  });
  if (!hasBib) tr = tr.insert(tr.doc.content.size, schema.nodes.bibliography.create());
  view.dispatch(tr.scrollIntoView());
}

/** File menu: read a .bib file into the document. */
export function importBibliography(view: EditorView, message: (m: string) => void) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.bib,text/plain';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    let content: string;
    try {
      content = (await readBoundedText(file, INPUT_LIMITS.bibliographyBytes, file.name))
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
    } catch (error) {
      console.warn('Could not import bibliography', error);
      message(error instanceof InputLimitError ? error.message : `Could not read ${file.name}`);
      return;
    }
    const entries = parseBibTeX(content);
    if (!entries.length) {
      message(`No entries found in ${file.name}`);
      return;
    }
    view.dispatch(view.state.tr.setDocAttribute('bib', { name: file.name, content }));
    message(`Imported ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} from ${file.name} — type @ to cite`);
    view.focus();
  });
  input.click();
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

/** Command form used by the @-input rule when a key matches the bib. */
export function citeCommand(key: string): Command {
  return (_state, dispatch, view) => {
    if (!view) return false;
    if (dispatch) insertCitation(view, key);
    return true;
  };
}
