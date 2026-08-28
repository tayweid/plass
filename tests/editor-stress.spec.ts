import { expect, test, type Page } from 'playwright/test';

const P95_RAF_CEILING_MS = 200;
const P95_EVENT_CEILING_MS = 160;
const MAX_LOCAL_COMPILER_DEPTH = 8;

interface StressCase {
  name: string;
  paragraphs: number;
  activeChars: number;
  burst: string;
}

interface CompilerStats {
  queueDepth: number;
  maxQueueDepth: number;
  running: boolean;
  submitted: number;
  succeeded: number;
  failed: number;
  staleCompletions: number;
}

interface LayoutStats {
  lines: number;
  pageMarks: number;
}

interface StressSample {
  data: string | null;
  keydownAt: number;
  beforeInputAt: number | null;
  inputAt: number | null;
  rafAt: number | null;
  afterFrameAt: number | null;
  layoutBefore: LayoutStats;
  layoutAtRaf: LayoutStats | null;
  compilerBefore: CompilerStats;
  compilerAtRaf: CompilerStats | null;
  domMatchesStateAtRaf: boolean | null;
  lineWidgetsAtRaf: number | null;
}

interface StressProbeSnapshot {
  samples: StressSample[];
  eventDurations: number[];
  dispatches: { total: number; docChanged: number; nonDoc: number };
  maxQueueDepth: number;
}

interface StressProbe {
  arm(): void;
  finishTyping(): void;
  stop(): void;
  snapshot(): StressProbeSnapshot;
}

interface StressWindow extends Window {
  view: import('prosemirror-view').EditorView;
  __stressActivePos: number;
  __stressProbe?: StressProbe;
  __compileCoordinatorStats?: () => CompilerStats;
  __layoutDispatchStats: (reset?: boolean) => LayoutStats;
  __pageOracle?: {
    get(key: string): {
      status: 'ok' | 'fail';
      reason?: string;
      snapshot?: {
        revision: number;
        documentKey: string;
        pageCount: number;
        blocks: readonly unknown[];
      };
    } | undefined;
  };
  __proofRun?: Promise<void>;
}

const CASES: StressCase[] = [
  {
    name: 'medium technical document',
    paragraphs: 220,
    activeChars: 2_500,
    burst: 'latestmediumrevision',
  },
  {
    name: 'medium-large technical document',
    paragraphs: 420,
    activeChars: 4_000,
    burst: 'latestmediumlargerevision',
  },
];

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

async function openStableDevPage(page: Page): Promise<void> {
  // The acceptance window deliberately spans full WASM compiles. Ignore Vite
  // HMR traffic so an unrelated file save cannot reload the page halfway
  // through a measurement; application/compiler Web Workers are unaffected.
  await page.routeWebSocket(/127\.0\.0\.1:5199/, () => {});
  await page.goto('/?new=1');
}

