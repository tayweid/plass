// Math nodes: Typst-rendered atoms with a popover source editor.
//
// Following spec §3.7: math nodes are atomic in the document; clicking one
// opens a small editor with a live KaTeX preview. Source syntax is LaTeX;
// the document surface shows Typst's own ink (math-ink.ts) with KaTeX as
// the instant echo, and the .typ exporter wraps sources with mitex.

import katex from 'katex';
import type { Node as PMNode } from 'prosemirror-model';
import { TextSelection, type Command } from 'prosemirror-state';
import type { EditorView, NodeView } from 'prosemirror-view';
import { InputRule } from 'prosemirror-inputrules';
import { schema } from './schema';
import { wrapAligned } from './math-src';
import { getSettings, parseMathMacros } from './settings';
import { forgetInk, getInk, inkFailed, inkKey, onInk, requestInk } from './math-ink';
import { scheduleTypeset } from './typeset-plugin';
import { mountTypstSvg } from './safe-svg';

export { wrapAligned };

function renderInto(el: HTMLElement, src: string, displayMode: boolean, macros: Record<string, string> = {}) {
  if (displayMode) src = wrapAligned(src);
  if (!src.trim()) {
    el.innerHTML = `<span class="math-placeholder">${displayMode ? 'equation' : 'math'}</span>`;
    return;
  }
  try {
    // KaTeX mutates the macros object (\def support) — hand it a copy.
    katex.render(src, el, { displayMode, throwOnError: false, macros: { ...macros } });
  } catch {
    el.textContent = src;
  }
}

/** NodeView lookup by document element — the editor popover starts and
 * settles the width hold through it (see MathView.beginWidthHold). */
const mathViews = new WeakMap<Node, MathView>();

export class MathView implements NodeView {
  dom: HTMLElement;
  private lastMacros: string;
  private display: boolean;
  private inkApplied = '';
  private stopInk: () => void;
  /**
   * Width hold (anti-jitter): while a math-editor session touches this
   * formula, the document keeps painting the last COMPILED ink — geometry
   * frozen — even after a commit changes the source. The popover's live
   * KaTeX preview is the user's echo; the in-document swap happens exactly
   * once, when the new compile lands. Lifecycle: begins at editor open
   * (only when compiled ink exists), ends at the first render where the
   * current source has its own settled ink, or is abandoned (fall back to
   * KaTeX, one re-layout) when the new compile fails or the held ink is
   * evicted. `data-math-hold-width` mirrors the held advance for
   * makeAtomWidth, so every line breaker keeps the held reservation.
   */
  private holdKey: string | null = null;

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    const display = node.type.name === 'math_display';
    this.display = display;
    this.dom = document.createElement(display ? 'div' : 'span');
    this.dom.className = display ? 'math-display' : 'math-inline';
    this.dom.setAttribute('data-math', node.attrs.src);
    mathViews.set(this.dom, this);
    this.lastMacros = getSettings(view.state).mathMacros;
    this.render();
    this.stopInk = onInk(() => this.render());
    this.dom.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const pos = this.getPos();
      if (pos !== undefined) openMathEditor(this.view, pos);
    });
    // A brand-new empty node (from an input rule or toolbar button) wants its
    // editor immediately.
    if (!node.attrs.src && !mathEditorOpen) {
      requestAnimationFrame(() => {
        const pos = this.getPos();
        if (pos !== undefined && !mathEditorOpen) openMathEditor(this.view, pos);
      });
    }
  }

  /**
   * Render the formula: Typst ink (the PDF's exact drawing) when compiled,
   * KaTeX instantly until then. Ink arrival re-runs the typesetter so line
   * justification picks up the exact atom width.
   */
  /** Editor open: freeze this formula's reservation at its compiled ink. */
  beginWidthHold() {
    const src = this.node.attrs.src as string;
    if (!src.trim()) return;
    const key = inkKey(src, this.display, getSettings(this.view.state));
    const ink = getInk(key);
    if (!ink) return;
    this.holdKey = key;
    this.dom.dataset.mathHoldWidth = String(ink.widthPx);
  }

  /** Editor closed: settle immediately if the current source is compiled
   * (unchanged source, or the new ink already arrived). Otherwise the hold
   * ends at the next render with settled ink. */
  settleWidthHold() {
    if (this.holdKey === null) return;
    const key = inkKey(this.node.attrs.src as string, this.display, getSettings(this.view.state));
    if (getInk(key)) this.endWidthHold();
  }

  private endWidthHold() {
    this.holdKey = null;
    delete this.dom.dataset.mathHoldWidth;
  }

  private render() {
    const src = this.node.attrs.src as string;
    const settings = getSettings(this.view.state);
    if (!src.trim()) {
      this.endWidthHold();
      this.inkApplied = '';
      renderInto(this.dom, src, this.display);
      return;
    }
    const key = inkKey(src, this.display, settings);
    const ink = getInk(key);
    if (ink) {
      this.endWidthHold();
      if (this.inkApplied === key) return;
      this.inkApplied = key;
      mountTypstSvg(this.dom, ink.svg);
      this.dom.classList.add('math-ink');
      const svg = this.dom.querySelector('svg');
      if (svg) {
        svg.style.width = `${ink.widthPx.toFixed(2)}px`;
        svg.style.height = `${ink.heightPx.toFixed(2)}px`;
        if (!this.display) svg.style.verticalAlign = `${(-ink.descentPx).toFixed(2)}px`;
        else {
          // Center the painted equation number on the ink (as Typst does).
          const cs = getComputedStyle(this.dom);
          const center = parseFloat(cs.paddingTop) + ink.heightPx / 2;
          this.dom.style.setProperty('--eqnum-center', `${center.toFixed(1)}px`);
        }
      }
      scheduleTypeset(this.view);
      return;
    }
    // No settled ink for the current source yet. During a width hold the
    // document keeps the held compiled ink painted (geometry frozen; the
    // popover shows the live KaTeX echo) and only queues the new compile —
    // the surrounding line re-breaks once, when that compile settles.
    if (this.holdKey !== null) {
      if (getInk(this.holdKey) && !inkFailed(key)) {
        requestInk(key, src, this.display, settings);
        return;
      }
      // New source failed to compile, or the held ink was evicted: abandon
      // the hold and fall back to the KaTeX echo (one re-layout).
      this.endWidthHold();
      scheduleTypeset(this.view);
    }
    if (this.inkApplied) {
      this.inkApplied = '';
      this.dom.classList.remove('math-ink');
    }
    renderInto(this.dom, src, this.display, parseMathMacros(this.lastMacros));
    requestInk(key, src, this.display, settings);
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    const macros = getSettings(this.view.state).mathMacros;
    if (node.attrs.src !== this.node.attrs.src || macros !== this.lastMacros) {
      this.lastMacros = macros;
      this.node = node;
      this.dom.setAttribute('data-math', node.attrs.src);
      forgetInk(inkKey(node.attrs.src as string, this.display, getSettings(this.view.state)));
      this.render();
      return true;
    }
    this.node = node;
    return true;
  }

  selectNode() {
    this.dom.classList.add('math-selected');
  }

  deselectNode() {
    this.dom.classList.remove('math-selected');
  }

  destroy() {
    this.stopInk();
  }

  ignoreMutation() {
    return true;
  }
}

