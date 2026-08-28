import { DOMSerializer, type Node as PMNode } from 'prosemirror-model';
import { mountTypstSvg } from './safe-svg';
import './proof-view.css';

let activeProof: HTMLElement | null = null;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const PROOF_PAGE_GAP_PT = 18;

export interface ProofViewOptions {
  documentName?: string;
  onMessage?: (message: string) => void;
}

/** Whether an exact, read-only Typst proof is currently covering the editor. */
export function proofViewOpen(): boolean {
  return activeProof !== null;
}

/** The exact proof is painted as sanitized glyph outlines, so its SVG is not
 * itself a semantic document. Keep one offscreen DOM serialization inside the
 * modal before the editor is made inert. Headings, lists, tables, code, and
 * ordinary inline marks retain their native structure; generated/atomic nodes
 * receive concise source-facing text so the proof never becomes a blank dialog
 * to assistive technology. */
function semanticProofTranscript(doc: PMNode): HTMLElement {
  const transcript = document.createElement('article');
  transcript.className = 'typst-proof-transcript';
  transcript.setAttribute('role', 'document');
  transcript.setAttribute('aria-label', 'Current document');
  transcript.appendChild(
    DOMSerializer.fromSchema(doc.type.schema).serializeFragment(doc.content, { document }),
  );

  transcript.querySelectorAll<HTMLElement>('[data-cite]').forEach((element) => {
    element.textContent = `Citation @${element.dataset.cite ?? ''}`;
  });
  transcript.querySelectorAll<HTMLElement>('[data-eq-ref]').forEach((element) => {
    element.textContent = `Reference @${element.dataset.eqRef ?? ''}`;
  });
  transcript.querySelectorAll<HTMLElement>('[data-page-break]').forEach((element) => {
    element.textContent = 'Page break';
  });
  transcript.querySelectorAll<HTMLElement>('[data-numbering-restart]').forEach((element) => {
    element.textContent = 'Page numbering restarts';
  });
  transcript.querySelectorAll<HTMLElement>('[data-bibliography]').forEach((element) => {
    element.textContent = 'References';
  });
  transcript.querySelectorAll<HTMLElement>('[data-typst-preview]').forEach((element) => element.remove());

  const tables = Array.from(transcript.querySelectorAll('table'));
  let tableIndex = 0;
  let tableNumber = 0;
  doc.descendants((node) => {
    if (node.type.spec.tableRole !== 'table') return true;
    const table = tables[tableIndex++];
    const caption = String(node.attrs.caption ?? '');
    const label = String(node.attrs.label ?? '');
    if (table && (caption || label)) {
      tableNumber++;
      const semanticCaption = document.createElement('caption');
      semanticCaption.textContent = caption ? `Table ${tableNumber}: ${caption}` : `Table ${tableNumber}`;
      table.prepend(semanticCaption);
    }
    return false;
  });
  return transcript;
}

/** Typst emits a multi-page proof as one SVG whose page groups are stacked
 * without space. Add presentation-only offsets between those groups: content
 * coordinates inside each physical page remain byte-for-byte untouched. */
function separateProofPages(svg: SVGSVGElement): number {
  const pages = Array.from(svg.querySelectorAll<SVGGElement>('.typst-page'));
  if (pages.length === 0) return 1;

  const viewBox = (svg.getAttribute('viewBox') ?? '')
    .trim()
    .split(/[ ,]+/)
    .map(Number);
  const hasViewBox = viewBox.length === 4 && viewBox.every(Number.isFinite);
  const pageWidth = hasViewBox
    ? viewBox[2]
    : Number.parseFloat(svg.getAttribute('width') ?? '');
  const originalHeight = hasViewBox
    ? viewBox[3]
    : Number.parseFloat(svg.getAttribute('height') ?? '');
  const pageY = pages.map((page, index) => {
    const transform = page.getAttribute('transform') ?? '';
    const match = /translate\(\s*[-+\d.e]+(?:\s*,\s*|\s+)([-+\d.e]+)\s*\)/i.exec(transform);
    const value = match ? Number.parseFloat(match[1]) : Number.NaN;
    return Number.isFinite(value) ? value : index * (originalHeight / pages.length);
  });

  pages.forEach((page, index) => {
    const offset = document.createElementNS(SVG_NAMESPACE, 'g');
    offset.classList.add('typst-proof-page-offset');
    offset.setAttribute('transform', `translate(0 ${index * PROOF_PAGE_GAP_PT})`);
    page.before(offset);
    if (Number.isFinite(pageWidth) && pageWidth > 0 && Number.isFinite(originalHeight)) {
      const nextY = pageY[index + 1] ?? originalHeight;
      const height = nextY - pageY[index];
      if (height > 0) {
        const paper = document.createElementNS(SVG_NAMESPACE, 'rect');
        paper.classList.add('typst-proof-paper');
        paper.setAttribute('x', String(hasViewBox ? viewBox[0] : 0));
        paper.setAttribute('y', String(pageY[index]));
        paper.setAttribute('width', String(pageWidth));
        paper.setAttribute('height', String(height));
        paper.setAttribute('aria-hidden', 'true');
        offset.appendChild(paper);
      }
    }
    offset.appendChild(page);
  });

  const addedHeight = (pages.length - 1) * PROOF_PAGE_GAP_PT;
  const height = Number.parseFloat(svg.getAttribute('height') ?? '');
  if (Number.isFinite(height) && height > 0) {
    svg.setAttribute('height', String(height + addedHeight));
  }
  if (hasViewBox) {
    viewBox[3] += addedHeight;
    svg.setAttribute('viewBox', viewBox.join(' '));
  }
  svg.dataset.proofPages = String(pages.length);
  svg.dataset.proofPageGapPt = String(PROOF_PAGE_GAP_PT);
  return pages.length;
}