async function installTechnicalDocument(page: Page, config: StressCase): Promise<{
  activePos: number;
  activeText: string;
  caretOffset: number;
}> {
  return page.evaluate(({ paragraphs, activeChars }) => {
    const w = window as unknown as StressWindow;
    const { state } = w.view;
    const s = state.schema;
    const p = s.nodes.paragraph;
    const blocks: import('prosemirror-model').Node[] = [];
    const sentence =
      'Distributed systems preserve a single revision while editors, compilers, and layout workers exchange bounded immutable snapshots. ';
    const activeText = (`ACTIVE_STRESS_PARAGRAPH ${sentence.repeat(Math.ceil(activeChars / sentence.length))}`)
      .slice(0, activeChars);
    const activeIndex = Math.floor(paragraphs / 2);
    let activeNode: import('prosemirror-model').Node | null = null;

    const cell = (value: string, header = false) =>
      (header ? s.nodes.table_header : s.nodes.table_cell).create(
        null,
        p.create(null, s.text(value)),
      );
    const technicalTable = (index: number) => s.nodes.table.create(null, [
      s.nodes.table_row.create(null, [cell('Metric', true), cell('Value', true), cell('Revision', true)]),
      s.nodes.table_row.create(null, [cell(`latency-${index}`), cell(`${16 + index % 7} ms`), cell(`r${index}`)]),
      s.nodes.table_row.create(null, [cell('queue depth'), cell(`${1 + index % 3}`), cell('latest')]),
    ]);

    blocks.push(s.nodes.heading.create({ level: 1 }, s.text('Stress acceptance: technical report')));
    for (let index = 0; index < paragraphs; index++) {
      if (index === activeIndex) {
        activeNode = p.create(null, s.text(activeText));
        blocks.push(activeNode);
      } else {
        const inline: import('prosemirror-model').Node[] = [
          s.text(`Section ${index + 1}. ${sentence}`),
        ];
        if (index % 31 === 0) {
          inline.push(s.text(' Prior work '));
          inline.push(s.nodes.citation.create({ key: 'stressref' }));
          inline.push(s.text(' establishes the bound.'));
        }
        blocks.push(p.create(null, inline));
      }

      if (index > 0 && index % 70 === 0) {
        blocks.push(s.nodes.math_display.create({
          src: `T_${index} = sum_(i=1)^n x_i`,
          label: `eq:stress-${index}`,
          numbered: true,
        }));
      }
      if (index > 0 && index % 90 === 0) blocks.push(technicalTable(index));
      if (index > 0 && index % 100 === 0) {
        blocks.push(s.nodes.typst_embed.create(
          null,
          s.text(`#rect(width: ${18 + index % 9}pt, height: 4pt, fill: rgb("4b72c2"))`),
        ));
      }
      if (index > 0 && index % 140 === 0) {
        blocks.push(s.nodes.heading.create({ level: 2 }, s.text(`Technical appendix ${index / 140}`)));
      }
    }
    blocks.push(s.nodes.code_block.create({ params: 'typst' }, s.text('#let shown = "ordinary inert code"')));
    blocks.push(s.nodes.bibliography.create());

    let activePos = 0;
    let cursor = 0;
    for (const node of blocks) {
      if (node === activeNode) activePos = cursor;
      cursor += node.nodeSize;
    }
    const bib = {
      name: 'stress.bib',
      content: '@article{stressref, title={Bounded Revision Publication}, author={Test, Ada}, year={2026}}',
    };
    let tr = state.tr.replaceWith(0, state.doc.content.size, blocks);
    tr = tr.setDocAttribute('bib', bib);
    w.view.dispatch(tr);
    w.__stressActivePos = activePos;

    const caretOffset = Math.floor(activeText.length / 2);
    const current = w.view.state;
    const selectionType = current.selection.constructor as unknown as {
      create(doc: typeof current.doc, from: number, to?: number): typeof current.selection;
    };
    w.view.dispatch(
      current.tr
        .setSelection(selectionType.create(current.doc, activePos + 1 + caretOffset)),
    );
    const activeDOM = w.view.nodeDOM(activePos);
    if (activeDOM instanceof HTMLElement) activeDOM.scrollIntoView({ block: 'center' });
    w.view.focus();
    return { activePos, activeText, caretOffset };
  }, config);
}

async function currentSnapshot(page: Page): Promise<{
  status: string;
  reason: string | null;
  revision: number;
  pages: number;
  blocks: number;
  sourceMatches: boolean;
  idle: boolean;
}> {
  return page.evaluate(async () => {
    const w = window as unknown as StressWindow;
    if (!w.view) {
      return {
        status: 'pending',
        reason: null,
        revision: 0,
        pages: 0,
        blocks: 0,
        sourceMatches: false,
        idle: false,
      };
    }
    const { docToTyp } = await import('/src/typ-serializer.ts');
    const source = docToTyp(w.view.state.doc);
    const entry = w.__pageOracle?.get(source);
    const compiler = w.__compileCoordinatorStats?.();
    return {
      status: entry?.status ?? 'pending',
      reason: entry?.reason ?? null,
      revision: entry?.snapshot?.revision ?? 0,
      pages: entry?.snapshot?.pageCount ?? 0,
      blocks: entry?.snapshot?.blocks.length ?? 0,
      sourceMatches: entry?.snapshot?.documentKey === source,
      idle: !!compiler && !compiler.running && compiler.queueDepth === 0,
    };
  });
}

