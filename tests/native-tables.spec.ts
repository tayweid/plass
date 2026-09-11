import { expect, test } from 'playwright/test';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __pagLog: () => string[];
    __pagCount: () => number;
    __pageOracle: unknown;
    __nativeTableProofGeometry: () => Promise<{ widthPt: number; heightPt: number }>;
    __tableHotPathProbe?: {
      afterFirstPaint: boolean;
      geometryAfterPaint: number;
      finish(): {
        labelsReused: boolean;
        geometryBeforePaint: string[];
        geometryAfterPaint: string[];
        publicationsBeforePaint: string[];
        publicationsAfterPaint: string[];
      };
    };
  }
}

async function installRichTable(page: import('playwright/test').Page) {
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!window.view);
  await page.evaluate(() => {
    const { state } = window.view;
    const s = state.schema;
    const paragraph = s.nodes.paragraph;
    const cell = (text: string) => s.nodes.table_cell.create(null, paragraph.create(null, text ? s.text(text) : undefined));
    const rich = s.nodes.table_cell.create(null, [
      paragraph.create(null, [
        s.text('Marked', [s.marks.strong.create()]),
        s.text(' math '),
        s.nodes.math_inline.create({ src: 'x^2' }),
        s.text(' cite '),
        s.nodes.citation.create({ key: 'knuth86' }),
      ]),
      paragraph.create(null, s.text('Second paragraph', [s.marks.em.create()])),
    ]);
    const table = s.nodes.table.create(
      { style: 'booktabs', caption: '', label: '' },
      [
        s.nodes.table_row.create(null, [rich, cell('B')]),
        s.nodes.table_row.create(null, [cell('C'), cell('D')]),
      ],
    );
    const tr = state.tr
      .setDocAttribute('bib', {
        name: 'refs.bib',
        content: '@book{knuth86, title={The TeXbook}, author={Knuth, Donald E.}, year={1986}}',
      })
      .replaceWith(0, state.doc.content.size, table)
      .setMeta('addToHistory', false);
    window.view.dispatch(tr);
  });
}

async function installPaginationTable(
  page: import('playwright/test').Page,
  rowCount: number,
  navigate = true,
) {
  if (navigate) await page.goto('/?new=1');
  await page.waitForFunction(() => !!window.view && !!window.__pagLog && !!window.__pageOracle);
  return page.evaluate((rows) => {
    const { state } = window.view;
    const s = state.schema;
    const paragraph = (text: string) => s.nodes.paragraph.create(null, s.text(text));
    const cell = (text: string, header = false) =>
      (header ? s.nodes.table_header : s.nodes.table_cell).create(null, paragraph(text));
    const tableRows = [
      s.nodes.table_row.create(null, [cell('Item', true), cell('Value', true)]),
      ...Array.from({ length: rows - 1 }, (_, index) =>
        s.nodes.table_row.create(null, [cell(`Row ${index + 1}`), cell(String(index + 1))]),
      ),
    ];
    const table = s.nodes.table.create(
      { style: 'booktabs', caption: '', label: '', params: '', fontSize: '' },
      tableRows,
    );
    const logStart = window.__pagCount();
    window.view.dispatch(
      state.tr.replaceWith(0, state.doc.content.size, table).setMeta('addToHistory', false),
    );
    return logStart;
  }, rowCount);
}

test('rich table cells edit directly, navigate with Tab, and undo without flattening', async ({ page }) => {
  await installRichTable(page);
  const nativeTable = page.locator('.ProseMirror table');
  await expect(nativeTable).toBeVisible();
  await expect(page.locator('.ts-table-block, .table-card-overlay')).toHaveCount(0);

  const firstParagraph = nativeTable.locator('td').first().locator('p').first();
  await firstParagraph.click();
  await page.keyboard.press('End');
  await page.keyboard.type('!');

  const richShape = await page.evaluate(() => {
    const table = window.view.state.doc.child(0);
    const cell = table.child(0).child(0);
    const inline: string[] = [];
    cell.descendants((node) => {
      if (node.isInline) inline.push(node.type.name);
      return true;
    });
    return {
      text: cell.textContent,
      paragraphs: cell.childCount,
      firstMarks: cell.child(0).child(0).marks.map((mark) => mark.type.name),
      inline,
    };
  });
  expect(richShape.text).toContain('!');
  expect(richShape.paragraphs).toBe(2);
  expect(richShape.firstMarks).toContain('strong');
  expect(richShape.inline).toEqual(expect.arrayContaining(['math_inline', 'citation']));

  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => {
    const $from = window.view.state.selection.$from;
    for (let depth = $from.depth; depth > 0; depth--) {
      const node = $from.node(depth);
      if (node.type.spec.tableRole === 'cell') return node.textContent;
    }
    return '';
  })).toBe('B');
  await page.keyboard.press('Shift+Tab');

  await page.keyboard.press('ControlOrMeta+z');
  expect(await page.evaluate(() => window.view.state.doc.child(0).child(0).child(0).textContent)).not.toContain('!');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  expect(await page.evaluate(() => window.view.state.doc.child(0).child(0).child(0).textContent)).toContain('!');
});

