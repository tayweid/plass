import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { expect, test, type Page } from 'playwright/test';

// The port audit: Plass has one renderer (the ported line breaker and the
// local paginator); Typst is the printer. This spec is how the two are kept
// honest. It opens each document through the app's own file manager, lets
// the editor lay it out, compiles it once with Typst, and reports every
// block whose line breaks differ and the first page start that differs.
//
//   npm run audit                      the built-in fixtures, strict
//   AUDIT=<file-or-folder> npm run audit   your own documents, report only
//
// Nothing here runs in the edit loop: the editor never compiles.

interface PortAuditReport {
  compileMs: number;
  analyzeMs: number;
  typst: { status: 'ok' | 'fail'; reason?: string; pageCount: number };
  chrome: Array<{ page: number; typst: string[]; editor: string[] }>;
  pages: {
    local: Array<{ pos: number; line: number; unit: string }>;
    typst: Array<{ pos: number; line: number; unit: string }>;
    localCount: number;
    agree: boolean;
    firstDiff: { firstDiffPage: number; cause: string; localStart: unknown; exactStart: unknown } | null;
  };
  blocks: Array<{ pos: number; type: string; text: string; status: string; port?: string; typst?: string; authority?: string | null; reason?: string }>;
  summary: { blocks: number; match: number; mismatch: number; typstFail: number; noPort: number; browserMismatch: number; pagesAgree: boolean; chromeMismatch: number };
}

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __fm: { loadHandle: (h: FileSystemFileHandle) => Promise<unknown> };
    __pagCount: () => number;
    __blockAuthority: (pos: number) => { authority: string | null } | null;
    __audit: () => Promise<PortAuditReport | null>;
  }
}

const FILLER =
  'The Knuth Plass algorithm evaluates a complete paragraph and preserves globally optimal line endings while editing without visible jitter. ';

/** Built-in fixtures: the rails, each in enough volume to paginate. */
const FIXTURES: Array<{ name: string; text: string }> = [
  {
    name: 'prose.md',
    text: ['# Prose', '', ...Array.from({ length: 14 }, (_, i) => FILLER.repeat(3 + (i % 4)).trimEnd() + '\n')].join('\n'),
  },
  {
    name: 'structure.md',
    text: [
      '# Structure',
      '',
      FILLER.repeat(4).trimEnd(),
      '',
      '## Lists',
      '',
      '- ' + FILLER.repeat(2).trimEnd(),
      '- ' + FILLER.repeat(1).trimEnd(),
      '- ' + FILLER.repeat(3).trimEnd(),
      '',
      '1. ' + FILLER.repeat(2).trimEnd(),
      '2. ' + FILLER.repeat(2).trimEnd(),
      '',
      '> ' + FILLER.repeat(3).trimEnd(),
      '',
      ...Array.from({ length: 8 }, () => FILLER.repeat(4).trimEnd() + '\n'),
      '### Math and notes',
      '',
      'Inline math $x^2 + y^2 = z^2$ sits in the run.[^1] ' + FILLER.repeat(3).trimEnd(),
      '',
      '$$ \\int_0^1 f(x) \\, dx = F(1) - F(0) $$',
      '',
      ...Array.from({ length: 6 }, () => FILLER.repeat(5).trimEnd() + '\n'),
      '[^1]: A footnote with a little body text of its own.',
    ].join('\n'),
  },
];