async function placeStressCaret(page: Page, caretOffset: number): Promise<number> {
  const activePos = await page.evaluate((offset) => {
    const w = window as unknown as StressWindow;
    let activePos = -1;
    w.view.state.doc.descendants((node, pos) => {
      if (activePos < 0 && node.type.name === 'paragraph' && node.textContent.startsWith('ACTIVE_STRESS_PARAGRAPH')) {
        activePos = pos;
        return false;
      }
      return activePos < 0;
    });
    if (activePos < 0) throw new Error('stress document lost its active paragraph');
    w.__stressActivePos = activePos;
    const current = w.view.state;
    const selectionType = current.selection.constructor as unknown as {
      create(doc: typeof current.doc, from: number, to?: number): typeof current.selection;
    };
    w.view.dispatch(current.tr.setSelection(selectionType.create(current.doc, activePos + 1 + offset)));
    const activeDOM = w.view.nodeDOM(activePos);
    if (activeDOM instanceof HTMLElement) activeDOM.scrollIntoView({ block: 'center' });
    w.view.focus();
    const target = activePos + 1 + offset;
    const dom = w.view.domAtPos(target);
    const nativeSelection = window.getSelection();
    if (nativeSelection) {
      const range = document.createRange();
      range.setStart(dom.node, dom.offset);
      range.collapse(true);
      nativeSelection.removeAllRanges();
      nativeSelection.addRange(range);
    }
    return activePos;
  }, caretOffset);
  await expect.poll(() => page.evaluate(() => {
    const w = window as unknown as StressWindow;
    const selection = window.getSelection();
    if (!selection?.anchorNode) return -1;
    try {
      const anchor = w.view.posAtDOM(selection.anchorNode, selection.anchorOffset);
      const focus = selection.focusNode
        ? w.view.posAtDOM(selection.focusNode, selection.focusOffset)
        : -1;
      return selection.isCollapsed && anchor === focus ? anchor : -1;
    } catch {
      return -1;
    }
  })).toBe(activePos + 1 + caretOffset);
  return activePos;
}

async function waitForCurrentSnapshot(page: Page, minimumRevision = 0): Promise<Awaited<ReturnType<typeof currentSnapshot>>> {
  await expect.poll(async () => {
    const snapshot = await currentSnapshot(page);
    return snapshot.sourceMatches && snapshot.idle && snapshot.revision > minimumRevision;
  }, { timeout: 75_000, intervals: [100, 250, 500, 1_000] }).toBe(true);
  const snapshot = await currentSnapshot(page);
  expect(snapshot.status, snapshot.reason ?? 'exact snapshot failed without a reason').toBe('ok');
  return snapshot;
}