test('native table keystrokes map numbering and read no contextual geometry', async ({ page }) => {
  await installRichTable(page);
  const paragraph = page.locator('.ProseMirror td').first().locator('p').first();
  await paragraph.click();
  await page.keyboard.press('End');
  await expect(page.getByRole('toolbar', { name: 'Table controls' })).toBeVisible();
  // Let the selection-triggered initial placement finish. The probe below is
  // scoped to the subsequent real contenteditable input transaction.
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));

  await page.evaluate(() => {
    const equations = window.view.state.plugins.find((plugin) => plugin.key.startsWith('equations$'));
    if (!equations) throw new Error('live equations plugin is unavailable');
    const labelsBefore = (equations.getState(window.view.state) as { labels?: Map<string, string> } | undefined)?.labels;
    const geometry: Array<{ phase: string; kind: string }> = [];
    const publications: Array<{ phase: string; target: string }> = [];
    let started = false;
    let phase = 'idle';

    const relevant = (element: Element): string | null => {
      if (element.matches('.native-table-toolbar') || element.closest('.native-table-toolbar')) {
        return 'native-controls';
      }
      if (element.matches('#toolbar') || element.closest('#toolbar')) return 'main-toolbar';
      if (element.matches('.ProseMirror table')) return 'native-table';
      return null;
    };
    const recordGeometry = (element: Element, kind: string) => {
      const target = relevant(element);
      if (started && target) geometry.push({ phase, kind: `${target}:${kind}` });
    };

    const rect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      recordGeometry(this, 'getBoundingClientRect');
      return rect.call(this);
    };
    const patched: Array<{ name: string; descriptor: PropertyDescriptor }> = [];
    for (const name of ['offsetWidth', 'offsetHeight', 'offsetLeft'] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
      if (!descriptor?.get) continue;
      patched.push({ name, descriptor });
      Object.defineProperty(HTMLElement.prototype, name, {
        configurable: true,
        enumerable: descriptor.enumerable,
        get() {
          recordGeometry(this, name);
          return descriptor.get!.call(this);
        },
      });
    }

    const observer = new MutationObserver((records) => {
      if (!started) return;
      for (const record of records) {
        if (record.type !== 'attributes' || record.attributeName !== 'style') continue;
        const element = record.target as Element;
        const target = relevant(element);
        if (target === 'native-controls' || target === 'main-toolbar') {
          publications.push({ phase, target });
        }
      }
    });
    const nativeControls = document.querySelector('.native-table-toolbar');
    const mainToolbar = document.querySelector('#toolbar');
    if (nativeControls) observer.observe(nativeControls, { attributes: true, subtree: true });
    if (mainToolbar) observer.observe(mainToolbar, { attributes: true, subtree: true });

    const begin = () => {
      if (started) return;
      started = true;
      phase = 'before-first-paint';
      requestAnimationFrame(() => {
        // A task posted from rAF runs after that rendering opportunity. Any
        // control read in this rAF is still charged to the first text paint.
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          phase = 'after-first-paint';
          window.__tableHotPathProbe!.afterFirstPaint = true;
          channel.port1.close();
          channel.port2.close();
        };
        channel.port2.postMessage(null);
      });
    };
    window.view.dom.addEventListener('beforeinput', begin, { capture: true, once: true });

    window.__tableHotPathProbe = {
      afterFirstPaint: false,
      get geometryAfterPaint() {
        return geometry.filter((entry) => entry.phase === 'after-first-paint').length;
      },
      finish() {
        observer.disconnect();
        Element.prototype.getBoundingClientRect = rect;
        for (const entry of patched) {
          Object.defineProperty(HTMLElement.prototype, entry.name, entry.descriptor);
        }
        const beforeGeometry = geometry
          .filter((entry) => entry.phase === 'before-first-paint')
          .map((entry) => entry.kind);
        const afterGeometry = geometry
          .filter((entry) => entry.phase === 'after-first-paint')
          .map((entry) => entry.kind);
        return {
          labelsReused:
            (equations.getState(window.view.state) as { labels?: Map<string, string> } | undefined)?.labels ===
            labelsBefore,
          geometryBeforePaint: beforeGeometry,
          geometryAfterPaint: afterGeometry,
          publicationsBeforePaint: publications
            .filter((entry) => entry.phase === 'before-first-paint')
            .map((entry) => entry.target),
          publicationsAfterPaint: publications
            .filter((entry) => entry.phase === 'after-first-paint')
            .map((entry) => entry.target),
        };
      },
    };
  });

  await page.keyboard.type('Z');
  await expect.poll(() => page.evaluate(() => window.__tableHotPathProbe?.afterFirstPaint)).toBe(true);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const snapshot = await page.evaluate(() => window.__tableHotPathProbe!.finish());

  expect(snapshot.labelsReused).toBe(true);
  // The contextual controls are docked chrome: a keystroke in a cell reads
  // no geometry for them or the main toolbar, before or after the paint,
  // and publishes no position. (ProseMirror may still read the table to
  // keep the caret scrolled into view.)
  const chrome = (entries: string[]) => entries.filter((entry) => entry.startsWith('native-controls:') || entry.startsWith('main-toolbar:'));
  expect(chrome(snapshot.geometryBeforePaint)).toEqual([]);
  expect(chrome(snapshot.geometryAfterPaint)).toEqual([]);
  expect(snapshot.publicationsBeforePaint).toEqual([]);
  expect(snapshot.publicationsAfterPaint).toEqual([]);
});

