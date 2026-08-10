// Hover controls for headings: a small pill in the left page margin beside
// the heading under the mouse — H1 · H2 · H3 · ¶ — one click changes the
// level or demotes back to a paragraph. Presentation-only chrome: it reads
// the document, dispatches one setBlockType transaction, and never touches
// the DOM the editor owns.

import type { EditorView } from 'prosemirror-view';
import { schema } from './schema';

export function installHeadingPill(view: EditorView) {
  const pill = document.createElement('div');
  pill.className = 'heading-pill';
  pill.hidden = true;
  document.body.appendChild(pill);

  let target: HTMLElement | null = null;
  let hideTimer = 0;

  const options: Array<{ label: string; title: string; level: number | null }> = [
    { label: 'H1', title: 'Heading 1 (⌘⌥1)', level: 1 },
    { label: 'H2', title: 'Heading 2 (⌘⌥2)', level: 2 },
    { label: 'H3', title: 'Heading 3 (⌘⌥3)', level: 3 },
    { label: '¶', title: 'Back to text (⌘⌥0)', level: null },
  ];
  for (const opt of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = opt.label;
    b.title = opt.title;
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      if (!target) return;
      const pos = view.posAtDOM(target, 0);
      if (pos < 0) return;
      const $pos = view.state.doc.resolve(pos);
      const node = $pos.parent;
      if (node.type !== schema.nodes.heading) return;
      const from = $pos.start();
      const tr = opt.level
        ? view.state.tr.setBlockType(from, from, schema.nodes.heading, { ...node.attrs, level: opt.level })
        : view.state.tr.setBlockType(from, from, schema.nodes.paragraph);
      view.dispatch(tr);
      hide();
      view.focus();
    });
    pill.appendChild(b);
  }

  const hide = () => {
    pill.hidden = true;
    target = null;
  };
  const scheduleHide = () => {
    clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      if (!pill.matches(':hover') && !(target && target.matches(':hover'))) hide();
    }, 250);
  };

  const showFor = (el: HTMLElement) => {
    clearTimeout(hideTimer);
    if (target === el && !pill.hidden) return;
    target = el;
    const pos = view.posAtDOM(el, 0);
    const level = pos >= 0 ? (view.state.doc.resolve(pos).parent.attrs.level as number) : 0;
    [...pill.children].forEach((b, i) => b.classList.toggle('heading-pill-on', i === level - 1));
    pill.hidden = false;
    const r = el.getBoundingClientRect();
    const pw = pill.offsetWidth;
    pill.style.left = `${Math.max(6, r.left - pw - 10)}px`;
    // Center on the first line of TEXT — the block rect starts above it
    // by the heading's padding-top.
    const cs = getComputedStyle(el);
    const padTop = parseFloat(cs.paddingTop) || 0;
    const line = parseFloat(cs.lineHeight) || r.height;
    pill.style.top = `${r.top + padTop + line / 2 - pill.offsetHeight / 2}px`;
  };

  view.dom.addEventListener('mouseover', (e) => {
    const h = (e.target as HTMLElement).closest?.('h1, h2, h3');
    if (h instanceof HTMLElement && view.dom.contains(h)) showFor(h);
    else if (target) scheduleHide();
  });
  view.dom.addEventListener('mouseleave', scheduleHide);
  pill.addEventListener('mouseleave', scheduleHide);
  pill.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  // Typing or scrolling repositions content under the pill: just hide.
  view.dom.addEventListener('keydown', hide);
  document.getElementById('scroll')?.addEventListener('scroll', hide, { passive: true });
}
