// The editorial comment's two file forms (docs/COMMENTS-AND-APPEARANCE-
// HANDOFF.md). One helper keeps the .typ and .md serializers and parsers
// symmetric: what one writes, the other reads back byte for byte.
//
// A comment is the one approved exception to "the page shows only printed
// content": it lives in the working file, shows on the page as a strip that
// is visibly not paper, and is absent from every rendered export (PDF, the
// audit's compile, semantic TeX).

/** Typst: a framed run of line comments. Every payload line is prefixed
 *  `// | `, so a payload holding a framing token cannot close the frame,
 *  and the whole frame is comment text to Typst whatever it holds. */
export const TYP_COMMENT_OPEN = '// plass:comment';
export const TYP_COMMENT_CLOSE = '// /plass:comment';
const TYP_LINE = '// | ';

export function commentToTyp(text: string): string {
  const lines = text === '' ? [] : text.split('\n');
  return [TYP_COMMENT_OPEN, ...lines.map((line) => TYP_LINE + line), TYP_COMMENT_CLOSE].join('\n');
}

/** Read the frame whose opener is `lines[i]`, or null when it is not one.
 *  Returns the payload and the index of the first line after the frame.
 *  Malformed frames keep every line visible: a line that is neither a
 *  payload line nor the closer ends the frame there and is parsed by the
 *  ordinary rules; an unterminated frame ends at the end of the file. */
export function readTypComment(lines: readonly string[], i: number): { text: string; next: number } | null {
  if (lines[i]?.trimEnd() !== TYP_COMMENT_OPEN) return null;
  const payload: string[] = [];
  let j = i + 1;
  for (; j < lines.length; j++) {
    const line = lines[j];
    if (line.trimEnd() === TYP_COMMENT_CLOSE) return { text: payload.join('\n'), next: j + 1 };
    if (line.startsWith(TYP_LINE)) payload.push(line.slice(TYP_LINE.length));
    // An editor that strips trailing whitespace turns an empty payload
    // line's `// | ` into `// |`.
    else if (line === TYP_LINE.trimEnd()) payload.push('');
    else break;
  }
  return { text: payload.join('\n'), next: j };
}

/** Markdown: a tagged HTML comment. The payload is escaped so no text can
 *  close the comment (`-->`) or read as markup: `&` → `&amp;` first, then
 *  every `--` → `-&#45;`, which leaves no `--` anywhere. Decoding runs the
 *  two in reverse; a literal `&#45;` in the payload survives because its
 *  ampersand was escaped before the hyphen pass could produce one. */
export const MD_COMMENT_OPEN = '<!-- plass:comment';
const MD_COMMENT_CLOSE = '-->';

function encodeMd(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/--/g, '-&#45;');
}

function decodeMd(text: string): string {
  return text.replace(/&#45;/g, '-').replace(/&amp;/g, '&');
}

export function commentToMd(text: string): string {
  return text === '' ? `${MD_COMMENT_OPEN}\n${MD_COMMENT_CLOSE}` : `${MD_COMMENT_OPEN}\n${encodeMd(text)}\n${MD_COMMENT_CLOSE}`;
}

/** The payload of a tagged HTML comment block (a markdown-it `html_block`
 *  token's content, trailing newline included), or null when the block is
 *  not exactly the frame — then it stays what it is today, a raw island. */
export function readMdComment(content: string): string | null {
  const m = /^<!-- plass:comment\n(?:([\s\S]*)\n)?-->\n?$/.exec(content);
  if (!m) return null;
  return decodeMd(m[1] ?? '');
}