const TABLE_ROWS = 45;
FIXTURES.push(
  {
    name: 'lists.md',
    text: [
      '# Lists',
      '',
      FILLER.repeat(2).trimEnd(),
      '',
      ...Array.from({ length: 4 }, (_, i) => '- ' + FILLER.repeat(2 + (i % 3)).trimEnd()),
      '  - Nested ' + FILLER.repeat(2).trimEnd(),
      '    - Third level ' + FILLER.repeat(2).trimEnd(),
      '',
      ...Array.from({ length: 12 }, (_, i) => `${i + 1}. Item ${i + 1}: ` + FILLER.repeat(1 + (i % 2)).trimEnd()),
      '',
      ...Array.from({ length: 6 }, () => FILLER.repeat(4).trimEnd() + '\n'),
    ].join('\n'),
  },
  {
    name: 'footnotes.md',
    text: [
      '# Footnotes',
      '',
      ...Array.from({ length: 12 }, (_, i) => FILLER.repeat(3).trimEnd() + ` A remark.[^${i + 1}] ` + FILLER.repeat(2).trimEnd() + '\n'),
      ...Array.from({ length: 12 }, (_, i) => `[^${i + 1}]: Footnote ${i + 1}. ` + FILLER.repeat(i % 2 ? 2 : 1).trimEnd()),
    ].join('\n'),
  },
  {
    name: 'math.md',
    text: [
      '# Math',
      '',
      ...Array.from({ length: 10 }, (_, i) => `Inline math $x^${i} + y^2 = z^2$ sits in the run. ` + FILLER.repeat(3).trimEnd() + ` Then $\\alpha_${i}$ again. ` + FILLER.repeat(2).trimEnd() + '\n'),
      '$$ \\int_0^1 f(x) \\, dx = F(1) - F(0) $$',
      '',
      ...Array.from({ length: 6 }, () => FILLER.repeat(4).trimEnd() + '\n'),
    ].join('\n'),
  },
  {
    name: 'table.md',
    text: [
      '# A long table',
      '',
      'An introductory paragraph sits above the table.',
      '',
      '| Item | Value |',
      '| --- | --- |',
      ...Array.from({ length: TABLE_ROWS - 1 }, (_, i) => `| Row ${i + 1} | ${i + 1} |`),
      '',
      'A closing paragraph follows the table. ' + FILLER.repeat(3).trimEnd(),
      '',
    ].join('\n'),
  },
);

FIXTURES.push({
  // Item pitch: tight lists, loose lists (blank lines between items), an
  // item holding two paragraphs, a loose list nested in a tight one.
  name: 'lists-loose.md',
  text: [
    '# Pitch',
    '',
    FILLER.repeat(2).trimEnd(),
    '',
    ...Array.from({ length: 3 }, (_, i) => '- ' + FILLER.repeat(1 + (i % 2)).trimEnd()),
    '',
    FILLER.repeat(1).trimEnd(),
    '',
    ...Array.from({ length: 3 }, (_, i) => '- ' + FILLER.repeat(1 + (i % 2)).trimEnd() + '\n'),
    FILLER.repeat(1).trimEnd(),
    '',
    ...Array.from({ length: 3 }, (_, i) => `${i + 1}. ` + FILLER.repeat(1 + (i % 2)).trimEnd() + '\n'),
    FILLER.repeat(1).trimEnd(),
    '',
    '- ' + FILLER.repeat(1).trimEnd(),
    '',
    '  ' + FILLER.repeat(1).trimEnd(),
    '',
    '- ' + FILLER.repeat(1).trimEnd(),
    '',
    FILLER.repeat(1).trimEnd(),
    '',
    '- ' + FILLER.repeat(1).trimEnd(),
    '  - ' + FILLER.repeat(1).trimEnd(),
    '',
    '  - ' + FILLER.repeat(1).trimEnd(),
    '- ' + FILLER.repeat(1).trimEnd(),
    '',
    ...Array.from({ length: 4 }, () => FILLER.repeat(3).trimEnd() + '\n'),
    ...Array.from({ length: 6 }, (_, i) => '- ' + FILLER.repeat(2 + (i % 3)).trimEnd() + '\n'),
    FILLER.repeat(3).trimEnd(),
    '',
  ].join('\n'),
});

FIXTURES.push({
  name: 'headings.md',
  text: [
    '# A first-level heading long enough to wrap onto a second line of the page at the default size',
    '',
    FILLER.repeat(2).trimEnd(),
    '',
    '## A second-level heading that also runs long enough to need a second line, and perhaps a third one too',
    '',
    FILLER.repeat(2).trimEnd(),
    '',
    '### Third level: the algorithm evaluates a complete paragraph and preserves globally optimal line endings',
    '',
    FILLER.repeat(3).trimEnd(),
    '',
    '## Hyphenation candidates: extraordinarily uncharacteristically straightforward internationalization',
    '',
    FILLER.repeat(2).trimEnd(),
    '',
  ].join('\n'),
});
const TYP_HEAD = (page: string, extra = '') =>
  `#set page(${page})\n#set par(justify: true, leading: 10.215pt, spacing: 21.465pt)\n#set list(spacing: 13.34pt)\n#set enum(spacing: 13.34pt)\n${extra}#set text(font: "New Computer Modern", size: 12.5pt)\n\n`;
