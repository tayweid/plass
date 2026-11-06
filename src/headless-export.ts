// The export without the editor (Taylor, 2026-11-06, for the command line):
// a Markdown file read the way the app opens it, its values brought up to
// date from a values.json, and the Typst source the PDF export compiles.
// The command line (cli/plass.ts) spawns the typst binary on what this
// returns; the app's own export (pdf.ts) compiles the same `docToTyp` call
// in its worker. Nothing here touches the DOM.

import { EditorState } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from './schema';
import { mdToDoc, withSidecarBib } from './md-parser';
import { docToTyp } from './typ-serializer';
import { FONT_FALLBACK } from './typst-config';
import { lookupValue, refreshValues, valueNames } from './values';

export { valueNames };

export interface HeadlessOpen {
  doc: PMNode;
  /** The importer's warnings: shown, never fatal (the app shows them too). */
  warnings: string[];
}

/** A Markdown file as the app opens it. `readSidecar` reads a path beside
 *  the document (the front matter's `bibliography:` .bib); null when the
 *  file is not there. */
export function openMarkdown(text: string, readSidecar: (path: string) => string | null): HeadlessOpen {
  const read = mdToDoc(text);
  let doc = read.doc;
  const warnings = [...read.warnings];
  if (read.bibliography) {
    const bib = readSidecar(read.bibliography);
    if (bib === null) warnings.push(`bibliography: ${read.bibliography} was not found beside the document`);
    else doc = withSidecarBib(doc, bib).doc;
  }
  return { doc, warnings };
}

export interface ValuesApplied {
  doc: PMNode;
  /** Keys the document names that `data` has no scalar for. Their text is
   *  the last value the file holds (the page outlines them); the command
   *  line refuses to print them unless told to. */
  missing: string[];
}

/** Every value's text brought up to date from `data` (values.json's
 *  content), as the app does when the file changes. */
export function applyValues(doc: PMNode, data: unknown): ValuesApplied {
  const missing = valueNames(doc).filter((name) => lookupValue(data, name) === undefined);
  const state = EditorState.create({ doc, schema });
  const tr = refreshValues(state, data);
  return { doc: tr ? state.apply(tr).doc : doc, missing };
}

export class DataImageError extends Error {}

/** The Typst source the PDF export compiles: islands printed as code,
 *  comments left out, the bundled faces as fallbacks, as pdf.ts builds it.
 *  An image kept inside the document (a `data:` URL, which a saved file
 *  never holds: the app moves it to figures/ on save) has no file for the
 *  compiler, and is refused by name. The math converter must be loaded
 *  (`ensureMathConverter`) before this runs, or a formula is left out. */
export function exportSource(doc: PMNode): string {
  return docToTyp(doc, {
    islands: 'print',
    fontFallback: FONT_FALLBACK,
    resolveImage: (src) => {
      if (/^data:/i.test(src)) throw new DataImageError('an image is embedded in the document, not a file beside it: save the document in Plass first (it moves the image to figures/)');
      return src;
    },
  });
}
