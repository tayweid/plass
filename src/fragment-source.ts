import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { schema } from './schema';
import { docToTyp } from './typ-serializer';

/** Serialize one document block for an auto-height fragment compile.
 * `pageSpec` may replace the default auto-height page declaration when a
 * caller needs an explicit page geometry. */
export function fragmentSource(view: EditorView, node: PMNode, widthPx: number, pageSpec?: string): string {
  const doc = schema.nodes.doc.create({ settings: view.state.doc.attrs.settings, bib: null }, [node]);
  let src = docToTyp(doc);
  src = src.replace(
    /#set page\((.*)\)/,
    pageSpec ?? `#set page(width: ${(widthPx * 0.75).toFixed(2)}pt, height: auto, margin: 0pt)`,
  );
  // Captioned tables are figures: preset the counter so "Table N" matches
  // this table's position in the document.
  if ((node.attrs.caption as string) || (node.attrs.label as string)) {
    let index = 0;
    let seen = 0;
    view.state.doc.descendants((n) => {
      if (n.type.name === 'table') {
        seen++;
        if (n === node) index = seen;
        return false;
      }
      return true;
    });
    src = src.replace(
      '\n\n#figure(',
      `\n\n#counter(figure.where(kind: table)).update(${Math.max(0, index - 1)})\n#figure(`,
    );
  }
  return src;
}
