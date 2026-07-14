// Live numbering and references for equations and figures.
//
// Numbers are never stored in the document: a plugin scans the doc, assigns
// numbers in order, and paints them via decorations — equation numbers as a
// node-decoration attribute (CSS attr()), figure numbers as a "Figure N:"
// widget at the caption start, reference text the same way. Insert an
// equation or figure above and everything renumbers instantly. This is the
// editor owning the document, instead of LaTeX's compile-to-find-out.

import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { InputRule } from 'prosemirror-inputrules';
import { schema } from './schema';
import { getSettings } from './settings';
import { getBib } from './citations';

interface EqState {
  decos: DecorationSet;
  labels: Map<string, string>;
}

export const eqKey = new PluginKey<EqState>('equations');

function figNumWidget(text: string) {
  return () => {
    const span = document.createElement('span');
    span.className = 'fig-num';
    span.setAttribute('aria-hidden', 'true');
    span.contentEditable = 'false';
    span.textContent = text;
    return span;
  };
}

function fnNumWidget(text: string) {
  return () => {
    const span = document.createElement('span');
    span.className = 'fn-num';
    span.setAttribute('aria-hidden', 'true');
    span.contentEditable = 'false';
    span.textContent = text;
    return span;
  };
}

function build(doc: PMNode, numberEquations: boolean, numberSections: boolean): EqState {
  const labels = new Map<string, string>();
  const decos: Decoration[] = [];
  let eq = 0;
  let fig = 0;
  let fn = 0;
  let tab = 0;
  const sec = [0, 0, 0];

  doc.descendants((node, pos) => {
    if (node.type.name === 'heading' && numberSections) {
      const level = Math.min(3, node.attrs.level as number);
      sec[level - 1]++;
      for (let i = level; i < 3; i++) sec[i] = 0;
      const num = sec.slice(0, level).join('.');
      decos.push(Decoration.node(pos, pos + node.nodeSize, { 'data-secnum': num }));
      const label = node.attrs.label as string;
      if (label && !labels.has(label)) labels.set(label, `Section ${num}`);
      return true;
    }
    if (node.type.name === 'math_display') {
      // Per-equation override: numbered attr beats the document setting.
      // Unnumbered equations do not consume a number (dense numbering —
      // Typst behaves identically).
      const numbered = (node.attrs.numbered as boolean | null) ?? numberEquations;
      if (numbered) eq++;
      const label = node.attrs.label as string;
      if (label && !labels.has(label)) labels.set(label, numbered ? `(${eq})` : `@${label}`);
      if (numbered) {
        decos.push(Decoration.node(pos, pos + node.nodeSize, { 'data-eqnum': `(${eq})` }));
      }
      return false;
    }
    if (node.type.name === 'figure') {
      fig++;
      const label = node.attrs.label as string;
      if (label && !labels.has(label)) labels.set(label, `Figure ${fig}`);
      decos.push(
        Decoration.widget(pos + 1, figNumWidget(`Figure ${fig}:`), {
          side: -1,
          key: `fig:${pos}:${fig}`,
        }),
      );
      // descend: captions may contain footnotes
      return true;
    }
    if (node.type.name === 'table') {
      tab++;
      const label = node.attrs.label as string;
      if (label && !labels.has(label)) labels.set(label, `Table ${tab}`);
      return false;
    }
    if (node.type.name === 'footnote') {
      fn++;
      // superscript marker (CSS ::before reads data-fn) …
      decos.push(Decoration.node(pos, pos + node.nodeSize, { 'data-fn': String(fn) }));
      // … and the number at the head of the body text.
      decos.push(
        Decoration.widget(pos + 1, fnNumWidget(String(fn)), { side: -1, key: `fn:${pos}:${fn}` }),
      );
      return true;
    }
    return true;
  });

  // Second pass so forward references resolve.
  doc.descendants((node, pos) => {
    if (node.type.name !== 'eq_ref') return true;
    const label = node.attrs.label as string;
    const text = labels.get(label) ?? '(?)';
    decos.push(
      Decoration.node(pos, pos + node.nodeSize, { 'data-eqnum': text, title: `@${label} — click to jump` }),
    );
    return false;
  });

  return { decos: DecorationSet.create(doc, decos), labels };
}

/** Position of the labeled equation/figure, or -1. */
function findLabelTarget(doc: PMNode, label: string): number {
  let target = -1;
  doc.descendants((n, p) => {
    if (
      target < 0 &&
      (n.type.name === 'math_display' || n.type.name === 'figure' || n.type.name === 'heading' || n.type.name === 'table') &&
      n.attrs.label === label
    ) {
      target = p;
    }
    return target < 0;
  });
  return target;
}

export function equationsPlugin() {
  return new Plugin<EqState>({
    key: eqKey,
    state: {
      init: (_, state) => {
        const s = getSettings(state);
        return build(state.doc, s.numberEquations, s.numberSections);
      },
      apply: (tr, val, _old, newState) => {
        if (!tr.docChanged) return val;
        const s = getSettings(newState);
        return build(newState.doc, s.numberEquations, s.numberSections);
      },
    },
    props: {
      decorations: (state) => eqKey.getState(state)?.decos,
      handleClickOn(view, _pos, node) {
        if (node.type.name !== 'eq_ref') return false;
        const target = findLabelTarget(view.state.doc, node.attrs.label as string);
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

/**
 * Typing `@label ` inserts a live reference (equations/figures) or a
 * citation (bibliography keys). Unknown labels are left as plain text so
 * emails/handles survive.
 */
export const eqRefRule = new InputRule(/@([a-zA-Z0-9:._-]+)\s$/, (state, match, start, end) => {
  const key = match[1];
  if (getBib(state).some((e) => e.key === key)) {
    const cite = schema.nodes.citation.create({ key });
    let tr = state.tr.replaceWith(start, end, Fragment.from([cite, schema.text(' ')]));
    let hasBib = false;
    tr.doc.descendants((n) => {
      if (n.type.name === 'bibliography') hasBib = true;
      return !hasBib;
    });
    if (!hasBib) tr = tr.insert(tr.doc.content.size, schema.nodes.bibliography.create());
    return tr;
  }
  if (findLabelTarget(state.doc, key) < 0) return null;
  const ref = schema.nodes.eq_ref.create({ label: key });
  return state.tr.replaceWith(start, end, Fragment.from([ref, schema.text(' ')]));
});