/**
 * Open a deliberate proof surface rendered directly by Typst. Unlike the
 * editable DOM projection, this contains no browser or ported layout choices:
 * it uses the same serializer, assets, fonts, and compiler as PDF export.
 */
export async function openProofView(doc: PMNode, options: ProofViewOptions = {}): Promise<void> {
  closeProofView();

  const overlay = document.createElement('section');
  overlay.className = 'typst-proof';
  overlay.dataset.state = 'loading';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Exact Typst proof');
  overlay.innerHTML = `
    <header class="typst-proof-bar">
      <span class="typst-proof-title">Exact Typst proof</span>
      <span class="typst-proof-status" role="status">Typesetting the current revision…</span>
      <button class="typst-proof-close" type="button">Back to editing</button>
    </header>
    <div class="typst-proof-scroll">
      <div class="typst-proof-document" aria-hidden="true">
        <div class="typst-proof-state">Preparing the same Typst document used by PDF export…</div>
      </div>
    </div>`;
  overlay.appendChild(semanticProofTranscript(doc));
  document.body.appendChild(overlay);
  activeProof = overlay;

  // aria-modal communicates the relationship to assistive technology; inert
  // also enforces it for pointer, focus, and accessibility-tree traversal.
  const background = Array.from(document.body.children)
    .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== overlay)
    .map((element) => ({ element, wasInert: element.inert }));
  for (const { element } of background) element.inert = true;

  const closeButton = overlay.querySelector<HTMLButtonElement>('.typst-proof-close')!;
  const status = overlay.querySelector<HTMLElement>('.typst-proof-status')!;
  const target = overlay.querySelector<HTMLElement>('.typst-proof-document')!;
  const priorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const compileAbort = new AbortController();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    if (activeProof === overlay) activeProof = null;
    for (const { element, wasInert } of background) element.inert = wasInert;
    // This only prevents not-yet-admitted asset preparation from submitting
    // work. A proof already in the final lane remains protected to completion.
    compileAbort.abort();
    document.removeEventListener('keydown', onKeyDown, true);
    priorFocus?.focus();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Tab') {
      // The proof has one deliberate action. Keep keyboard focus inside the
      // modal instead of allowing it to fall through to the covered editor.
      event.preventDefault();
      closeButton.focus();
    }
  };
  closeButton.addEventListener('click', close);
  document.addEventListener('keydown', onKeyDown, true);
  closeButton.focus();

  try {
    const { compileDocProofSvg } = await import('./pdf');
    if (closed) return;
    const svg = await compileDocProofSvg(doc, (message) => {
      if (!closed) status.textContent = message;
    }, compileAbort.signal);
    if (closed) return;
    if (!svg) throw new Error('Typst did not produce a proof');

    const svgElement = mountTypstSvg(target, svg);
    if (!svgElement) throw new Error('Typst produced an unreadable proof');
    const pages = separateProofPages(svgElement);
    // Typst SVG lengths are points. CSS pixels use 96 dpi, so render the
    // proof at physical page scale while preserving every internal coordinate.
    const widthPt = Number.parseFloat(svgElement.getAttribute('width') ?? '');
    if (Number.isFinite(widthPt) && widthPt > 0) {
      svgElement.style.width = `${(widthPt * 4 / 3).toFixed(2)}px`;
    }
    overlay.dataset.state = 'ready';
    status.textContent = `${options.documentName ?? 'Current document'} · ${pages} ${pages === 1 ? 'page' : 'pages'} · exact Typst output`;
    options.onMessage?.(`Exact proof ready — ${pages} ${pages === 1 ? 'page' : 'pages'}`);
  } catch (error) {
    if (closed) return;
    const message = error instanceof Error ? error.message : String(error);
    overlay.dataset.state = 'error';
    target.innerHTML = `<div class="typst-proof-state"></div>`;
    target.querySelector('.typst-proof-state')!.textContent = `Could not typeset this proof. ${message}`;
    status.textContent = 'Proof failed';
    options.onMessage?.(`Exact proof failed: ${message}`);
  }
}

export function closeProofView(): void {
  const close = activeProof?.querySelector<HTMLButtonElement>('.typst-proof-close');
  close?.click();
}

import.meta.hot?.dispose(closeProofView);
