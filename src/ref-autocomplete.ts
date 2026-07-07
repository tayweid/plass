// Reference autocomplete: type `@` to pick a labeled equation or figure.
//
// The popup lists every label in the document (with its live number and a
// content preview), filters as you type, and inserts a reference on
// Enter/Tab/click. An explicit "unresolved" entry supports forward
// references while drafting. A guard skips email-like text (letter before
// the @). Complements the `@label ` input rule, which still auto-converts
// exact existing labels on space.

import { Plugin, TextSelection, type EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { schema } from './schema';
import { citeOrder, getBib } from './citations';
import { bibAuthors } from './bibtex';

interface LabelEntry {
  label: string;
  display: string; // "(2)", "Figure 1", "[3]", "[·]"
  preview: string;
  kind: 'ref' | 'cite';
}

interface Active {
  from: number; // position of the '@'
  to: number; // cursor
  query: string;
}

function collectLabels(state: EditorState): LabelEntry[] {
  const out: LabelEntry[] = [];
  let eq = 0;
  let fig = 0;
  state.doc.descendants((node) => {
    if (node.type.name === 'math_display') {
      eq++;
      const label = node.attrs.label as string;
      if (label) out.push({ label, display: `(${eq})`, preview: String(node.attrs.src).slice(0, 32), kind: 'ref' });
      return false;
    }
    if (node.type.name === 'figure') {
      fig++;
      const label = node.attrs.label as string;
      if (label) out.push({ label, display: `Figure ${fig}`, preview: node.textContent.slice(0, 32), kind: 'ref' });
      return false;
    }
    return true;
  });
  // Bibliography entries: cite by key, searchable by author/title too.
  const order = citeOrder(state.doc);
  for (const e of getBib(state)) {
    const n = order.get(e.key);
    out.push({
      label: e.key,
      display: n ? `[${n}]` : '[·]',
      preview: `${bibAuthors(e)}${e.fields.year ? ` (${e.fields.year})` : ''} ${e.fields.title ?? ''}`.trim().slice(0, 44),
      kind: 'cite',
    });
  }
  return out;
}

function activeRef(state: EditorState): Active | null {
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock) return null;
  // No refs inside code blocks or code spans.
  if ($from.parent.type.spec.code) return null;
  if (schema.marks.code.isInSet($from.marks())) return null;
  const start = Math.max(0, $from.parentOffset - 48);
  const before = $from.parent.textBetween(start, $from.parentOffset, '￼', '￼');
  const m = /@([a-zA-Z0-9:._-]*)$/.exec(before);
  if (!m) return null;
  // Email guard: the char before '@' must not be a word character.
  const prev = before[before.length - m[0].length - 1];
  if (prev && /[\w.]/.test(prev)) return null;
  return { from: $from.pos - m[0].length, to: $from.pos, query: m[1] };
}