test('a table grows under the keyboard and lets the caret out at its edges', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    window.view.dispatch(state.tr.insertText('Before the table.', 1));
    window.view.focus();
  });
  await page.keyboard.press('End');
  await page.keyboard.press('ControlOrMeta+Alt+t');
  await expect(page.locator('.ProseMirror table')).toHaveCount(1);
  // The caret is in the first (empty) header cell.
  await page.keyboard.type('Name');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Score');
  // Enter moves down a row, same column; Tab from the last cell adds a row.
  await page.keyboard.press('Enter');
  await page.keyboard.type('12');
  await page.keyboard.press('Tab');
  await page.keyboard.type('x');
  await page.keyboard.press('Tab');
  await page.keyboard.type('y');
  await page.keyboard.press('Tab');
  await page.keyboard.type('z');
  await page.keyboard.press('Tab');
  await page.keyboard.type('new row');
  const shape = await page.evaluate(() => {
    const table = window.view.state.doc.child(1);
    const rows: string[][] = [];
    table.forEach((row) => {
      const cells: string[] = [];
      row.forEach((cell) => cells.push(cell.textContent));
      rows.push(cells);
    });
    return rows;
  });
  expect(shape).toEqual([
    ['Name', 'Score', ''],
    ['', '12', 'x'],
    ['y', 'z', 'new row'],
  ]);
  // Enter on the last row adds one more; ArrowDown from it leaves the table
  // into a fresh paragraph (the table ended the document).
  await page.keyboard.press('Enter');
  await page.keyboard.type('last');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('After the table.');
  const blocks = await page.evaluate(() => {
    const out: string[] = [];
    window.view.state.doc.forEach((n) => out.push(`${n.type.name}:${n.type.name === 'table' ? n.childCount : n.textContent}`));
    return out;
  });
  expect(blocks).toEqual(['paragraph:Before the table.', 'table:4', 'paragraph:After the table.']);
  // ArrowUp from the first row goes back to the paragraph before it.
  await page.evaluate(() => {
    const table = window.view.state.doc.child(1);
    const pos = window.view.state.doc.child(0).nodeSize + 3;
    window.view.dispatch(window.view.state.tr.setSelection(window.view.state.selection.constructor.near(window.view.state.doc.resolve(pos), 1)));
    return table.childCount;
  });
  await page.keyboard.press('ArrowUp');
  // Where in that paragraph the caret lands follows the caret's x (the
  // geometric motion); the block is what matters here.
  expect(await page.evaluate(() => {
    const { $from } = window.view.state.selection;
    return $from.depth === 1 && $from.index(0) === 0 && $from.parent.type.name === 'paragraph';
  })).toBe(true);
  // The docked controls never cover the document: the fixed bar ends above
  // where the page starts (in document coordinates — the test has scrolled).
  const covers = await page.evaluate(() => {
    const bar = document.querySelector('.native-table-toolbar')!.getBoundingClientRect();
    const page1 = document.querySelector('.ProseMirror')!.getBoundingClientRect();
    return bar.bottom > page1.top + window.scrollY + 1;
  });
  expect(covers).toBe(false);
});

