import { expect, test } from 'playwright/test';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __typstEmbedPreviewStats(): { requests: number; publications: number; views: number };
    __documentCompileBrokerStats(): {
      compilerTasks: number;
      publications: number;
      sharedRequests: number;
      owners: number;
    };
    __compileCoordinatorStats(): {
      submitted: number;
      running: boolean;
      queueDepth: number;
      succeeded: number;
    };
  }
}

test('sustained mixed-document editing keeps one publication, stable listeners, and fast paint', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?new=1');
  const fixture = await page.evaluate(() => {
    const active = new Set<string>();
    let created = 0;
    let revoked = 0;
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = ((blob: Blob) => {
      const value = create(blob);
      active.add(value);
      created++;
      return value;
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((value: string) => {
      if (active.delete(value)) revoked++;
      revoke(value);
    }) as typeof URL.revokeObjectURL;
    (window as Window & { __publicationUrls?: () => { active: number; created: number; revoked: number } })
      .__publicationUrls = () => ({ active: active.size, created, revoked });

    const { state } = window.view;
    const s = state.schema;
    const paragraph = (text: string) => s.nodes.paragraph.create(null, s.text(text));
    const cell = (text: string) => s.nodes.table_cell.create(null, paragraph(text));
    const blocks: import('prosemirror-model').Node[] = [];
    let mathCount = 0;
    for (let index = 0; index < 120; index++) {
      if (index % 8 === 0) {
        blocks.push(s.nodes.paragraph.create(null, [
          s.text(`Long-session paragraph ${index} carries exact math `),
          s.nodes.math_inline.create({ src: `x_${mathCount++}^2 + 1` }),
          s.text(' while the rest of the editor remains native and immediately editable. '.repeat(2)),
        ]));
      } else {
        blocks.push(paragraph(
          `Long-session paragraph ${index}. ` +
          'One immutable publication serves line decisions, pages, math, and embedded Typst. '.repeat(2),
        ));
      }
    }
    blocks.splice(12, 0, s.nodes.typst_embed.create(null, s.text('#rect(width: 50pt, height: 7pt)')));
    blocks.splice(48, 0, s.nodes.typst_embed.create(null, s.text('#circle(radius: 4pt)')));
    blocks.splice(84, 0, s.nodes.typst_embed.create(null, s.text('#line(length: 72pt)')));
    blocks.splice(60, 0, s.nodes.table.create({ style: 'booktabs', caption: 'Soak table' }, [
      s.nodes.table_row.create(null, [cell('SOAK_CELL'), cell('Stable value')]),
      s.nodes.table_row.create(null, [cell('baseline'), cell('16 ms')]),
    ]));
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, blocks));
    return { expectedViews: mathCount + 3 };
  });

  await expect(page.locator('.math-inline[data-preview-state="ready"]')).toHaveCount(fixture.expectedViews - 3, {
    timeout: 60_000,
  });
  await expect(page.locator('.ts-typst-embed[data-preview-state="ready"]')).toHaveCount(3, {
    timeout: 60_000,
  });
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 60_000 });
  const before = await page.evaluate(() => window.__documentCompileBrokerStats());

  const rounds: Array<{
    active: number;
    created: number;
    revoked: number;
    views: number;
    queueDepth: number;
    running: boolean;
  }> = [];
  for (let round = 0; round < 8; round++) {
    const finalSource = `x_{round${round}}^2 + ${round + 2}`;
    await page.evaluate(({ round, finalSource }) => {
      for (let edit = 0; edit < 12; edit++) {
        const { state } = window.view;
        let pos = -1;
        state.doc.descendants((node, nodePos) => {
          if (pos < 0 && node.type.name === 'math_inline') pos = nodePos;
          return pos < 0;
        });
        if (pos < 0) throw new Error('soak formula disappeared');
        const node = state.doc.nodeAt(pos)!;
        const src = edit === 11 ? finalSource : `x_{${round}_${edit}}^2 + 1`;
        window.view.dispatch(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, src }));
      }
    }, { round, finalSource });
    const firstMath = page.locator('.math-inline').first();
    await expect(firstMath).toHaveAttribute('data-math', finalSource);
    await expect(firstMath).toHaveAttribute('data-preview-state', 'ready', { timeout: 60_000 });
    await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 60_000 });
    await expect.poll(() => page.evaluate(() => {
      const stats = window.__compileCoordinatorStats();
      return Number(stats.running) + stats.queueDepth;
    })).toBe(0);
    rounds.push(await page.evaluate(() => {
      const urls = (window as Window & {
        __publicationUrls?: () => { active: number; created: number; revoked: number };
      }).__publicationUrls?.() ?? { active: -1, created: -1, revoked: -1 };
      const previews = window.__typstEmbedPreviewStats();
      const coordinator = window.__compileCoordinatorStats();
      return { ...urls, views: previews.views, queueDepth: coordinator.queueDepth, running: coordinator.running };
    }));
  }

  expect(rounds.every((round) => round.views === fixture.expectedViews)).toBe(true);
  expect(rounds.every((round) => round.queueDepth === 0 && !round.running)).toBe(true);
  expect(Math.max(...rounds.map((round) => round.active))).toBeLessThanOrEqual(1);
  expect(rounds.at(-1)!.created - rounds.at(-1)!.revoked).toBe(1);
  const afterRounds = await page.evaluate(() => window.__documentCompileBrokerStats());
  expect(afterRounds.compilerTasks - before.compilerTasks).toBe(8);
  expect(afterRounds.publications - before.publications).toBe(8);

  await page.locator('td p', { hasText: 'SOAK_CELL' }).scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const { state } = window.view;
    let pos = -1;
    state.doc.descendants((node, nodePos) => {
      if (pos < 0 && node.type.name === 'paragraph' && node.textContent === 'SOAK_CELL') pos = nodePos;
      return pos < 0;
    });
    if (pos < 0) throw new Error('soak table cell disappeared');
    const selection = state.selection.constructor as typeof import('prosemirror-state').TextSelection;
    window.view.dispatch(state.tr.setSelection(selection.create(state.doc, pos + 1 + 'SOAK_CELL'.length)));
    window.view.focus();
    const target = document.querySelector<HTMLElement>('td p');
    if (!target) throw new Error('soak cell DOM disappeared');
    const samples: number[] = [];
    window.view.dom.addEventListener('beforeinput', () => {
      const start = performance.now();
      requestAnimationFrame(() => samples.push(performance.now() - start));
    }, { capture: true });
    (window as Window & { __soakFrames?: () => number[] }).__soakFrames = () => samples;
  });
  const burst = '_still_immediate';
  await page.keyboard.type(burst, { delay: 4 });
  await expect(page.locator('td p').first()).toHaveText('SOAK_CELL' + burst);
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __soakFrames?: () => number[] }).__soakFrames?.().length ?? 0,
  )).toBeGreaterThanOrEqual(burst.length);
  const frames = await page.evaluate(() =>
    (window as Window & { __soakFrames?: () => number[] }).__soakFrames?.() ?? [],
  );
  const sorted = [...frames].sort((left, right) => left - right);
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
  expect(p95).toBeLessThanOrEqual(50);
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => {
    const stats = window.__compileCoordinatorStats();
    return Number(stats.running) + stats.queueDepth;
  })).toBe(0);
});
