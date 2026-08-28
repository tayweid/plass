import { expect, test, type Page } from 'playwright/test';

const PRESENTATION_CEILING_MS = 250;
const LONG_PARAGRAPH_CHARS = 5_000;

interface DispatchCounts {
  total: number;
  docChanged: number;
  nonDoc: number;
}

interface EventRecord {
  type: string;
  data: string | null;
  inputType: string | null;
  isComposing: boolean;
}

interface EventTimingRecord {
  name: string;
  duration: number;
  interactionId: number;
}

interface PresentationSnapshot {
  startedAt: number | null;
  firstRafMs: number | null;
  afterFrameMs: number | null;
  events: EventRecord[];
  eventTimings: EventTimingRecord[];
  dispatches: DispatchCounts;
  atPresentation: null | {
    domText: string;
    stateText: string;
    lineWidgets: number;
    wordSpacedRuns: number;
    forcedLineLock: boolean;
    whiteSpace: string;
    lineDispatches: number;
    pageMarkDispatches: number;
    dispatches: DispatchCounts;
  };
}

interface BrowserProbeState {
  armed: boolean;
  keyDownAt: number | null;
  startedAt: number | null;
  firstRafAt: number | null;
  afterFrameAt: number | null;
  events: EventRecord[];
  eventTimings: EventTimingRecord[];
  dispatches: DispatchCounts;
  baseline: null | {
    lines: number;
    pageMarks: number;
  };
  atPresentation: PresentationSnapshot['atPresentation'];
}

interface TypingLatencyProbe {
  state: BrowserProbeState;
  arm(): void;
  snapshot(): PresentationSnapshot;
}

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __breakSig: () => string;
    __layoutDispatchStats: (reset?: boolean) => { lines: number; pageMarks: number };
    __typingLatencyProbe?: TypingLatencyProbe;
  }
}

function longParagraph(chars = LONG_PARAGRAPH_CHARS): string {
  const seed =
    'Responsive editing must paint the character before publication layout recomputes the paragraph. ';
  return seed.repeat(Math.ceil(chars / seed.length)).slice(0, chars);
}

async function setLaidOutParagraph(page: Page, text: string): Promise<number> {
  const caretOffset = Math.floor(text.length / 2);
  await page.evaluate(
    (text) => {
      const { state } = window.view;
      const paragraph = state.schema.nodes.paragraph.create(null, state.schema.text(text));
      const doc = state.schema.nodes.doc.create(state.doc.attrs, [paragraph]);
      window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, doc.content));
    },
    text,
  );

  const paragraph = page.locator('.ProseMirror > p').first();
  await expect(paragraph).toBeVisible();
  // This makes the paint-first assertion meaningful: the edit starts from an
  // already-typeset block whose forced line presentation must be removed.
  await expect
    .poll(() => paragraph.locator('.ts-br, .ts-hyphen').count(), { timeout: 15_000 })
    .toBeGreaterThan(0);

  // Place the caret after the initial exact pass. Doing this before the pass
  // leaves a small race between the PM selection and the native DOM selection
  // when the line-decoration DOM is rebuilt.
  await page.evaluate((caretOffset) => {
    const { state } = window.view;
    const selectionType = state.selection.constructor as unknown as {
      create(doc: typeof state.doc, from: number, to?: number): typeof state.selection;
    };
    window.view.dispatch(
      state.tr.setSelection(selectionType.create(state.doc, caretOffset + 1)).scrollIntoView(),
    );
    window.view.focus();
  }, caretOffset);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const selection = window.getSelection();
        if (!selection?.anchorNode) return -1;
        try {
          return window.view.posAtDOM(selection.anchorNode, selection.anchorOffset);
        } catch {
          return -1;
        }
      }),
    )
    .toBe(caretOffset + 1);
  return caretOffset;
}