async function installStressProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as StressWindow;
    if (w.__stressProbe) return;

    const zeroCompiler = (): CompilerStats => ({
      queueDepth: 0,
      maxQueueDepth: 0,
      running: false,
      submitted: 0,
      succeeded: 0,
      failed: 0,
      staleCompletions: 0,
    });
    const compiler = (): CompilerStats => ({
      ...zeroCompiler(),
      ...(w.__compileCoordinatorStats?.() ?? {}),
    });
    const dispatches = { total: 0, docChanged: 0, nonDoc: 0 };
    const samples: StressSample[] = [];
    const eventDurations: number[] = [];
    let armed = false;
    let monitoring = false;
    let maxQueueDepth = 0;
    const scheduled = new WeakSet<StressSample>();

    const originalDispatch = w.view.dispatch.bind(w.view);
    w.view.dispatch = ((tr) => {
      if (armed) {
        dispatches.total++;
        if (tr.docChanged) dispatches.docChanged++;
        else dispatches.nonDoc++;
      }
      originalDispatch(tr);
    }) as typeof w.view.dispatch;

    const activeProjection = () => {
      try {
        const node = w.view.state.doc.nodeAt(w.__stressActivePos);
        const dom = w.view.nodeDOM(w.__stressActivePos);
        if (!node || !(dom instanceof HTMLElement)) return { matches: false, lineWidgets: -1 };
        const lineWidgets = [...dom.querySelectorAll('.ts-br, .ts-hyphen')]
          .filter((widget) => {
            // A line-page-gap deliberately stays mapped through an active
            // edit to hold page geometry. Its optional hyphen is a sibling of
            // `.ts-pagegap`, not a newly published exact line breaker.
            if (
              widget.classList.contains('ts-hyphen') &&
              widget.parentElement?.querySelector(':scope > .ts-pagegap')
            ) return false;
            return true;
          }).length;
        const sourceProjection = dom.cloneNode(true) as HTMLElement;
        sourceProjection.querySelectorAll('.ts-hyphen').forEach((widget) => widget.remove());
        return { matches: sourceProjection.textContent === node.textContent, lineWidgets };
      } catch {
        return { matches: false, lineWidgets: -1 };
      }
    };

    const schedulePresentationSample = (sample: StressSample) => {
      if (scheduled.has(sample)) return;
      scheduled.add(sample);
      requestAnimationFrame(() => {
        sample.rafAt = performance.now();
        sample.layoutAtRaf = w.__layoutDispatchStats();
        sample.compilerAtRaf = compiler();
        const projection = activeProjection();
        sample.domMatchesStateAtRaf = projection.matches;
        sample.lineWidgetsAtRaf = projection.lineWidgets;
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          sample.afterFrameAt = performance.now();
          channel.port1.close();
          channel.port2.close();
        };
        channel.port2.postMessage(null);
      });
    };

    w.view.dom.addEventListener('keydown', (event) => {
      if (!armed || event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return;
      const sample: StressSample = {
        data: event.key,
        keydownAt: event.timeStamp,
        beforeInputAt: null,
        inputAt: null,
        rafAt: null,
        afterFrameAt: null,
        layoutBefore: w.__layoutDispatchStats(),
        layoutAtRaf: null,
        compilerBefore: compiler(),
        compilerAtRaf: null,
        domMatchesStateAtRaf: null,
        lineWidgetsAtRaf: null,
      };
      samples.push(sample);
      // beforeinput/input normally schedules the sample after the editable
      // mutation path has begun. This fallback covers Chromium's occasional
      // first-key keypress path, which dispatches without beforeinput.
      window.setTimeout(() => schedulePresentationSample(sample), 0);
    }, true);
    w.view.dom.addEventListener('beforeinput', (event) => {
      if (
        !armed ||
        !(event instanceof InputEvent) ||
        !event.data ||
        !event.inputType.startsWith('insert')
      ) return;
      const sample = [...samples].reverse().find((candidate) => candidate.beforeInputAt === null);
      if (sample) {
        sample.data = event.data;
        sample.beforeInputAt = event.timeStamp;
        schedulePresentationSample(sample);
      }
    }, true);
    w.view.dom.addEventListener('input', (event) => {
      if (
        !armed ||
        !(event instanceof InputEvent) ||
        !event.data ||
        !event.inputType.startsWith('insert')
      ) return;
      const sample = [...samples].reverse().find((candidate) => candidate.inputAt === null);
      if (sample) {
        sample.inputAt = event.timeStamp;
        schedulePresentationSample(sample);
      }
    }, true);

    try {
      const observer = new PerformanceObserver((list) => {
        if (!monitoring) return;
        for (const entry of list.getEntries() as PerformanceEventTiming[]) {
          if (['keydown', 'beforeinput', 'input', 'keyup'].includes(entry.name)) {
            eventDurations.push(entry.duration);
          }
        }
      });
      observer.observe({ type: 'event', buffered: true, durationThreshold: 16 });
    } catch {
      // Event Timing is supplementary; explicit event/rAF samples remain the
      // cross-build acceptance signal.
    }

    const monitor = window.setInterval(() => {
      if (!monitoring) return;
      maxQueueDepth = Math.max(maxQueueDepth, compiler().queueDepth);
    }, 4);

    w.__stressProbe = {
      arm() {
        samples.length = 0;
        eventDurations.length = 0;
        dispatches.total = 0;
        dispatches.docChanged = 0;
        dispatches.nonDoc = 0;
        maxQueueDepth = 0;
        w.__layoutDispatchStats(true);
        monitoring = true;
        armed = true;
      },
      finishTyping() {
        armed = false;
      },
      stop() {
        armed = false;
        monitoring = false;
        window.clearInterval(monitor);
      },
      snapshot() {
        return {
          samples: samples.map((sample) => ({
            ...sample,
            layoutBefore: { ...sample.layoutBefore },
            layoutAtRaf: sample.layoutAtRaf ? { ...sample.layoutAtRaf } : null,
            compilerBefore: { ...sample.compilerBefore },
            compilerAtRaf: sample.compilerAtRaf ? { ...sample.compilerAtRaf } : null,
          })),
          eventDurations: [...eventDurations],
          dispatches: { ...dispatches },
          maxQueueDepth,
        };
      },
    };
  });
}

