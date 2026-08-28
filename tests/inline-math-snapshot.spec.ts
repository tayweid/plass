import { expect, test } from 'playwright/test';

test.describe('full-document inline-math layout snapshot', () => {
  test.describe.configure({ timeout: 75_000 });

  test('maps rendered formula ink back to the atomic ProseMirror offset', async ({ page }) => {
    await page.goto('/?new=1');

    const fixture = await page.evaluate(() => {
      const w = window as unknown as {
        view: import('prosemirror-view').EditorView;
      };
      const { state } = w.view;
      const s = state.schema;
      const prefix = 'The invariant ';
      const suffix = ' remains stable while surrounding prose wraps across several exact lines. ';
      const paragraph = s.nodes.paragraph.create(null, [
        s.text(prefix),
        s.nodes.math_inline.create({ src: '\\sum_{i=1}^{n} x_i' }),
        s.text(suffix.repeat(12)),
      ]);
      w.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, paragraph));
      return {
        blockPos: 0,
        contentSize: paragraph.content.size,
      };
    });

    const snapshot = async () => page.evaluate(async () => {
      const w = window as unknown as {
        view: import('prosemirror-view').EditorView;
        __pageOracle?: {
          get(key: string): {
            status: 'ok' | 'fail';
            reason?: string;
            snapshot?: {
              blocks: ReadonlyArray<{
                pos: number;
                breaks: ReadonlyArray<{ at: number; hyphen: boolean }>;
              }>;
            };
          } | undefined;
        };
      };
      const { docToTyp } = await import('/src/typ-serializer.ts');
      const key = docToTyp(w.view.state.doc);
      const entry = w.__pageOracle?.get(key);
      return {
        status: entry?.status ?? 'pending',
        reason: entry?.reason ?? null,
        blocks: entry?.snapshot?.blocks ?? [],
      };
    });

    await expect.poll(async () => (await snapshot()).status, {
      timeout: 60_000,
      intervals: [100, 250, 500, 1_000],
    }).not.toBe('pending');

    const result = await snapshot();
    expect(result.status, result.reason ?? 'snapshot failed without a reason').toBe('ok');
    const block = result.blocks.find((candidate) => candidate.pos === fixture.blockPos);
    expect(block).toBeDefined();
    expect(block!.breaks.length).toBeGreaterThan(0);
    expect(block!.breaks.map((item) => item.at)).toEqual(
      [...new Set(block!.breaks.map((item) => item.at))].sort((a, b) => a - b),
    );
    for (const item of block!.breaks) {
      expect(item.at).toBeGreaterThan(0);
      expect(item.at).toBeLessThanOrEqual(fixture.contentSize);
    }
  });

  test('fails closed when an opaque visual page has no text-selection line', async ({ page }) => {
    await page.goto('/?new=1');
    await page.evaluate(() => {
      const w = window as unknown as { view: import('prosemirror-view').EditorView };
      const { state } = w.view;
      const s = state.schema;
      const doc = [
        s.nodes.paragraph.create(null, [s.text('Mapped prose on the first page.')]),
        s.nodes.typst_embed.create(null, [
          s.text('#pagebreak()\n#rect(width: 72pt, height: 72pt, fill: rgb("#356ad2"))'),
        ]),
      ];
      w.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, doc));
    });

    const snapshot = async () => page.evaluate(async () => {
      const w = window as unknown as {
        view: import('prosemirror-view').EditorView;
        __pageOracle?: {
          get(key: string): {
            status: 'ok' | 'fail';
            reason?: string;
            pageCount?: number;
            snapshot?: { pageStarts: unknown };
          } | undefined;
        };
      };
      const { docToTyp } = await import('/src/typ-serializer.ts');
      const entry = w.__pageOracle?.get(docToTyp(w.view.state.doc));
      return {
        status: entry?.status ?? 'pending',
        reason: entry?.reason ?? null,
        pageCount: entry?.pageCount ?? null,
        pageStarts: entry?.snapshot ? entry.snapshot.pageStarts : 'missing',
      };
    });

    await expect.poll(async () => (await snapshot()).status, {
      timeout: 60_000,
      intervals: [100, 250, 500, 1_000],
    }).not.toBe('pending');

    const result = await snapshot();
    expect(result.status).toBe('fail');
    expect(result.pageCount).toBe(2);
    expect(result.pageStarts).toBeNull();
    expect(result.reason).toContain('mapped 0 of 1 page boundaries');
  });
});
