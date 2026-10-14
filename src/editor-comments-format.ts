// The editorial comment's two file forms (docs/COMMENTS-AND-APPEARANCE-
// HANDOFF.md). One helper keeps the .typ and .md serializers and parsers
// symmetric: what one writes, the other reads back exactly.
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

/** Markdown: every HTML comment is an editorial comment
 *  (docs/MARKDOWN-FORMAT.md, Comments). The payload is written verbatim —
 *  `--`, `&` and quotes included, as pandoc keeps them — except `-->`,
 *  which would close the comment and is written `--&gt;` (decoded on
 *  read). A one-line payload with no space at either end is written
 *  `<!-- text -->`; anything else (several lines, an empty payload, edge
 *  whitespace) as a frame with the payload on its own lines, so it comes
 *  back exactly. */
export function commentToMd(text: string): string {
  const body = text.replace(/-->/g, '--&gt;');
  return text !== '' && !text.includes('\n') && text === text.trim() ? `<!-- ${body} -->` : `<!--\n${body}\n-->`;
}

/** The tagged frame Plass wrote before every comment was one. Still read,
 *  with its old escapes (`&amp;`, `-&#45;`) decoded; never written. */
const TAGGED_MD = /^<!-- plass:comment\n(?:([\s\S]*)\n)?-->$/;

/** One comment's payload, from its source `<!--…-->`. The frame form
 *  (`<!--\n…\n-->`) keeps the payload between the two line breaks exactly;
 *  the inline form is trimmed. */
function mdPayload(raw: string): string {
  const tagged = TAGGED_MD.exec(raw);
  if (tagged) return (tagged[1] ?? '').replace(/&#45;/g, '-').replace(/&amp;/g, '&');
  const inner = raw.slice(4, -3);
  const body = inner.length >= 2 && inner.startsWith('\n') && inner.endsWith('\n') ? inner.slice(1, -1) : inner.trim();
  return body.replace(/--&gt;/g, '-->');
}

/** The comments a Markdown HTML block opens with (a markdown-it
 *  `html_block` token's content), and the text after the last one on its
 *  line, which pandoc reads as a paragraph: `<!-- a --> <!-- b --> text`
 *  is two comments and "text". Null when the block does not start with a
 *  comment. */
export function readMdComments(content: string): { comments: string[]; rest: string } | null {
  let s = content.replace(/^[ \t]{0,3}/, '');
  if (!s.startsWith('<!--')) return null;
  const comments: string[] = [];
  while (s.startsWith('<!--')) {
    const end = s.indexOf('-->', 4);
    if (end < 0) return null;
    comments.push(mdPayload(s.slice(0, end + 3)));
    s = s.slice(end + 3).replace(/^[ \t]+/, '');
  }
  return { comments, rest: s.trim() };
}

/** The payload of `content` when it is exactly one HTML comment (a block
 *  or an inline `<!--…-->`), or null. */
export function readMdComment(content: string): string | null {
  const read = readMdComments(content);
  return read && read.comments.length === 1 && !read.rest ? read.comments[0] : null;
}