let mathEditorOpen = false;

export function openMathEditor(view: EditorView, pos: number) {
  const node = view.state.doc.nodeAt(pos);
  if (!node || (node.type !== schema.nodes.math_inline && node.type !== schema.nodes.math_display)) return;
  if (mathEditorOpen) return;
  mathEditorOpen = true;

  // Anti-jitter width hold: the surrounding text keeps this formula's
  // compiled reservation for the whole editor session (see MathView).
  {
    const dom = view.nodeDOM(pos);
    if (dom) mathViews.get(dom)?.beginWidthHold();
  }

  const display = node.type.name === 'math_display';

  const panel = document.createElement('div');
  panel.className = 'math-editor';
  panel.innerHTML = `
    <div class="math-editor-preview" aria-hidden="true"></div>
    <textarea class="math-editor-input" rows="${display ? 3 : 1}"
      placeholder="${display ? '\\int_a^b f(x)\\,dx' : 'e^{i\\pi}+1=0'}" spellcheck="false"></textarea>
    ${display
      ? `<div class="math-editor-labelrow">
          <button type="button" class="math-editor-num" title="Toggle numbering for this equation"></button>
          <input class="math-editor-label" placeholder="label — reference in text with @label" spellcheck="false">
        </div>`
      : ''}
    <div class="math-editor-hint">LaTeX${display ? ' · <kbd>&amp;</kbd> aligns · <kbd>Enter</kbd> new line · <kbd>⌘Enter</kbd> save' : ' · <kbd>Enter</kbd> save'} · <kbd>Esc</kbd> cancel</div>`;
  const preview = panel.querySelector('.math-editor-preview') as HTMLElement;
  const input = panel.querySelector('.math-editor-input') as HTMLTextAreaElement;
  const labelInput = panel.querySelector('.math-editor-label') as HTMLInputElement | null;
  const numBtn = panel.querySelector('.math-editor-num') as HTMLButtonElement | null;
  input.value = node.attrs.src;
  if (labelInput) labelInput.value = node.attrs.label ?? '';
  // Binary toggle: numbered (default / attr null or true) vs unnumbered.
  let eqNumbered: boolean | null = node.attrs.numbered as boolean | null;
  // The number this equation gets while numbered: numbered equations
  // before it in the document, plus one (dense numbering).
  const eqNumber = (() => {
    if (!display) return 0;
    const docDefault = getSettings(view.state).numberEquations;
    let n = 0;
    view.state.doc.descendants((child, childPos) => {
      if (childPos >= pos || child.type.name !== 'math_display') return childPos < pos;
      if (((child.attrs.numbered as boolean | null) ?? docDefault) !== false) n++;
      return false;
    });
    return n + 1;
  })();
  const paintNum = () => {
    if (!numBtn) return;
    const on = eqNumbered !== false;
    numBtn.classList.toggle('math-editor-num-off', !on);
    numBtn.title = on ? 'Numbered — click to remove the number' : 'Unnumbered — click to number';
    preview.classList.toggle('math-editor-preview-numbered', on);
    if (on) preview.setAttribute('data-eqnum', `(${eqNumber})`);
    else preview.removeAttribute('data-eqnum');
  };
  numBtn?.addEventListener('click', () => {
    eqNumbered = eqNumbered === false ? null : false;
    paintNum();
  });

  const macros = parseMathMacros(getSettings(view.state).mathMacros);
  const updatePreview = () => renderInto(preview, input.value.trim() || '\\ldots', display, macros);
  updatePreview();
  paintNum();
  input.addEventListener('input', updatePreview);

  document.body.appendChild(panel);
  const target = view.nodeDOM(pos);
  const rect =
    target instanceof HTMLElement ? target.getBoundingClientRect() : view.coordsAtPos(pos);
  // Display equations: the editor spans the full block width.
  if (display && 'width' in rect && rect.width > 300) panel.style.width = `${rect.width}px`;
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - panel.offsetWidth - 8);
  const top =
    rect.bottom + panel.offsetHeight + 16 > window.innerHeight
      ? rect.top - panel.offsetHeight - 8
      : rect.bottom + 8;
  panel.style.left = `${left + window.scrollX}px`;
  panel.style.top = `${top + window.scrollY}px`;

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    mathEditorOpen = false;
    panel.remove();
    // Source unchanged (or already compiled): release the width hold now.
    // A changed source keeps its hold until the new ink settles.
    const dom = view.nodeDOM(pos);
    if (dom) mathViews.get(dom)?.settleWidthHold();
    view.focus();
  };

  const commit = () => {
    if (closed) return;
    const src = input.value.trim();
    const label = (labelInput?.value ?? '').trim().replace(/[^a-zA-Z0-9:._-]/g, '-');
    const current = view.state.doc.nodeAt(pos);
    if (current && current.type === node.type) {
      let tr;
      if (src) {
        const attrs = display ? { src, label, numbered: eqNumbered } : { src };
        tr = view.state.tr.setNodeMarkup(pos, undefined, attrs);
        // Put the caret after the node so the user can keep typing.
        tr.setSelection(TextSelection.near(tr.doc.resolve(pos + current.nodeSize), 1));
      } else {
        tr = view.state.tr.delete(pos, pos + current.nodeSize);
      }
      view.dispatch(tr);
    }
    close();
  };

  const cancel = () => {
    if (closed) return;
    const current = view.state.doc.nodeAt(pos);
    // Cancelling a never-filled node removes it.
    if (current && current.type === node.type && !current.attrs.src) {
      view.dispatch(view.state.tr.delete(pos, pos + current.nodeSize));
    }
    close();
  };

  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commit();
    } else if (e.key === 'Enter' && !e.shiftKey && !(display && e.target === input)) {
      // Display sources are multi-line: plain Enter inserts a line there;
      // everywhere else (inline math, the label field) it saves.
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };
  input.addEventListener('keydown', onKeydown);
  labelInput?.addEventListener('keydown', onKeydown);
  // Commit when focus truly leaves the panel (not when tabbing between fields).
  panel.addEventListener('focusout', (e) => {
    if (!panel.contains(e.relatedTarget as Node)) commit();
  });

  input.focus();
  input.select();
}

/** Toolbar/keymap command: wrap the selection (or insert) as math. */
export function insertMath(display: boolean): Command {
  return (state, dispatch) => {
    const type = display ? schema.nodes.math_display : schema.nodes.math_inline;
    const { from, to, empty } = state.selection;
    const src = empty ? '' : state.doc.textBetween(from, to, ' ');
    const node = type.create({ src });
    if (dispatch) dispatch(state.tr.replaceSelectionWith(node).scrollIntoView());
    return true;
  };
}

/** `$...$` becomes inline math as you type the closing dollar. */
export const mathInlineRule = new InputRule(/\$([^$\s](?:[^$]*[^$\s])?)\$$/, (state, match, start, end) => {
  return state.tr.replaceWith(start, end, schema.nodes.math_inline.create({ src: match[1] }));
});

/** `$$` on an empty line becomes a display-math block. */
export const mathDisplayRule = new InputRule(/^\$\$$/, (state, _match, start, end) => {
  const $start = state.doc.resolve(start);
  if ($start.parent.type !== schema.nodes.paragraph) return null;
  if ($start.parent.content.size > end - start) return null;
  return state.tr.replaceRangeWith(
    $start.before(),
    $start.after(),
    schema.nodes.math_display.create({ src: '' }),
  );
});