test('cell density presets match Typst row heights exactly', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!window.view);
  const results: Array<{ density: string; nativePt: number; compiledPt: number }> = [];
  for (const density of ['compact', '', 'roomy']) {
    await page.evaluate((density) => {
      const { state } = window.view;
      const s = state.schema;
      const paragraph = (text = '') => s.nodes.paragraph.create(null, text ? s.text(text) : undefined);
      const cell = (text: string, header: boolean) =>
        (header ? s.nodes.table_header : s.nodes.table_cell).create(null, paragraph(text));
      const table = s.nodes.table.create(
        { style: 'booktabs', caption: '', label: '', params: '', fontSize: '', density },
        [
          s.nodes.table_row.create(null, [cell('Item', true), cell('Value', true), cell('Note', true)]),
          s.nodes.table_row.create(null, [cell('alpha', false), cell('1.5', false), cell('one line', false)]),
          s.nodes.table_row.create(null, [
            cell('beta', false),
            cell('', false),
            s.nodes.table_cell.create(null, s.nodes.paragraph.create(null, [s.text('two'), s.nodes.hard_break.create(), s.text('lines')])),
          ]),
          s.nodes.table_row.create(null, [cell('', false), cell('', false), cell('', false)]),
        ],
      );
      window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, table).setMeta('addToHistory', false));
    }, density);
    await page.evaluate(() => document.fonts.ready);
    const r = await page.evaluate(async () => {
      const table = document.querySelector<HTMLElement>('.ProseMirror table')!;
      const proof = await window.__nativeTableProofGeometry();
      return { nativePt: table.getBoundingClientRect().height * 0.75, compiledPt: proof.heightPt };
    });
    results.push({ density, ...r });
  }
  // Compact rows are shorter than normal, normal than roomy; every table is
  // the height Typst prints, within a tenth of a point per row.
  expect(results[0].nativePt).toBeLessThan(results[1].nativePt);
  expect(results[1].nativePt).toBeLessThan(results[2].nativePt);
  for (const r of results) expect(Math.abs(r.nativePt - r.compiledPt), JSON.stringify(results)).toBeLessThan(0.5);
});

test('the Rule control cycles a row rule that paints in the page and exports at its boundary', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    window.view.dispatch(state.tr.insertText('Before.', 1));
    window.view.focus();
  });
  await page.keyboard.press('End');
  await page.keyboard.press('ControlOrMeta+Alt+t');
  await expect(page.locator('.ProseMirror table')).toHaveCount(1);
  await page.keyboard.type('H');
  await page.keyboard.press('Enter'); // row 2
  await page.keyboard.type('body');
  const rule = page.getByRole('toolbar', { name: 'Table controls' }).getByRole('button', { name: /^Rule under/ });
  await expect(rule).toHaveText('Rule');
  const shadow = () => page.evaluate(() => getComputedStyle(document.querySelectorAll('.ProseMirror tr')[1].querySelector('td')!).boxShadow);
  expect(await shadow()).toBe('none');
  await rule.click();
  await expect(rule).toHaveText('Rule: light');
  expect(await page.evaluate(() => document.querySelectorAll('.ProseMirror tr')[1].getAttribute('data-rule'))).toBe('light');
  expect(await shadow()).not.toBe('none');
  await rule.click();
  await expect(rule).toHaveText('Rule: heavy');
  await rule.click();
  await expect(rule).toHaveText('Rule: none');
  await rule.click();
  await expect(rule).toHaveText('Rule');
  await rule.click(); // light again, for the export
  const typ = await page.evaluate(async () => {
    const { docToTyp } = await import('/src/typ-serializer.ts');
    return docToTyp(window.view.state.doc);
  });
  expect(typ).toContain('table.hline(y: 2, stroke: 0.05em)');
  // Grid tables draw cell strokes; the control is disabled there.
  await page.getByRole('toolbar', { name: 'Table controls' }).getByRole('combobox', { name: 'Table rule style' }).selectOption('grid');
  await expect(rule).toBeDisabled();
});

