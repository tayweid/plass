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
  pages: {
    local: Array<{ pos: number; line: number; unit: string }>;
    typst: Array<{ pos: number; line: number; unit: string }>;
    localCount: number;
    agree: boolean;
    firstDiff: { firstDiffPage: number; cause: string; localStart: unknown; exactStart: unknown } | null;
  };
  blocks: Array<{ pos: number; type: string; text: string; status: string; port?: string; typst?: string; authority?: string | null; reason?: string }>;
  summary: { blocks: number; match: number; mismatch: number; typstFail: number; noPort: number; pagesAgree: boolean };
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
    `blocks ${s.blocks}: match ${s.match}, mismatch ${s.mismatch}, typst-fail ${s.typstFail}, no-port ${s.noPort}` +
      ` | pages local ${report.pages.localCount} typst ${report.typst.pageCount} ${s.pagesAgree ? 'agree' : 'DIFFER'}` +
      ` | compile ${Math.round(report.compileMs)} ms, analyze ${Math.round(report.analyzeMs)} ms`,
  ];
  for (const b of report.blocks.filter((b) => b.status === 'mismatch' || b.status === 'typst-fail' || b.status === 'no-port')) {
    lines.push(`  ${b.status.padEnd(10)} ${b.type}@${b.pos} "${b.text}"` + (b.reason ? ` — ${b.reason}` : b.port ? ` port ${b.port} typst ${b.typst}` : ''));
  }
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
      expect(report!.summary.typstFail, 'blocks Typst could not be matched to').toBe(0);
      expect(report!.summary.pagesAgree, 'page starts differ from Typst').toBe(true);
    }
  });
}