async function installTypingLatencyProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (window.__typingLatencyProbe) return;

    const emptyDispatches = (): DispatchCounts => ({ total: 0, docChanged: 0, nonDoc: 0 });
    const state: BrowserProbeState = {
      armed: false,
      keyDownAt: null,
      startedAt: null,
      firstRafAt: null,
      afterFrameAt: null,
      events: [],
      eventTimings: [],
      dispatches: emptyDispatches(),
      baseline: null,
      atPresentation: null,
    };

    const originalDispatch = window.view.dispatch.bind(window.view);
    window.view.dispatch = ((transaction) => {
      if (state.armed && state.startedAt !== null) {
        state.dispatches.total++;
        if (transaction.docChanged) state.dispatches.docChanged++;
        else state.dispatches.nonDoc++;
      }
      originalDispatch(transaction);
    }) as typeof window.view.dispatch;

    const recordEvent = (event: Event) => {
      if (!state.armed) return;
      const input = event instanceof InputEvent ? event : null;
      const composition = event instanceof CompositionEvent ? event : null;
      state.events.push({
        type: event.type,
        data: input?.data ?? composition?.data ?? null,
        inputType: input?.inputType ?? null,
        isComposing: input?.isComposing ?? event.type.startsWith('composition'),
      });
    };

    const beginPresentation = () => {
      if (!state.armed || state.startedAt !== null) return;
      state.startedAt = state.keyDownAt ?? performance.now();
      state.dispatches = emptyDispatches();
      const layout = window.__layoutDispatchStats();
      state.baseline = {
        lines: layout.lines,
        pageMarks: layout.pageMarks,
      };

      requestAnimationFrame(() => {
        state.firstRafAt = performance.now();
        const paragraph = window.view.dom.querySelector(':scope > p') ?? window.view.dom.querySelector('p');
        const layoutNow = window.__layoutDispatchStats();
        const spacedRuns = paragraph
          ? [...paragraph.querySelectorAll<HTMLElement>('[style]')].filter((node) => node.style.wordSpacing)
              .length
          : 0;
        state.atPresentation = {
          domText: paragraph?.textContent ?? '',
          stateText: window.view.state.doc.firstChild?.textContent ?? '',
          lineWidgets: paragraph?.querySelectorAll('.ts-br, .ts-hyphen').length ?? 0,
          wordSpacedRuns: spacedRuns,
          forcedLineLock: paragraph?.classList.contains('ts-forced-lines') ?? false,
          whiteSpace: paragraph ? getComputedStyle(paragraph).whiteSpace : '',
          lineDispatches: layoutNow.lines - state.baseline!.lines,
          pageMarkDispatches: layoutNow.pageMarks - state.baseline!.pageMarks,
          dispatches: { ...state.dispatches },
        };

        // A task posted from rAF runs after the browser has completed that
        // rendering opportunity. This gives a practical presentation upper
        // bound, while the structural assertions below make timing robust on
        // loaded CI machines.
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          state.afterFrameAt = performance.now();
          channel.port1.close();
          channel.port2.close();
        };
        channel.port2.postMessage(null);
      });
    };

    window.view.dom.addEventListener(
      'keydown',
      (event) => {
        if (state.armed && state.keyDownAt === null) state.keyDownAt = event.timeStamp;
        recordEvent(event);
      },
      true,
    );
    window.view.dom.addEventListener(
      'compositionstart',
      (event) => recordEvent(event),
      true,
    );
    window.view.dom.addEventListener(
      'compositionupdate',
      (event) => {
        recordEvent(event);
        beginPresentation();
      },
      true,
    );
    window.view.dom.addEventListener(
      'compositionend',
      (event) => recordEvent(event),
      true,
    );
    window.view.dom.addEventListener(
      'beforeinput',
      (event) => {
        recordEvent(event);
        beginPresentation();
      },
      true,
    );
    window.view.dom.addEventListener(
      'input',
      (event) => {
        recordEvent(event);
        // Defensive fallback for engines/protocol input paths that omit
        // beforeinput while still producing a real contenteditable mutation.
        beginPresentation();
      },
      true,
    );

    if ('PerformanceObserver' in window) {
      try {
        const observer = new PerformanceObserver((list) => {
          if (!state.armed) return;
          for (const entry of list.getEntries() as PerformanceEventTiming[]) {
            if (state.startedAt !== null && entry.startTime + 0.01 < state.startedAt) continue;
            state.eventTimings.push({
              name: entry.name,
              duration: entry.duration,
              interactionId: entry.interactionId,
            });
          }
        });
        observer.observe({ type: 'event', buffered: true, durationThreshold: 16 });
      } catch {
        // Event Timing is supplementary. The rAF/after-frame markers and
        // structural pre-paint assertions remain available in every Chromium.
      }
    }

    window.__typingLatencyProbe = {
      state,
      arm() {
        state.armed = true;
        state.keyDownAt = null;
        state.startedAt = null;
        state.firstRafAt = null;
        state.afterFrameAt = null;
        state.events = [];
        state.eventTimings = [];
        state.dispatches = emptyDispatches();
        state.baseline = null;
        state.atPresentation = null;
        window.__layoutDispatchStats(true);
      },
      snapshot() {
        return {
          startedAt: state.startedAt,
          firstRafMs:
            state.startedAt !== null && state.firstRafAt !== null
              ? state.firstRafAt - state.startedAt
              : null,
          afterFrameMs:
            state.startedAt !== null && state.afterFrameAt !== null
              ? state.afterFrameAt - state.startedAt
              : null,
          events: state.events.map((event) => ({ ...event })),
          eventTimings: state.eventTimings
            .filter((entry) => ['keydown', 'keypress', 'keyup', 'beforeinput', 'input'].includes(entry.name))
            .map((entry) => ({ ...entry })),
          dispatches: { ...state.dispatches },
          atPresentation: state.atPresentation
            ? {
                ...state.atPresentation,
                dispatches: { ...state.atPresentation.dispatches },
              }
            : null,
        };
      },
    };
  });
}

