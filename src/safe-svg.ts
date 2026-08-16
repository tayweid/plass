// Typst renders user-controlled document content to SVG. Treat that SVG as
// untrusted markup: bibliography URLs, imported SVGs, and future compiler
// changes must never acquire browser privileges merely because Typst emitted
// them. Every compiler-SVG DOM sink goes through this module.

import DOMPurify from 'dompurify';

const ACTIVE_ELEMENTS = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed']);
const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp);base64,/i;

function safeCss(value: string): boolean {
  // Local paint-server references (gradients, masks, clips) are intrinsic to
  // normal SVG. Any other CSS url() can load a resource and is not needed by
  // Typst's renderer.
  if (/@import\b|expression\s*\(|-moz-binding\b/i.test(value)) return false;
  for (const match of value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    if (!match[2].startsWith('#')) return false;
  }
  return true;
}

function safeReference(el: Element, value: string): boolean {
  const ref = value.trim();
  if (ref.startsWith('#')) return true;
  if (el.localName === 'image') return SAFE_DATA_IMAGE.test(ref);
  if (el.localName !== 'a') return false;
  try {
    return LINK_PROTOCOLS.has(new URL(ref, location.href).protocol);
  } catch {
    return false;
  }
}

/**
 * Parse and sanitize Typst-produced SVG into an inert fragment. DOMPurify is
 * the first boundary; the second pass enforces Plass-specific URL and CSS
 * rules and intentionally distrusts even event attributes emitted by the
 * renderer itself.
 */
export function sanitizedTypstSvg(svg: string): DocumentFragment {
  const fragment = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: [...ACTIVE_ELEMENTS],
    // Typst outlines glyphs once and paints them with <use href="#…">.
    // DOMPurify excludes <use> by default because it can load externally;
    // our second pass permits fragment-only references and strips the rest.
    ADD_TAGS: ['use'],
    ADD_ATTR: ['href', 'xlink:href', 'target', 'rel', 'referrerpolicy'],
  }) as DocumentFragment;

  for (const el of [...fragment.querySelectorAll('*')]) {
    if (ACTIVE_ELEMENTS.has(el.localName)) {
      el.remove();
      continue;
    }
    for (const name of el.getAttributeNames()) {
      const lower = name.toLowerCase();
      const value = el.getAttribute(name) ?? '';
      if (lower.startsWith('on')) {
        el.removeAttribute(name);
      } else if (lower === 'href' || lower === 'xlink:href' || lower === 'src') {
        if (!safeReference(el, value)) el.removeAttribute(name);
      } else if (lower === 'style' && !safeCss(value)) {
        el.removeAttribute(name);
      }
    }
    if (el.localName === 'a' && (el.hasAttribute('href') || el.hasAttribute('xlink:href'))) {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
      el.setAttribute('referrerpolicy', 'no-referrer');
    }
    if (el.localName === 'style' && !safeCss(el.textContent ?? '')) el.remove();
  }
  return fragment;
}

/** Replace a target's children with sanitized Typst SVG. */
export function mountTypstSvg(target: Element, svg: string): SVGSVGElement | null {
  target.replaceChildren(sanitizedTypstSvg(svg));
  return target.querySelector('svg');
}

/** Create a detached container for layout/text extraction. */
export function parseTypstSvg(svg: string): HTMLDivElement {
  const div = document.createElement('div');
  mountTypstSvg(div, svg);
  return div;
}