test('default native table uses the intrinsic centered Typst box model', async ({ page }) => {
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!window.view);
  await page.evaluate(() => {
    const { state } = window.view;
    const s = state.schema;
    const paragraph = (text = '') => s.nodes.paragraph.create(null, text ? s.text(text) : undefined);
    const cell = (text: string, header: boolean) =>
      (header ? s.nodes.table_header : s.nodes.table_cell).create(null, paragraph(text));
    const table = s.nodes.table.create(
      { style: 'booktabs', caption: '', label: '', params: '', fontSize: '' },
      [
        s.nodes.table_row.create(null, [cell('Column 1', true), cell('Column 2', true), cell('Column 3', true)]),
        s.nodes.table_row.create(null, [cell('', false), cell('', false), cell('', false)]),
        s.nodes.table_row.create(null, [cell('', false), cell('', false), cell('', false)]),
      ],
    );
    window.view.dispatch(
      state.tr.replaceWith(0, state.doc.content.size, table).setMeta('addToHistory', false),
    );
  });
  await page.evaluate(() => document.fonts.ready);
  const metrics = await page.evaluate(async () => {
    const table = document.querySelector<HTMLElement>('.ProseMirror table')!;
    const editor = document.querySelector<HTMLElement>('.ProseMirror')!;
    const header = table.querySelector<HTMLElement>('th')!;
    const bodyCell = table.querySelector<HTMLElement>('td')!;
    const tableRect = table.getBoundingClientRect();
    const editorRect = editor.getBoundingClientRect();
    const tableStyle = getComputedStyle(table);
    const editorStyle = getComputedStyle(editor);
    const headerStyle = getComputedStyle(header);
    const bodyStyle = getComputedStyle(bodyCell);

    // The hook belongs to the running app and therefore shares its compiler,
    // sanitizer, assets, and module instances. Tests must not dynamic-import
    // a second `/src/...` graph inside page.evaluate.
    const proof = await window.__nativeTableProofGeometry();

    return {
      nativeWidthPt: tableRect.width * 0.75,
      nativeHeightPt: tableRect.height * 0.75,
      compiledWidthPt: proof.widthPt,
      compiledHeightPt: proof.heightPt,
      centerDeltaPx: Math.abs(
        tableRect.left + tableRect.width / 2 - (editorRect.left + editorRect.width / 2),
      ),
      tableLineHeight: tableStyle.lineHeight,
      editorLineHeight: editorStyle.lineHeight,
      padding: [
        headerStyle.paddingTop,
        headerStyle.paddingRight,
        headerStyle.paddingBottom,
        headerStyle.paddingLeft,
      ].map(Number.parseFloat),
      emptyPadding: [
        bodyStyle.paddingTop,
        bodyStyle.paddingRight,
        bodyStyle.paddingBottom,
        bodyStyle.paddingLeft,
      ].map(Number.parseFloat),
      headerWeight: headerStyle.fontWeight,
      bodyWeight: bodyStyle.fontWeight,
    };
  });

  expect(metrics.centerDeltaPx).toBeLessThan(1);
  expect(metrics.tableLineHeight).toBe(metrics.editorLineHeight);
  expect(metrics.padding[0]).toBeCloseTo(0, 1);
  expect(metrics.padding[2]).toBeCloseTo(0, 1);
  expect(metrics.padding[1]).toBeCloseTo(5 * 4 / 3, 1);
  expect(metrics.padding[3]).toBeCloseTo(5 * 4 / 3, 1);
  for (const padding of metrics.emptyPadding) expect(padding).toBeCloseTo(5 * 4 / 3, 1);
  expect(metrics.headerWeight).toBe(metrics.bodyWeight);
  // Browser and Typst shape text independently, so glyph advances can vary a
  // little; the table boxes should nevertheless describe the same intrinsic
  // object. The former width:100% path missed by more than 100% here.
  expect(Math.abs(metrics.nativeWidthPt - metrics.compiledWidthPt) / metrics.compiledWidthPt)
    .toBeLessThan(0.2);
  expect(Math.abs(metrics.nativeHeightPt - metrics.compiledHeightPt) / metrics.compiledHeightPt)
    .toBeLessThan(0.08);
});