async function armProbe(page: Page): Promise<void> {
  await page.evaluate(() => window.__typingLatencyProbe!.arm());
}

async function firstPresentation(page: Page): Promise<PresentationSnapshot> {
  await page.waitForFunction(
    () => window.__typingLatencyProbe?.state.afterFrameAt !== null,
    undefined,
    { timeout: 3_000 },
  );
  return page.evaluate(() => window.__typingLatencyProbe!.snapshot());
}

function expectPaintFirst(
  snapshot: PresentationSnapshot,
  { maxWordSpacedRuns = 0 }: { maxWordSpacedRuns?: number } = {},
): void {
  expect(snapshot.startedAt).not.toBeNull();
  expect(snapshot.firstRafMs).not.toBeNull();
  expect(snapshot.afterFrameMs).not.toBeNull();
  expect(snapshot.firstRafMs!).toBeLessThan(PRESENTATION_CEILING_MS);
  expect(snapshot.afterFrameMs!).toBeLessThan(PRESENTATION_CEILING_MS);

  const atPresentation = snapshot.atPresentation;
  expect(atPresentation).not.toBeNull();
  // These are the non-flaky core of the regression contract: regardless of
  // machine speed, no compiled layout transaction may run
  // before the browser gets its first opportunity to present the mutation.
  expect(atPresentation!.lineDispatches).toBe(0);
  expect(atPresentation!.pageMarkDispatches).toBe(0);
  expect(atPresentation!.dispatches.nonDoc).toBe(0);
  expect(atPresentation!.lineWidgets).toBe(0);
  expect(atPresentation!.forcedLineLock).toBe(false);
  expect(atPresentation!.whiteSpace).not.toBe('nowrap');
  // ProseMirror temporarily protects the active IME composition DOM node.
  // That node may retain its one mapped inline style until compositionend;
  // every non-composition run and every forced break must still be gone.
  expect(atPresentation!.wordSpacedRuns).toBeLessThanOrEqual(maxWordSpacedRuns);

  for (const timing of snapshot.eventTimings) {
    expect(timing.duration).toBeLessThan(PRESENTATION_CEILING_MS);
  }
}

