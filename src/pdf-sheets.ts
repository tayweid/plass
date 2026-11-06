// Sheets of a PDF Typst wrote, without the compiler (Taylor, 2026-10-21):
// its page count, and the two-up source that puts two pages to a sheet.
// Node-safe (the command line, cli/plass.ts, compiles the two-up source
// with the typst binary); pdf.ts compiles it in the app's worker.

/** The page count of a PDF Typst wrote: its page tree's `/Count` (an
 *  outline's `/Count` is in a dictionary of another type), else its page
 *  objects (`/Type /Page`, which a PDF placed as an image would add to).
 *  Null when neither is readable (pages packed in an object stream). */
export function pdfPageCount(data: Uint8Array): number | null {
  // Latin-1: one character per byte, so the binary streams stay inert.
  let text = '';
  for (let i = 0; i < data.length; i += 0x8000) text += String.fromCharCode(...data.subarray(i, i + 0x8000));
  const tree = /\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/.exec(text);
  const count = tree ? Number(tree[1] ?? tree[2]) : 0;
  if (count > 0) return count;
  const pages = text.match(/\/Type\s*\/Page(?![s\w])/g)?.length ?? 0;
  return pages || null;
}

/** Two pages to a sheet (Taylor, 2026-10-21: half-sheets side by side on
 *  landscape Letter): the document's PDF placed, page by page, on sheets
 *  twice its page's width, page 1 left and page 2 right, at full size.
 *  Half Letter goes on landscape Letter, A5 on landscape A4. Typst 0.14
 *  places a PDF's pages as images, so the pages keep their vector text. */
export function twoUpSource(path: string, pages: number, widthIn: number, heightIn: number): string {
  const w = `${+widthIn.toFixed(4)}in`;
  return [
    `#set page(width: ${+(2 * widthIn).toFixed(4)}in, height: ${+heightIn.toFixed(4)}in, margin: 0pt)`,
    `#for i in range(0, ${pages}, step: 2) {`,
    `  place(top + left, image(${JSON.stringify(path)}, page: i + 1, width: ${w}))`,
    `  if i + 1 < ${pages} { place(top + left, dx: ${w}, image(${JSON.stringify(path)}, page: i + 2, width: ${w})) }`,
    `  if i + 2 < ${pages} { pagebreak() }`,
    '}',
    '',
  ].join('\n');
}