const NOTES = Array.from({ length: 8 }, (_, i) => FILLER.repeat(3).trimEnd() + ` A remark.#footnote[Note ${i + 1}. ${FILLER.repeat(i % 2 ? 2 : 1).trimEnd()}] ` + FILLER.repeat(2).trimEnd()).join('\n\n');
FIXTURES.push(
  {
    // Half letter (notes printed two to a sheet): a custom size whose margins
    // are not whole pixels, lists at a knife-edge measure, a list item at a
    // page top.
    name: 'half-letter.typ',
    text:
      TYP_HEAD('width: 5.5in, height: 8.5in, margin: 0.6in') +
      '= Half sheets\n\n' +
      Array.from({ length: 14 }, () => FILLER.repeat(3).trimEnd()).join('\n\n') +
      `\n\n- ${FILLER.repeat(2).trimEnd()}\n- ${FILLER.repeat(1).trimEnd()}\n\n` +
      Array.from({ length: 6 }, () => FILLER.repeat(4).trimEnd()).join('\n\n') +
      '\n',
  },
  {
    // Footnote numbering by letters and no separator rule.
    name: 'footnotes-a.typ',
    text: TYP_HEAD('paper: "us-letter", margin: 1.25in', '#set footnote(numbering: "a")\n#set footnote.entry(separator: none)\n') + '= Notes\n\n' + NOTES + '\n',
  },
  {
    // Symbol markers and a full-width rule.
    name: 'footnotes-symbols.typ',
    text: TYP_HEAD('paper: "us-letter", margin: 1.25in', '#set footnote(numbering: "*")\n#set footnote.entry(separator: line(length: 100%, stroke: 0.5pt))\n') + '= Notes\n\n' + NOTES + '\n',
  },
);

FIXTURES.push(
  {
    // Page chrome: a running header with the section in force and the page
    // number in the document's format, a running footer (which replaces
    // the automatic number), neither on page 1.
    name: 'chrome.typ',
    text:
      TYP_HEAD(
        'paper: "us-letter", margin: 1.25in, numbering: "— 1 —", number-align: center, ' +
          'header: context if(counter(page).get().first() > 1) { align(right)[Notes · #context { let hs = query(selector(heading.where(level: 1)).before(here())); if hs.len() > 0 { hs.last().body } } · #context counter(page).display()] }, ' +
          'footer: context if(counter(page).get().first() > 1) { align(center)[Econ 0100 · #context counter(page).display()] }',
      ) +
      '= Introduction\n\n' +
      Array.from({ length: 5 }, () => FILLER.repeat(3).trimEnd()).join('\n\n') +
      '\n\n= Supply and demand\n\n' +
      Array.from({ length: 6 }, () => FILLER.repeat(3).trimEnd()).join('\n\n') +
      '\n\n= Elasticity\n\n' +
      Array.from({ length: 7 }, () => FILLER.repeat(3).trimEnd()).join('\n\n') +
      '\n',
  },
  {
    // The automatic number in the header (number-align: top), a two-number
    // format, and a footer whose {page} shows the counter alone.
    name: 'chrome-top.typ',
    text:
      TYP_HEAD('paper: "us-letter", margin: 1.25in, numbering: "1 / 1", number-align: top + right, footer: align(center)[Page #context counter(page).display()]') +
      '= Numbers\n\n' +
      Array.from({ length: 12 }, () => FILLER.repeat(3).trimEnd()).join('\n\n') +
      '\n',
  },
);