async function assertDocumentSourcesConverged(page: Page, expectedActive: string): Promise<void> {
  const result = await page.evaluate((expected) => {
    const w = window as unknown as StressWindow;
    const active = w.view.state.doc.nodeAt(w.__stressActivePos);
    const activeDOM = w.view.nodeDOM(w.__stressActivePos);
    const stateEmbeds: string[] = [];
    w.view.state.doc.descendants((node) => {
      if (node.type.name === 'typst_embed') stateEmbeds.push(node.textContent);
      return true;
    });
    const domEmbeds = [...w.view.dom.querySelectorAll<HTMLElement>('[data-typst-embed] code[data-typst-source]')]
      .map((node) => node.textContent ?? '');
    let domActive = '';
    if (activeDOM instanceof HTMLElement) {
      const sourceProjection = activeDOM.cloneNode(true) as HTMLElement;
      sourceProjection.querySelectorAll('.ts-hyphen').forEach((node) => node.remove());
      domActive = sourceProjection.textContent ?? '';
    }
    return {
      stateActive: active?.textContent ?? '',
      domActive,
      expected,
      stateEmbeds,
      domEmbeds,
      embedErrors: [...w.view.dom.querySelectorAll<HTMLElement>('[data-typst-embed]')]
        .filter((node) => node.dataset.previewState === 'error')
        .map((node) => node.textContent ?? ''),
    };
  }, expectedActive);
  expect(result.stateActive).toBe(result.expected);
  expect(result.domActive).toBe(result.expected);
  expect(result.domEmbeds).toEqual(result.stateEmbeds);
  expect(result.embedErrors).toEqual([]);
}