test('contextual controls mutate native structure and retain rich content', async ({ page }) => {
  await installRichTable(page);
  await page.locator('.ProseMirror td').first().click();
  const controls = page.getByRole('toolbar', { name: 'Table controls' });
  await expect(controls).toBeVisible();

  await page.getByRole('button', { name: 'Add row below' }).click();
  await expect(page.locator('.ProseMirror table tr')).toHaveCount(3);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.ProseMirror table tr')).toHaveCount(2);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(page.locator('.ProseMirror table tr')).toHaveCount(3);

  await page.getByRole('button', { name: 'Add column after' }).click();
  expect(await page.evaluate(() => window.view.state.doc.child(0).child(0).childCount)).toBe(3);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await page.evaluate(() => window.view.state.doc.child(0).child(0).childCount)).toBe(2);

  const firstCell = page.locator('.ProseMirror table tr').first().locator('td, th').first();
  const secondCell = page.locator('.ProseMirror table tr').first().locator('td, th').nth(1);
  await firstCell.click();
  await secondCell.click({ modifiers: ['Shift'] });
  await expect.poll(() => page.evaluate(() => window.view.state.selection.constructor.name)).toBe('CellSelection');
  await page.getByRole('button', { name: 'Merge selected cells' }).click();
  const mergedShape = await page.evaluate(() => {
    const cell = window.view.state.doc.child(0).child(0).child(0);
    const types: string[] = [];
    cell.descendants((node) => {
      if (node.isInline) types.push(node.type.name);
      return true;
    });
    return { colspan: cell.attrs.colspan, paragraphs: cell.childCount, types };
  });
  expect(mergedShape.colspan).toBe(2);
  expect(mergedShape.paragraphs).toBeGreaterThanOrEqual(3);
  expect(mergedShape.types).toEqual(expect.arrayContaining(['math_inline', 'citation']));

  await page.getByRole('button', { name: 'Split merged cell' }).click();
  expect(await page.evaluate(() => window.view.state.doc.child(0).child(0).child(0).attrs.colspan)).toBe(1);

  await page.locator('.ProseMirror table tr').nth(1).locator('td').first().click();
  await page.getByRole('button', { name: 'Toggle selected row as header' }).click();
  expect(await page.evaluate(() => window.view.state.doc.child(0).child(1).child(0).type.name)).toBe('table_header');

  await controls.locator('select[aria-label="Table rule style"]').selectOption('grid');
  await expect(page.locator('.ProseMirror table')).toHaveClass(/ts-table-grid/);
  await controls.locator('select[aria-label="Table text size"]').selectOption('0.85em');
  await page.getByRole('button', { name: 'Details' }).click();
  await controls.getByLabel('Caption').fill('Native results');
  await controls.getByLabel('Label').fill('tab:native');
  const nativeCaption = page.locator('.native-table-caption');
  await expect(nativeCaption).toHaveText('Table 1: Native results');
  const captionId = await nativeCaption.getAttribute('id');
  expect(captionId).toBeTruthy();
  await expect(page.locator('.ProseMirror table')).toHaveAttribute('aria-describedby', captionId!);
  await expect(nativeCaption).toHaveAttribute('role', 'note');

  const finalShape = await page.evaluate(() => {
    const table = window.view.state.doc.child(0);
    const cell = table.child(0).child(0);
    const types: string[] = [];
    cell.descendants((node) => {
      if (node.isInline) types.push(node.type.name);
      return true;
    });
    return {
      style: table.attrs.style,
      fontSize: table.attrs.fontSize,
      caption: table.attrs.caption,
      label: table.attrs.label,
      paragraphs: cell.childCount,
      types,
    };
  });
  expect(finalShape).toMatchObject({
    style: 'grid',
    fontSize: '0.85em',
    caption: 'Native results',
    label: 'tab:native',
    paragraphs: 3,
  });
  expect(finalShape.types).toEqual(expect.arrayContaining(['math_inline', 'citation']));
});

