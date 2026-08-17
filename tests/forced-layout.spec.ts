import { expect, test } from 'playwright/test';

interface AuditLine {
  from: number;
  to: number;
  breakPos: number | null;
  hyphen: boolean;
  spacing: string;
}

interface AuditCase {
  id: string;
  sample: string;
  scale: number;
  forced: Array<{ at: number; hyphen: boolean }>;
  fast: AuditLine[] | null;
  legacy: AuditLine[] | null;
  fastReads: number;
  legacyReads: number;
  fastPopulations: number;
  legacyPopulations: number;
  hardBreak: boolean;
}

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __forcedPathStats: () => { fast: number; fallback: number };
    __forcedLayoutAudit: {
      start(): void;
      snapshot(): { cases: AuditCase[] };
      stop(): { cases: AuditCase[] };
    };
  }
}

test('direct forced layout matches legacy output with fewer DOM measurements', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const p = state.schema.nodes.paragraph;
    const text = state.schema.text.bind(state.schema);
    const strong = state.schema.marks.strong.create();
    const em = state.schema.marks.em.create();
    const code = state.schema.marks.code.create();

    const ordinary =
      'The Knuth Plass algorithm evaluates a complete paragraph and preserves globally optimal line endings while editing. ';
    const hyphenWords =
      'characteristically institutionalization representation hyphenation internationalization computationally ';
    const blocks = [
      p.create(null, text(`PLAIN_CASE ${ordinary.repeat(24)}`)),
      p.create(null, [
        text('MARK_CASE regular office affinity AVATAR '),
        text('strongly marked language ', [strong]),
        text('emphasized typography ', [em]),
        text('combined styling ', [strong, em]),
        text('inline code remains measurable ', [code]),
        text(ordinary.repeat(4)),
      ]),
      p.create(null, text(`SPACE_CASE ordinary  repeated   spaces\u00a0and nonbreaking space ${ordinary.repeat(5)}`)),
      p.create(null, [
        text(`HARD_CASE before the explicit line ending ${ordinary.repeat(2)}`),
        state.schema.nodes.hard_break.create(),
        text(`after the explicit line ending ${ordinary.repeat(2)}`),
      ]),
      p.create(null, text(`DASH_CASE state-of-the-art state–of–the–art state—of—the—art ${ordinary.repeat(6)}`)),
      p.create(null, text(`HYPHEN_CASE ${hyphenWords.repeat(18)}`)),
      state.schema.nodes.math_display.create({
        src: 'x = 1',
        label: 'audit-equation',
        numbered: true,
      }),
      p.create(null, [
        text('ATOM_CASE references '),
        state.schema.nodes.citation.create({ key: 'audit' }),
        text(' and equation '),
        state.schema.nodes.eq_ref.create({ label: 'audit-equation' }),
        text(` remain indivisible while ${ordinary.repeat(5)}`),
      ]),
      state.schema.nodes.figure.create(
        {
          src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          label: 'audit-figure',
          name: '',
        },
        [text(`CAPTION_CASE ${ordinary.repeat(7)}`, [em])],
      ),
      p.create(null, [
        text('FOOTNOTE_OUTER_CASE the marker '),
        state.schema.nodes.footnote.create(
          null,
          [text(`FOOTNOTE_CASE ${hyphenWords.repeat(7)}`, [strong])],
        ),
        text(` stays in the outer paragraph ${ordinary.repeat(5)}`),
      ]),
      state.schema.nodes.bibliography.create(),
    ];
    const settings = {
      ...state.doc.attrs.settings,
      page: 'b5',
      marginLeft: 1.45,
      marginRight: 1.45,
      hyphenate: true,
    };
    const doc = state.schema.nodes.doc.create(
      {
        ...state.doc.attrs,
        settings,
        bib: {
          name: 'audit.bib',
          content: '@article{audit, title={Layout Audit}, author={Test, A.}, year={2026}}',
        },
      },
      blocks,
    );
    window.view.dispatch(
      state.tr
        .replaceWith(0, state.doc.content.size, doc.content)
        .setDocAttribute('settings', settings)
        .setDocAttribute('bib', doc.attrs.bib),
    );
  });

  await page.evaluate(() => document.fonts.ready);
  await expect.poll(() => page.evaluate(() => window.__forcedPathStats().fast), { timeout: 15_000 }).toBeGreaterThan(0);
  const documentBeforeAudit = await page.evaluate(() => window.view.state.doc.toJSON());

  await page.evaluate(() => window.__forcedLayoutAudit.start());
  await expect
    .poll(
      () => page.evaluate(() => window.__forcedLayoutAudit.snapshot().cases.length),
      { timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(9);

  // Let the compiled oracle replace matching port answers; identical audit
  // keys are overwritten rather than counted twice.
  await page.waitForTimeout(1_000);
  const report = await page.evaluate(() => window.__forcedLayoutAudit.stop());
  expect(report.cases.length).toBeGreaterThanOrEqual(9);

  for (const entry of report.cases) {
    expect(entry.fast, `${entry.id} fast result`).not.toBeNull();
    expect(entry.legacy, `${entry.id} legacy result`).not.toBeNull();
    if (!entry.hardBreak) expect(entry.fast, entry.id).toEqual(entry.legacy);
    expect(entry.fastReads, `${entry.id} Range reads`).toBeLessThanOrEqual(entry.legacyReads);
    expect(entry.fastPopulations, `${entry.id} probe populations`).toBeLessThanOrEqual(
      entry.legacyPopulations,
    );
  }

  expect(report.cases.some((entry) => entry.sample.startsWith('CAPTION_CASE'))).toBe(true);
  expect(report.cases.some((entry) => entry.sample.startsWith('FOOTNOTE_CASE') && entry.scale === 0.85)).toBe(true);
  expect(report.cases.some((entry) => entry.forced.some((forced) => forced.hyphen))).toBe(true);
  expect(report.cases.some((entry) => entry.fast?.some((line) => line.hyphen))).toBe(true);

  const long = report.cases.find((entry) => entry.sample.startsWith('PLAIN_CASE'))!;
  expect(long.legacyReads).toBeGreaterThanOrEqual(50);
  expect(long.fastReads).toBeLessThanOrEqual(long.legacyReads * 0.5);

  const totals = report.cases.reduce(
    (sum, entry) => ({ fast: sum.fast + entry.fastReads, legacy: sum.legacy + entry.legacyReads }),
    { fast: 0, legacy: 0 },
  );
  expect(totals.fast).toBeLessThanOrEqual(totals.legacy * 0.65);
  expect(await page.locator('.ts-hyphen').count()).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.view.state.doc.toJSON())).toEqual(documentBeforeAudit);
});