FIXTURES.push({
  // The grid rail: text beside a table, three fraction columns, and a
  // three-row grid tall enough to break between rows.
  name: 'grid.typ',
  text:
    TYP_HEAD('paper: "us-letter", margin: 1.25in') +
    '= Grids\n\n' +
    FILLER.repeat(3).trimEnd() +
    '\n\n#grid(\n  columns: (2fr, 1fr),\n  gutter: 1em,\n  [\n    ' +
    FILLER.repeat(2).trimEnd() +
    '\n\n    ' +
    FILLER.repeat(1).trimEnd() +
    '\n  ],\n  [\n    #table(\n      columns: 2,\n      table.header([Item], [Value]),\n      [Alpha], [1],\n      [Beta], [2],\n      [Gamma], [3],\n    )\n  ],\n)\n\n' +
    FILLER.repeat(3).trimEnd() +
    '\n\n#grid(\n  columns: (1fr, 1fr, 1fr),\n  gutter: 1.5em,\n  [\n    == Left\n\n    ' +
    FILLER.repeat(1).trimEnd() +
    '\n  ],\n  [\n    - one\n    - two\n    - three\n  ],\n  [\n    ' +
    FILLER.repeat(1).trimEnd() +
    '\n  ],\n)\n\n' +
    Array.from({ length: 4 }, () => FILLER.repeat(4).trimEnd()).join('\n\n') +
    '\n\n#grid(\n  columns: (1fr, 1fr),\n  gutter: 1em,\n' +
    Array.from({ length: 6 }, (_, i) => '  [\n    ' + FILLER.repeat(2 + (i % 2)).trimEnd() + '\n  ],').join('\n') +
    '\n)\n\n' +
    Array.from({ length: 3 }, () => FILLER.repeat(4).trimEnd()).join('\n\n') +
    '\n',
});

// Editorial comments (editor-comments.ts): notes at every kind of seam —
// leading, between paragraphs, before a heading, stacked, beside a list,
// beside a footnote, after an explicit page break, trailing. The compile
// never sees them; every break and page start must still agree.
{
  const typNote = (t: string) => '// plass:comment\n' + t.split('\n').map((l) => '// | ' + l).join('\n') + '\n// /plass:comment';
  const mdNote = (t: string) => '<!-- plass:comment\n' + t + '\n-->';
  const body = (note: (t: string) => string, heading: (t: string, level: number) => string, pageBreak: string, footnote: (t: string) => string) =>
    [
      note('Leading note: a place to stand first.'),
      heading('Comments', 1),
      FILLER.repeat(3).trimEnd(),
      note('Between paragraphs.\nA second line.\n\nAfter a blank line.'),
      FILLER.repeat(4).trimEnd(),
      FILLER.repeat(2).trimEnd() + ' With a note' + footnote('The entry at the foot of the page, long enough to wrap onto a second line of the entry area.') + ' beside it.',
      note('Before a heading.'),
      note('Stacked: a second note right after the first.'),
      heading('Lists and breaks', 2),
      '- ' + FILLER.repeat(1).trimEnd() + '\n- ' + FILLER.repeat(1).trimEnd() + '\n- ' + FILLER.repeat(1).trimEnd(),
      note('After a list.'),
      ...Array.from({ length: 5 }, () => FILLER.repeat(4).trimEnd()),
      pageBreak,
      note('After the explicit page break.'),
      ...Array.from({ length: 3 }, () => FILLER.repeat(3).trimEnd()),
      note('Trailing note.'),
    ].join('\n\n') + '\n';
  FIXTURES.push(
    {
      name: 'comments.typ',
      text: TYP_HEAD('paper: "us-letter", margin: 1.25in, numbering: "1", number-align: center') + body(typNote, (t, l) => '='.repeat(l) + ' ' + t, '#pagebreak()', (t) => `#footnote[${t}]`),
    },
    {
      name: 'comments.md',
      text: body(mdNote, (t, l) => '#'.repeat(l) + ' ' + t, '```typst\n#pagebreak()\n```', (t) => `^[${t}]`),
    },
  );
}

FIXTURES.push({
  name: 'table-bare.md',
  text: ['| Item | Value |', '| --- | --- |', ...Array.from({ length: TABLE_ROWS - 1 }, (_, i) => `| Row ${i + 1} | ${i + 1} |`), ''].join('\n'),
});

function collect(target: string): string[] {
  const p = resolve(target);
  const st = statSync(p);
  if (st.isFile()) return [p];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const full = join(dir, name);
      const s = statSync(full);
      if (s.isDirectory()) walk(full);
      else if (/\.(md|typ)$/i.test(name)) out.push(full);
    }
  };
  walk(p);
  return out.sort();
}