test('focused caption and label fields stay synchronized through undo and redo', async ({ page }) => {
  await installRichTable(page);
  await page.locator('.ProseMirror td').first().click();
  const controls = page.getByRole('toolbar', { name: 'Table controls' });
  await page.getByRole('button', { name: 'Details' }).click();

  const caption = controls.getByLabel('Caption');
  await caption.fill('Undoable caption');
  expect(await page.evaluate(() => window.view.state.doc.child(0).attrs.caption)).toBe('Undoable caption');
  await caption.press('ControlOrMeta+z');
  await expect(caption).toHaveValue('');
  expect(await page.evaluate(() => window.view.state.doc.child(0).attrs.caption)).toBe('');
  await caption.press('ControlOrMeta+Shift+z');
  await expect(caption).toHaveValue('Undoable caption');
  expect(await page.evaluate(() => window.view.state.doc.child(0).attrs.caption)).toBe('Undoable caption');

  // Keep the next metadata edit in its own history event, then exercise the
  // Windows/Linux redo chord that a focused native input would otherwise
  // consume without updating the ProseMirror document.
  await page.waitForTimeout(550);
  const label = controls.getByLabel('Label');
  await label.fill('tab:undoable');
  expect(await page.evaluate(() => window.view.state.doc.child(0).attrs.label)).toBe('tab:undoable');
  await label.press('Control+z');
  await expect(label).toHaveValue('');
  expect(await page.evaluate(() => window.view.state.doc.child(0).attrs.label)).toBe('');
  await label.press('Control+y');
  await expect(label).toHaveValue('tab:undoable');
  expect(await page.evaluate(() => window.view.state.doc.child(0).attrs.label)).toBe('tab:undoable');
});

test('tables keep exact pagination when they fit and break between rows when they cross a page', async ({ page }) => {
  test.setTimeout(90_000);

  const fitLogStart = await installPaginationTable(page, 4);
  await expect
    .poll(
      () => page.evaluate((start) => {
        const fresh = Math.min(window.__pagCount() - start, 40);
        return fresh > 0 && window.__pagLog().slice(-fresh).some((entry) => entry.startsWith('exact['));
      }, fitLogStart),
      { timeout: 30_000, intervals: [500, 1_000, 2_000] },
    )
    .toBe(true);
  expect(await page.evaluate(() => document.querySelectorAll('.ProseMirror table tr.ts-table-break').length)).toBe(0);

  const consoleIssues: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'warning' || message.type() === 'error') {
      consoleIssues.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  // Keep the same app instance and exact basis from the fitting table. A
  // later mid-table oracle answer (PAGE-PORT.md Phase 7) is installed as a
  // row-boundary widget inside the one editable table node — the retained
  // basis from the fitting table must neither block nor resurrect it.
  const crossingLogStart = await installPaginationTable(page, 45, false);
  await expect
    .poll(
      () => page.evaluate(() => {
        const oracle = window.__pageOracle as { results?: Map<string, { status: string; pageStarts?: Array<{ unit: string; line: number }> }> };
        return [...(oracle.results?.values() ?? [])].some(
          (entry) => entry.status === 'ok' && entry.pageStarts?.some((start) => start.unit === 'table' && start.line > 0),
        );
      }),
      { timeout: 45_000, intervals: [500, 1_000, 2_000] },
    )
    .toBe(true);
  await expect
    .poll(
      () => page.evaluate((start) => {
        if (window.__pagCount() <= start) return false;
        return window.__pagLog().at(-1)?.startsWith('exact[') ?? false;
      }, crossingLogStart),
      { timeout: 15_000, intervals: [250, 500, 1_000] },
    )
    .toBe(true);

  await expect
    .poll(
      () => page.evaluate(async () => {
        const read = () => ({
          count: window.__pagCount(),
          entry: window.__pagLog().at(-1) ?? '',
          tables: window.view.state.doc.childCount,
          breaks: document.querySelectorAll('.ProseMirror table tr.ts-table-break').length,
          table: (() => {
            const rect = document.querySelector('.ProseMirror table')?.getBoundingClientRect();
            return rect ? [rect.top, rect.left, rect.width, rect.height].map((value) => value.toFixed(2)) : [];
          })(),
          gaps: [...document.querySelectorAll<HTMLElement>('.ts-pagegap')]
            .map((gap) => `${gap.dataset.tsGapKey ?? ''}:${gap.getBoundingClientRect().height.toFixed(1)}`),
        });
        const before = read();
        await new Promise((resolve) => window.setTimeout(resolve, 600));
        const after = read();
        return (
          JSON.stringify(before) === JSON.stringify(after) &&
          after.entry.startsWith('exact[') &&
          after.tables === 1 &&
          after.breaks === 1
        );
      }),
      { timeout: 15_000, intervals: [250, 500, 1_000] },
    )
    .toBe(true);
  expect(pageErrors).toEqual([]);
  expect(consoleIssues).toEqual([]);
});