test.describe('technical-document typing acceptance', () => {
  test.describe.configure({ timeout: 100_000 });

  for (const config of CASES) {
    test(`${config.name} keeps a real-key burst paint-first and publishes only the latest snapshot`, async ({ page }) => {
      await openStableDevPage(page);
      const active = await installTechnicalDocument(page, config);
      const fixture = await page.evaluate(() => {
        const w = window as unknown as StressWindow;
        const counts: Record<string, number> = {};
        w.view.state.doc.descendants((node) => {
          counts[node.type.name] = (counts[node.type.name] ?? 0) + 1;
          return true;
        });
        return counts;
      });
      expect(fixture.paragraph).toBeGreaterThanOrEqual(config.paragraphs);
      expect(fixture.math_display).toBeGreaterThanOrEqual(3);
      expect(fixture.citation).toBeGreaterThanOrEqual(8);
      expect(fixture.table).toBeGreaterThanOrEqual(2);
      expect(fixture.typst_embed).toBeGreaterThanOrEqual(2);

      // The acceptance run starts from a current exact revision and a fully
      // idle shared compiler, not from startup work that happens to overlap.
      const baseline = await waitForCurrentSnapshot(page);
      await expect.poll(() => page.evaluate(() => {
        const w = window as unknown as StressWindow;
        if (!w.view) return 0;
        let activePos = -1;
        w.view.state.doc.descendants((node, pos) => {
          if (activePos < 0 && node.type.name === 'paragraph' && node.textContent.startsWith('ACTIVE_STRESS_PARAGRAPH')) {
            activePos = pos;
            return false;
          }
          return activePos < 0;
        });
        if (activePos < 0) return 0;
        w.__stressActivePos = activePos;
        const dom = w.view.nodeDOM(activePos);
        return dom instanceof HTMLElement ? dom.querySelectorAll('.ts-br, .ts-hyphen').length : 0;
      }), { timeout: 30_000 }).toBeGreaterThan(0);
      await placeStressCaret(page, active.caretOffset);

      await installStressProbe(page);
      await page.evaluate(() => (window as unknown as StressWindow).__stressProbe!.arm());
      await page.keyboard.type(config.burst, { delay: 6 });
      await expect.poll(() => page.evaluate(() => {
        const probe = (window as unknown as StressWindow).__stressProbe!.snapshot();
        return probe.samples.filter((sample) => sample.afterFrameAt !== null).length;
      }), { timeout: 10_000 }).toBeGreaterThanOrEqual(config.burst.length - 1);
      await page.waitForTimeout(100);
      await page.evaluate(() => (window as unknown as StressWindow).__stressProbe!.finishTyping());

      const immediate = await page.evaluate(() => (window as unknown as StressWindow).__stressProbe!.snapshot());
      expect(immediate.samples.map((sample) => sample.data).join('')).toBe(config.burst);
      expect(immediate.samples.filter((sample) => sample.afterFrameAt !== null)).toHaveLength(config.burst.length);
      expect(immediate.samples).toHaveLength(config.burst.length);
      expect(immediate.dispatches.docChanged).toBe(config.burst.length);
      expect(immediate.dispatches.nonDoc).toBe(0);

      const rafLatency = immediate.samples.map((sample) => sample.rafAt! - sample.keydownAt);
      const frameLatency = immediate.samples.map((sample) => sample.afterFrameAt! - sample.keydownAt);
      const inputLatency = immediate.samples
        .filter((sample) => sample.inputAt !== null)
        .map((sample) => sample.inputAt! - (sample.beforeInputAt ?? sample.keydownAt));
      const rafP95 = percentile(rafLatency, 0.95);
      const frameP95 = percentile(frameLatency, 0.95);
      const inputP95 = percentile(inputLatency, 0.95);
      expect(rafP95).toBeLessThan(P95_RAF_CEILING_MS);
      expect(frameP95).toBeLessThan(P95_RAF_CEILING_MS);
      expect(inputP95).toBeLessThan(P95_EVENT_CEILING_MS);
      expect(inputLatency.length).toBeGreaterThanOrEqual(config.burst.length - 1);
      if (immediate.eventDurations.length) {
        expect(percentile(immediate.eventDurations, 0.95)).toBeLessThan(P95_RAF_CEILING_MS);
      }

      expect(
        immediate.samples.flatMap((sample, index) => sample.lineWidgetsAtRaf
          ? [{ index, data: sample.data, beforeInput: sample.beforeInputAt !== null, widgets: sample.lineWidgetsAtRaf }]
          : []),
      ).toEqual([]);

      for (const sample of immediate.samples) {
        expect(sample.data).toHaveLength(1);
        expect(sample.domMatchesStateAtRaf).toBe(true);
        expect(sample.layoutAtRaf!.lines - sample.layoutBefore.lines).toBe(0);
        expect(sample.layoutAtRaf!.pageMarks - sample.layoutBefore.pageMarks).toBe(0);
        expect(sample.compilerAtRaf!.succeeded - sample.compilerBefore.succeeded).toBe(0);
        expect(sample.compilerAtRaf!.failed - sample.compilerBefore.failed).toBe(0);
      }

      const expectedActive =
        active.activeText.slice(0, active.caretOffset) +
        config.burst +
        active.activeText.slice(active.caretOffset);
      await assertDocumentSourcesConverged(page, expectedActive);

      const settled = await waitForCurrentSnapshot(page, baseline.revision);
      expect(settled.revision).toBeGreaterThan(baseline.revision);
      expect(settled.sourceMatches).toBe(true);
      expect(settled.blocks).toBeGreaterThan(config.paragraphs);
      expect(settled.pages).toBeGreaterThan(1);
      await assertDocumentSourcesConverged(page, expectedActive);

      // Require a stable idle observation, not a momentary empty queue between
      // revisions. The current serialized document must still address the
      // same immutable snapshot after another rendering opportunity.
      await page.waitForTimeout(100);
      const stable = await currentSnapshot(page);
      expect(stable).toMatchObject({
        status: 'ok',
        revision: settled.revision,
        sourceMatches: true,
        idle: true,
      });

      const finalProbe = await page.evaluate(() => {
        const probe = (window as unknown as StressWindow).__stressProbe!;
        const snapshot = probe.snapshot();
        probe.stop();
        return snapshot;
      });
      expect(finalProbe.maxQueueDepth).toBeLessThanOrEqual(MAX_LOCAL_COMPILER_DEPTH);
      console.log(
        `[stress] ${config.paragraphs} paragraphs / ${config.activeChars} active chars / ` +
        `${config.burst.length} keys: rAF p95=${rafP95.toFixed(1)}ms, ` +
        `after-frame p95=${frameP95.toFixed(1)}ms, input p95=${inputP95.toFixed(1)}ms, ` +
        `queue max=${finalProbe.maxQueueDepth}, snapshot r${settled.revision} ` +
        `(${settled.blocks} blocks, ${settled.pages} pages)`,
      );
    });
  }
});

test('proof view exposes a stable accessible dialog and returns focus without toolbar integration', async ({ page }) => {
  await openStableDevPage(page);
  const editor = page.locator('.ProseMirror[contenteditable="true"]');
  await editor.focus();
  await page.evaluate(async () => {
    const w = window as unknown as StressWindow;
    const { openProofView } = await import('/src/proof-view.ts');
    w.__proofRun = openProofView(w.view.state.doc, { documentName: 'Acceptance proof' }).catch(() => {});
  });

  const dialog = page.getByRole('dialog', { name: 'Exact Typst proof' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(dialog.getByRole('status')).not.toHaveText('');
  const close = dialog.getByRole('button', { name: 'Back to editing' });
  await expect(close).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(editor).toBeFocused();
  await expect.poll(() => page.evaluate(async () => {
    const { proofViewOpen } = await import('/src/proof-view.ts');
    return proofViewOpen();
  })).toBe(false);
});
