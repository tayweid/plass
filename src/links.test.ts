// Links (Taylor, 2026-11-09: blue and clickable everywhere). The bare URL
// the page draws and a ⌘-click opens is the one the print links (urls.ts,
// the scan typ-serializer's `escapePieces` runs); only web and mail
// addresses open from the page; the print links a Markdown link, in a
// paragraph and in a table cell, with one show rule making web links blue
// and underlined, and a legacy .typ save reads its links back; the TeX
// export writes each link as an \\href hyperref colors.
// Run: npx tsx src/links.test.ts
import { mdToDoc } from './md-parser';
import { docToTex } from './tex-serializer';
import { typToDoc } from './typ-parser';
import { docToTyp } from './typ-serializer';
import { bareUrlAt, bareUrls, opensFromPage } from './urls';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok ' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`);
  if (!ok) failures++;
}

const url = (text: string, index: number) => bareUrlAt(text, index)?.url ?? null;

const s = 'See https://example.com/page, then (https://a.org/x_(y)) and http://b.net.';
check('a character inside the URL finds it', url(s, s.indexOf('example')) === 'https://example.com/page', String(url(s, s.indexOf('example'))));
check('the scheme is part of it', url(s, s.indexOf('https')) === 'https://example.com/page');
check('trailing punctuation is the sentence’s', url(s, s.indexOf('page,') + 4) === null);
check('words around it are not a link', url(s, 1) === null && url(s, s.indexOf('then')) === null);
check('balanced brackets stay in, the closing one does not', url(s, s.indexOf('a.org')) === 'https://a.org/x_(y)', String(url(s, s.indexOf('a.org'))));
check('a later URL is found past an earlier one', url(s, s.indexOf('b.net')) === 'http://b.net');
check('a scheme with nothing after it is no link', url('go to https:// now', 7) === null);
check('mid-word, as Typst links it', url('xhttps://c.io', 3) === 'https://c.io');
const hit = bareUrlAt(s, s.indexOf('example'));
check('its range is the URL’s', hit !== null && s.slice(hit.from, hit.to) === hit.url);

check('web and mail open', opensFromPage('https://x.org') && opensFromPage('HTTP://x.org') && opensFromPage('mailto:a@b.c'));
check('a path, an anchor or another scheme does not', !opensFromPage('notes.md') && !opensFromPage('#intro') && !opensFromPage('file:///etc/passwd') && !opensFromPage('javascript:alert(1)'));
check('every bare URL in order', bareUrls('a https://x.io b http://y.io/z.').map((u) => u.url).join(' ') === 'https://x.io http://y.io/z');

// Print.
const MD = `A [link to **the** docs](https://typst.app/docs) and https://example.com/a_b here.

| Site | Address |
|---|---|
| [Typst](https://typst.app) | https://example.org/x |

: Sites https://cap.org/z
`;
const docOf = (r: unknown) => ((r as { doc?: unknown }).doc ?? r) as Parameters<typeof docToTyp>[0];
const doc = docOf(mdToDoc(MD));
const print = docToTyp(doc, { islands: 'print' });
check('one show rule colors and underlines web links', /^#show link: it => if type\(it\.dest\) == str \{ underline\(text\(fill: rgb\("#0000ee"\), it\)\) \} else \{ it \}$/m.test(print));
check('a Markdown link prints as #link over its text, marks inside', print.includes('A #link("https://typst.app/docs")[link to *the* docs] and https://example.com/a_b here.'));
check('a table cell links both kinds', print.includes('[#link("https://typst.app")[Typst]], [https://example.org/x]'), print.split('\n').filter((l) => l.includes('typst.app')).join(' | '));
check('a table caption links its URL', print.includes('caption: [Sites https://cap.org/z]'));
const marked = (d: ReturnType<typeof docOf>) => {
  const out: string[] = [];
  d.descendants((n) => {
    const l = n.marks.find((m) => m.type.name === 'link');
    if (l && n.text) out.push(`${n.text}>${l.attrs.href}`);
    return true;
  });
  return out.join(' ');
};
const back = docOf(typToDoc(docToTyp(doc)));
check('a legacy .typ save reads its links back', marked(back) === marked(doc), `${marked(back)} vs ${marked(doc)}`);
check('…and its header line is not content', !back.textContent.includes('show link'));
const quoted = docOf(mdToDoc('[q](https://x.org/a"b\\\\c)\n'));
check('an address with a quote or backslash survives #link', marked(docOf(typToDoc(docToTyp(quoted)))) === marked(quoted), marked(quoted));

for (const md of ['[q](https://x.org) opens it\n', '[red]{.red} opens it\n', '~~gone~~ opens it\n']) {
  const read = docOf(typToDoc(docToTyp(docOf(mdToDoc(md)))));
  check(`a paragraph opening with ${md.trim().split(' ')[0]} reads back as prose from a .typ save`, read.lastChild?.type.name === 'paragraph', read.lastChild?.type.name);
}

// TeX.
const tex = docToTex(docOf(mdToDoc('A [l](https://x.org/a?b=1&c=2#d) and https://y.org/50%_off~x, `https://code.org`.\n')));
check('hyperref colors web links the link blue', tex.includes('\\definecolor{plasslink}{HTML}{0000EE}') && tex.includes('urlcolor=plasslink'));
check('a Markdown link is an \\href', tex.includes('\\href{https://x.org/a?b=1\\&c=2\\#d}{l}'), tex);
check('a bare URL is an \\href showing itself', tex.includes('\\href{https://y.org/50\\%_off\\%7Ex}{https://y.org/50\\%\\_off\\textasciitilde{}x}'));
check('a URL in code stays text', tex.includes('\\texttt{https://code.org}'));
check('no links, no hyperref', !docToTex(docOf(mdToDoc('Plain.\n'))).includes('hyperref'));

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall link checks passed');