async function openText(page: Page, name: string, text: string) {
  await page.goto('/?new=1');
  await page.waitForFunction(() => Boolean(window.__fm && window.view));
  await page.evaluate(
    async ({ name, text }) => {
      const root = await navigator.storage.getDirectory();
      const h = await root.getFileHandle(name, { create: true });
      const w = await h.createWritable();
      await w.write(text);
      await w.close();
      await window.__fm.loadHandle(h);
    },
    { name, text },
  );
  // The port must be up (first paragraph laid out by it, not the legacy
  // breaker), and pagination must have gone quiet.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          let pos = -1;
          window.view.state.doc.descendants((n, p) => {
            if (pos >= 0) return false;
            if (n.type.name === 'paragraph' && n.textContent.length > 40) pos = p;
            return pos < 0;
          });
          return pos < 0 ? 'none' : window.__blockAuthority(pos)?.authority ?? null;
        }),
      { timeout: 30_000, intervals: [250, 500, 1000] },
    )
    .toMatch(/port|none/);
  let last = -1;
  await expect
    .poll(
      async () => {
        const n = await page.evaluate(() => window.__pagCount());
        const stable = n === last;
        last = n;
        return stable;
      },
      { timeout: 30_000, intervals: [800] },
    )
    .toBe(true);
}

function describe(report: PortAuditReport): string {
  const s = report.summary;
  const lines = [
    `blocks ${s.blocks}: match ${s.match}, mismatch ${s.mismatch}, browser-mismatch ${s.browserMismatch}, typst-fail ${s.typstFail}, no-port ${s.noPort}` +
      ` | pages local ${report.pages.localCount} typst ${report.typst.pageCount} ${s.pagesAgree ? 'agree' : 'DIFFER'}` +
      ` | compile ${Math.round(report.compileMs)} ms, analyze ${Math.round(report.analyzeMs)} ms`,
  ];
  for (const b of report.blocks.filter((b) => b.status === 'mismatch' || b.status === 'browser-mismatch' || b.status === 'typst-fail' || b.status === 'no-port')) {
    lines.push(`  ${b.status.padEnd(10)} ${b.type}@${b.pos} "${b.text}"` + (b.reason ? ` — ${b.reason}` : b.port ? ` port ${b.port} typst ${b.typst}` : ''));
  }
  for (const c of report.chrome) lines.push(`  chrome page ${c.page + 1}: typst ${JSON.stringify(c.typst)} editor ${JSON.stringify(c.editor)}`);
  if (!s.pagesAgree) {
    const d = report.pages.firstDiff;
    lines.push(`  pages: first difference on page ${d?.firstDiffPage} (${d?.cause}) local ${JSON.stringify(d?.localStart)} typst ${JSON.stringify(d?.exactStart)}`);
    if (report.typst.status === 'fail') lines.push(`  typst pages partial: ${report.typst.reason}`);
  }
  return lines.join('\n');
}

const target = process.env.AUDIT;
const docs = target
  ? collect(target).map((p) => ({ name: basename(p), text: readFileSync(p, 'utf8'), path: p }))
  : FIXTURES.map((f) => ({ ...f, path: f.name }));

for (const doc of docs) {
  test(`port audit: ${doc.path}`, async ({ page }) => {
    test.setTimeout(180_000);
    await openText(page, doc.name, doc.text);
    const report = await page.evaluate(() => window.__audit());
    expect(report, 'Typst compile failed').not.toBeNull();
    console.log(`AUDIT ${doc.path}\n${describe(report!)}`);
    if (!target) {
      expect(report!.summary.mismatch, 'port breaks differ from Typst').toBe(0);
      expect(report!.summary.browserMismatch, 'browser-laid breaks differ from Typst').toBe(0);
      expect(report!.summary.typstFail, 'blocks Typst could not be matched to').toBe(0);
      expect(report!.summary.pagesAgree, 'page starts differ from Typst').toBe(true);
      expect(report!.summary.chromeMismatch, 'page chrome differs from Typst').toBe(0);
    }
  });
}