export function refAutocomplete() {
  let menu: HTMLElement | null = null;
  let items: Array<{ label: string | null; kind: 'ref' | 'cite'; el: HTMLElement }> = [];
  let selected = 0;
  let active: Active | null = null;
  let lastSignature = '';

  const close = () => {
    menu?.remove();
    menu = null;
    items = [];
    active = null;
    lastSignature = '';
  };

  const insert = (view: EditorView, label: string | null, kind: 'ref' | 'cite') => {
    if (!active || !label) return;
    const node =
      kind === 'cite' ? schema.nodes.citation.create({ key: label }) : schema.nodes.eq_ref.create({ label });
    let tr = view.state.tr.replaceWith(active.from, active.to, node);
    if (kind === 'cite') {
      let hasBib = false;
      tr.doc.descendants((n) => {
        if (n.type.name === 'bibliography') hasBib = true;
        return !hasBib;
      });
      if (!hasBib) tr = tr.insert(tr.doc.content.size, schema.nodes.bibliography.create());
    }
    tr = tr.setSelection(TextSelection.create(tr.doc, active.from + 1));
    view.dispatch(tr.scrollIntoView());
    close();
    view.focus();
  };

  const render = (view: EditorView) => {
    const state = view.state;
    const found = activeRef(state);
    if (!found) {
      close();
      return;
    }
    active = found;

    const all = collectLabels(state);
    const q = found.query.toLowerCase();
    const matches = all.filter(
      (e) => e.label.toLowerCase().includes(q) || (q && e.preview.toLowerCase().includes(q)),
    );
    const exact = all.some((e) => e.label === found.query);

    const signature =
      found.query + '|' + matches.map((m) => `${m.label}:${m.display}`).join(',') + '|' + (exact ? 1 : 0);

    if (!menu) {
      menu = document.createElement('div');
      menu.className = 'ref-menu';
      document.body.appendChild(menu);
      lastSignature = '';
    }

    if (signature !== lastSignature) {
      lastSignature = signature;
      selected = 0;
      menu.replaceChildren();
      items = [];

      const addItem = (label: string | null, kind: 'ref' | 'cite', html: string, cls = '') => {
        const el = document.createElement('div');
        el.className = 'ref-menu-item ' + cls;
        el.innerHTML = html;
        if (label !== null) {
          el.addEventListener('mousedown', (e) => {
            e.preventDefault();
            insert(view, label, kind);
          });
        }
        menu!.appendChild(el);
        items.push({ label, kind, el });
      };

      if (!all.length) {
        addItem(
          null,
          'ref',
          'Nothing to reference yet.<br><span class="ref-menu-hint">Label an equation or figure to reference it, or File → Import bibliography (.bib) to cite works.</span>',
          'ref-menu-empty',
        );
      } else {
        for (const e of matches.slice(0, 8)) {
          addItem(
            e.label,
            e.kind,
            `<span class="ref-menu-num">${e.display}</span><span class="ref-menu-label">@${e.label}</span><span class="ref-menu-preview">${e.preview.replace(/</g, '&lt;')}</span>`,
          );
        }
        if (!matches.length || (!exact && found.query)) {
          addItem(
            found.query || null,
            'ref',
            found.query
              ? `<span class="ref-menu-num">(?)</span><span class="ref-menu-label">@${found.query}</span><span class="ref-menu-preview">unresolved — resolves when labeled</span>`
              : '',
            'ref-menu-unresolved',
          );
        }
      }
      updateSelection();
    }

    const coords = view.coordsAtPos(found.from);
    menu.style.left = `${Math.min(coords.left + window.scrollX, window.innerWidth - 300)}px`;
    menu.style.top = `${coords.bottom + 4 + window.scrollY}px`;
  };

  function updateSelection() {
    items.forEach((it, i) => it.el.classList.toggle('selected', i === selected && it.label !== null));
  }

  const selectable = () => items.filter((it) => it.label !== null);

  return new Plugin({
    view: (view) => {
      const onBlur = () => close();
      const onScroll = () => {
        if (menu) close();
      };
      view.dom.addEventListener('blur', onBlur);
      document.getElementById('scroll')?.addEventListener('scroll', onScroll);
      return {
        update: (v) => render(v),
        destroy: () => {
          view.dom.removeEventListener('blur', onBlur);
          document.getElementById('scroll')?.removeEventListener('scroll', onScroll);
          close();
        },
      };
    },
    props: {
      handleKeyDown(view, e) {
        if (!menu || !active) return false;
        const sel = selectable();
        if (e.key === 'Escape') {
          close();
          return true;
        }
        if (e.key === 'ArrowDown' && sel.length) {
          selected = (selected + 1) % items.length;
          if (items[selected].label === null) selected = (selected + 1) % items.length;
          updateSelection();
          return true;
        }
        if (e.key === 'ArrowUp' && sel.length) {
          selected = (selected - 1 + items.length) % items.length;
          if (items[selected].label === null) selected = (selected - 1 + items.length) % items.length;
          updateSelection();
          return true;
        }
        if ((e.key === 'Enter' || e.key === 'Tab') && sel.length) {
          const pick = items[selected]?.label !== null ? items[selected] : sel[0];
          insert(view, pick.label, pick.kind);
          return true;
        }
        return false;
      },
    },
  });
}