test('a real key paints a 5k-character active paragraph before exact layout', async ({ page }) => {
  await page.goto('/?new=1');
  const text = longParagraph();
  const caretOffset = await setLaidOutParagraph(page, text);
  await installTypingLatencyProbe(page);
  await armProbe(page);

  await page.keyboard.type('Z');
  const presentation = await firstPresentation(page);

  expectPaintFirst(presentation);
  expect(presentation.events.some((event) => event.type === 'keydown')).toBe(true);
  expect(
    presentation.events.some(
      (event) => event.type === 'beforeinput' && event.inputType === 'insertText' && event.data === 'Z',
    ),
  ).toBe(true);
  expect(presentation.atPresentation!.dispatches.docChanged).toBe(1);
  const expected = text.slice(0, caretOffset) + 'Z' + text.slice(caretOffset);
  expect(presentation.atPresentation!.domText).toBe(expected);
  expect(presentation.atPresentation!.stateText).toBe(expected);

  // The quiet pass first publishes the native pending state, then the exact
  // revision restores line presentation. A multipage paragraph may need one
  // additional page-spacer correction; none may replay the document edit.
  await expect
    .poll(() => page.locator('.ProseMirror > p .ts-br, .ProseMirror > p .ts-hyphen').count(), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
  await expect(page.locator('.ProseMirror > p').first()).toHaveClass(/ts-forced-lines/);
  expect(await page.locator('.ProseMirror > p').first().evaluate((node) => getComputedStyle(node).whiteSpace))
    .toBe('nowrap');
  const settled = await page.evaluate(() => ({
    layout: window.__layoutDispatchStats(),
    probe: window.__typingLatencyProbe!.snapshot(),
  }));
  expect(settled.layout.lines).toBeGreaterThanOrEqual(1);
  expect(settled.layout.lines).toBeLessThanOrEqual(3);
  expect(settled.probe.dispatches.docChanged).toBe(1);
});

test('IME composition paints provisional text before exact layout and commits cleanly', async ({ page }) => {
  await page.goto('/?new=1');
  const text = longParagraph(2_000);
  const caretOffset = await setLaidOutParagraph(page, text);
  await installTypingLatencyProbe(page);
  await armProbe(page);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', {
    text: '漢字',
    selectionStart: 2,
    selectionEnd: 2,
  });
  const presentation = await firstPresentation(page);

  expectPaintFirst(presentation, { maxWordSpacedRuns: 1 });
  expect(presentation.events.some((event) => event.type === 'compositionstart')).toBe(true);
  expect(
    presentation.events.some(
      (event) => event.type === 'beforeinput' && event.inputType === 'insertCompositionText',
    ),
  ).toBe(true);
  expect(presentation.atPresentation!.domText).toContain('漢字');
  expect(presentation.atPresentation!.dispatches.docChanged).toBeLessThanOrEqual(1);

  await cdp.send('Input.insertText', { text: '漢字' });
  const expected = text.slice(0, caretOffset) + '漢字' + text.slice(caretOffset);
  await expect.poll(() => page.evaluate(() => window.view.state.doc.textContent)).toBe(expected);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__typingLatencyProbe!.state.events.some((event) => event.type === 'compositionend'),
      ),
    )
    .toBe(true);

  const committed = await page.evaluate(() => window.__typingLatencyProbe!.snapshot());
  expect(committed.dispatches.docChanged).toBeGreaterThanOrEqual(1);
  expect(committed.dispatches.docChanged).toBeLessThanOrEqual(2);
  expect(await page.locator('.ProseMirror > p').first().textContent()).toBe(expected);

  await expect
    .poll(() => page.locator('.ProseMirror > p .ts-br, .ProseMirror > p .ts-hyphen').count(), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
  await expect(page.locator('.ProseMirror > p').first()).toHaveClass(/ts-forced-lines/);
  const settled = await page.evaluate(() => ({
    layout: window.__layoutDispatchStats(),
    dispatches: window.__typingLatencyProbe!.snapshot().dispatches,
  }));
  expect(settled.layout.lines).toBeGreaterThanOrEqual(1);
  expect(settled.layout.lines).toBeLessThanOrEqual(2);
  expect(settled.dispatches.docChanged).toBeGreaterThanOrEqual(1);
  expect(settled.dispatches.docChanged).toBeLessThanOrEqual(2);
});
