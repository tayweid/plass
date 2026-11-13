// A code block's language: what the fence's info string names, as the
// export tags the printed raw block and the page asks colors for. Pure
// (no DOM, no schema): the serializer, the page and the language field
// share it.

/** The two island tags (`code_block` `params`): kept verbatim, printed as
 *  plain code, never a language. */
export function isIslandParams(params: string): boolean {
  return params === 'typst-raw' || params === 'md-raw';
}

/** What a language tag may hold. Typst reads a raw block's tag up to the
 *  first whitespace or backtick; the field and the export allow less, the
 *  characters language names are written in (`c++`, `c#`, `objective-c`,
 *  `sublime-syntax`). */
const TAG = /^[A-Za-z0-9_+#.-]+$/;

/**
 * The language a fence's info string names, or '' when it names none.
 * Read as pandoc reads it (md-skeleton's `pmCodeClass`): a bare first
 * word (```` ```python ````, ```` ```python title="x" ````), else the
 * first class of an attribute block (```` ```{.python .numberLines} ````).
 * A raw fence (```` ```{=latex} ````) is a listing in no language, and an
 * island has none. Only this word reaches Typst: the rest of an info
 * string is the file's, and an info string with a space in it used to be
 * printed as the listing's first line.
 */
export function fenceLang(params: string): string {
  const info = params.trim();
  if (!info || isIslandParams(info)) return '';
  if (/^\{=[^\s{}]+\}$/.test(info)) return '';
  const m = /^([^\s{]*)\s*(?:\{([^{}]*)\})?/.exec(info)!;
  if (m[1]) return TAG.test(m[1]) ? m[1] : '';
  for (const token of (m[2] ?? '').match(/[^\s"=]+="[^"]*"|\S+/g) ?? []) {
    if (token.startsWith('.') && token.length > 1) return TAG.test(token.slice(1)) ? token.slice(1) : '';
  }
  return '';
}

/** What the language field writes for what was typed in it: the tag's own
 *  characters, nothing else (no space, brace or backtick can reach the
 *  fence), and never an island's tag. */
export function cleanLanguage(typed: string): string {
  const tag = typed.trim().replace(/[^A-Za-z0-9_+#.-]/g, '');
  return isIslandParams(tag) ? '' : tag;
}

/** A fence longer than any backtick run in `text` (three at least). */
function fenceFor(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return '`'.repeat(longest + 1);
}

/** A code block as Typst source: the raw block the export prints and the
 *  page's colors are asked for, so the two are the same block by
 *  construction. `lang` is `fenceLang`'s word ('' for none). */
export function rawBlockTyp(lang: string, text: string): string {
  const fence = fenceFor(text);
  return fence + lang + '\n' + text + '\n' + fence;
}

/** The languages the field offers, by the word Typst knows each by (its
 *  highlighter matches a syntax's name or a file extension, either case).
 *  A list to pick from, not a gate: any word may be typed, and one Typst
 *  does not know (Stata) is kept in the file and printed plain, on the
 *  page as in print. Every word here is colored by the pinned compiler
 *  (tests/code-colors.spec.ts asks it). */
export const CODE_LANGUAGES: ReadonlyArray<{ tag: string; name: string }> = [
  { tag: 'python', name: 'Python' },
  { tag: 'r', name: 'R' },
  { tag: 'julia', name: 'Julia' },
  { tag: 'matlab', name: 'MATLAB' },
  { tag: 'sql', name: 'SQL' },
  { tag: 'bash', name: 'Shell' },
  { tag: 'latex', name: 'LaTeX' },
  { tag: 'bibtex', name: 'BibTeX' },
  { tag: 'markdown', name: 'Markdown' },
  { tag: 'typ', name: 'Typst' },
  { tag: 'json', name: 'JSON' },
  { tag: 'yaml', name: 'YAML' },
  { tag: 'toml', name: 'TOML' },
  { tag: 'csv', name: 'CSV' },
  { tag: 'xml', name: 'XML' },
  { tag: 'html', name: 'HTML' },
  { tag: 'css', name: 'CSS' },
  { tag: 'javascript', name: 'JavaScript' },
  { tag: 'typescript', name: 'TypeScript' },
  { tag: 'c', name: 'C' },
  { tag: 'cpp', name: 'C++' },
  { tag: 'cs', name: 'C#' },
  { tag: 'java', name: 'Java' },
  { tag: 'rust', name: 'Rust' },
  { tag: 'go', name: 'Go' },
  { tag: 'swift', name: 'Swift' },
  { tag: 'kotlin', name: 'Kotlin' },
  { tag: 'scala', name: 'Scala' },
  { tag: 'haskell', name: 'Haskell' },
  { tag: 'ocaml', name: 'OCaml' },
  { tag: 'ruby', name: 'Ruby' },
  { tag: 'php', name: 'PHP' },
  { tag: 'perl', name: 'Perl' },
  { tag: 'lua', name: 'Lua' },
  { tag: 'f90', name: 'Fortran' },
  { tag: 'makefile', name: 'Makefile' },
  { tag: 'dockerfile', name: 'Dockerfile' },
  { tag: 'diff', name: 'Diff' },
];
