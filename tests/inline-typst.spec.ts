import { expect, test } from 'playwright/test';

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
    __documentCompileBrokerStats(): {
      compilerTasks: number;
      publications: number;
      sharedRequests: number;
      owners: number;
    };
  }
}

test('fixed inline Typst is cropped from the one exact document publication', async ({ page }) => {
  await page.goto('/?new=1');
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 30_000 });
  const before = await page.evaluate(() => window.__documentCompileBrokerStats());

  await page.evaluate(() => {
    SVGGraphicsElement.prototype.getScreenCTM = function getScreenCTM() {
      throw new Error('inline page extraction consulted poisoned screen geometry');
    };
    const { state } = window.view;
    const atom = state.schema.nodes.typst_inline.create({ src: '#box[#circle(radius: 3pt)]' });
    const paragraph = state.schema.nodes.paragraph.create(null, [
      state.schema.text('Exact atom '), atom, state.schema.text(' in document context.'),
    ]);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, paragraph));
  });

  const atom = page.locator('.ts-inline-raw');
  await expect(atom).toHaveAttribute('data-inline-kind', 'fixed');
  await expect(atom).toHaveAttribute('data-preview-state', 'ready', { timeout: 30_000 });
  await expect(atom.locator('svg > image[data-exact-document-publication]')).toHaveCount(1);
  expect(await atom.locator('svg').evaluate((svg) => getComputedStyle(svg).overflow)).toBe('hidden');
  expect(await atom.locator('svg > image').getAttribute('href')).toMatch(/^blob:/);
  expect(await atom.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(5);
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 30_000 });

  const after = await page.evaluate(() => window.__documentCompileBrokerStats());
  expect(after.compilerTasks - before.compilerTasks).toBe(1);
  expect(after.publications - before.publications).toBe(1);
  expect(after.owners).toBe(2);
  await expect(page.locator('a[href*="plass.invalid/.well-known/inline-atom"]')).toHaveCount(0);
});

test('selectable inline atom cannot impersonate following prose across a wrap', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const atom = state.schema.nodes.typst_inline.create({ src: '#box[in]' });
    // At the default certified measure, the atom-painted `in` finishes line
    // one while the source `in` wraps. An unbounded text wildcard mistakes
    // the former for the latter and publishes no forced break.
    const paragraph = state.schema.nodes.paragraph.create(null, [
      state.schema.text(`N34:${'M'.repeat(34)} `),
      atom,
      state.schema.text(' in'),
    ]);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, paragraph));
  });

  await expect(page.locator('.ts-inline-raw')).toHaveAttribute('data-preview-state', 'ready', {
    timeout: 30_000,
  });
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 30_000 });
  await expect(page.locator('.ProseMirror p .ts-br')).toHaveCount(1);
  const order = await page.locator('.ProseMirror p:has(.ts-inline-raw)').evaluate((paragraph) => {
    const atom = paragraph.querySelector('.ts-inline-raw');
    const br = paragraph.querySelector('.ts-br');
    return !!atom && !!br && !!(atom.compareDocumentPosition(br) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(order).toBe(true);
});

test('inline math selection ownership stays bounded between adjacent prose', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const paragraph = (source: string) => state.schema.nodes.paragraph.create(null, [
      state.schema.text('Before '),
      state.schema.nodes.math_inline.create({ src: source }),
      state.schema.text(' after.'),
    ]);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, [
      paragraph('x^2'),
      paragraph('\\frac{x_0}{1+y_0}'),
    ]));
  });

  await expect(page.locator('.math-inline[data-preview-state="ready"]')).toHaveCount(2, {
    timeout: 30_000,
  });
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 30_000 });
  await expect(page.locator('.ProseMirror p .ts-br')).toHaveCount(0);
});

test('a terminal fixed inline Typst marker stays with its atom before display math', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const s = state.schema;
    const inline: import('prosemirror-model').Node[] = [];
    for (let index = 0; index < 30; index++) {
      inline.push(s.text(`term ${index} `));
      inline.push(index === 29
        ? s.nodes.typst_inline.create({ src: '$x_29^2$' })
        : s.nodes.math_inline.create({
            src: index % 3 === 0 ? `\\frac{x_${index}}{1+y_${index}}` : `x_${index}^2`,
          }));
      inline.push(s.text(' '));
    }
    const paragraph = s.nodes.paragraph.create(null, inline);
    const display = s.nodes.math_display.create({ src: '\\sum_{i=1}^{2} x_i = 1', label: 'eq:after' });
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, [paragraph, display]));
  });

  await expect(page.locator('.ts-inline-raw')).toHaveAttribute('data-preview-state', 'ready', {
    timeout: 30_000,
  });
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 30_000 });
  await expect(page.locator('.math-display')).toHaveAttribute('data-preview-state', 'ready');
});

test('unsupported inline Typst stays lossless, inert, and explicit', async ({ page }) => {
  await page.goto('/?new=1');
  const source = '#box[#pagebreak()]';
  await page.evaluate((source) => {
    const { state } = window.view;
    const atom = state.schema.nodes.typst_inline.create({ src: source });
    const paragraph = state.schema.nodes.paragraph.create(null, [
      state.schema.text('Before '), atom, state.schema.text(' after.'),
    ]);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, paragraph));
  }, source);

  const atom = page.locator('.ts-inline-raw');
  await expect(atom).toHaveAttribute('data-inline-kind', 'unsupported');
  await expect(atom).toHaveAttribute('data-preview-state', 'unsupported');
  await expect(atom).toHaveText(source);
  expect(await atom.getAttribute('title')).toContain('rendered in Proof/PDF');
  expect(await page.evaluate(() => ({
    type: window.view.state.doc.firstChild?.child(1).type.name,
    source: window.view.state.doc.firstChild?.child(1).attrs.src,
  }))).toEqual({ type: 'typst_inline', source });
  await expect(atom.locator('svg')).toHaveCount(0);
});

test('canonical flexible inline space uses compiled line slack without a fragment preview', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const fill = state.schema.nodes.typst_inline.create({ src: '#h(1fr)' });
    const paragraph = state.schema.nodes.paragraph.create(null, [
      state.schema.text('Left'), fill, state.schema.text('Right'),
    ]);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, paragraph));
  });

  const fill = page.locator('.ts-inline-raw');
  await expect(fill).toHaveAttribute('data-inline-kind', 'flexible');
  await expect(fill).toHaveAttribute('data-preview-state', 'ready', { timeout: 30_000 });
  expect(await fill.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(100);
  await expect(fill.locator('svg')).toHaveCount(0);
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 30_000 });
});

test('a terminal flexible inline Typst marker stays before following display math', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const s = state.schema;
    const paragraph = s.nodes.paragraph.create(null, [
      s.text('Terminal flexible fill'),
      s.nodes.typst_inline.create({ src: '#h(1fr)' }),
    ]);
    const display = s.nodes.math_display.create({ src: '\\sum_{i=1}^{2} x_i = 1', label: 'eq:after-fill' });
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, [paragraph, display]));
  });

  const fill = page.locator('.ts-inline-raw');
  await expect(fill).toHaveAttribute('data-inline-kind', 'flexible');
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 30_000 });
  await expect(fill).toHaveAttribute('data-preview-state', 'ready', { timeout: 30_000 });
  await expect(page.locator('.math-display')).toHaveAttribute('data-preview-state', 'ready');
});

test('editor-only inline instrumentation preserves the normal Typst paint geometry', async ({ page }) => {
  await page.goto('/?new=1');
  const result = await page.evaluate(async () => {
    const { compileDocSvg, compileDocSvgWithEmbedRegions } = await import('/src/pdf.ts');
    const { parseTypstSvg } = await import('/src/safe-svg.ts');
    const state = window.view.state;
    const inline = (src: string) => state.schema.nodes.typst_inline.create({ src });
    const paragraph = state.schema.nodes.paragraph.create(null, [
      state.schema.text('Before '),
      inline('$x^2$'),
      state.schema.text(' and '),
      inline('#sym.arrow.r'),
      state.schema.text(' then '),
      inline('#box[#circle(radius: 3pt)]'),
      state.schema.text(' with space'),
      inline('#h(1em)'),
      state.schema.text('after. The surrounding prose is long enough to make a changed advance or line box visible.'),
    ]);
    const doc = state.schema.nodes.doc.create(state.doc.attrs, [paragraph]);
    const normal = await compileDocSvg(doc);
    const publication = await compileDocSvgWithEmbedRegions(doc);
    if (!normal || !publication) throw new Error('inline conformance document did not compile');

    const geometry = (source: string) => {
      const host = parseTypstSvg(source);
      host.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;pointer-events:none';
      document.body.appendChild(host);
      const svg = host.querySelector('svg');
      if (!svg) throw new Error('compiler output had no SVG root');
      const round = (value: number) => Math.round(value * 10_000) / 10_000;
      const matrix = (element: SVGGraphicsElement) => {
        const value = element.getCTM();
        return value ? [value.a, value.b, value.c, value.d, value.e, value.f].map(round) : null;
      };
      const bounds = (element: SVGGraphicsElement) => {
        const value = element.getCTM();
        if (!value) return null;
        if (element.localName === 'use') {
          const point = new DOMPoint(
            Number(element.getAttribute('x') ?? 0),
            Number(element.getAttribute('y') ?? 0),
          ).matrixTransform(value);
          return [point.x, point.y, point.x, point.y].map(round);
        }
        const box = element.getBBox();
        const corners = [
          new DOMPoint(box.x, box.y),
          new DOMPoint(box.x + box.width, box.y),
          new DOMPoint(box.x, box.y + box.height),
          new DOMPoint(box.x + box.width, box.y + box.height),
        ].map((point) => point.matrixTransform(value));
        const xs = corners.map((point) => point.x);
        const ys = corners.map((point) => point.y);
        return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(round);
      };
      const paints = [...svg.querySelectorAll<SVGGraphicsElement>(
        'use,path,rect,circle,ellipse,line,polyline,polygon,image',
      )]
        .filter((element) => {
          if (element.closest('defs')) return false;
          const anchor = element.closest('a');
          const href = anchor?.getAttribute('href') ?? anchor?.getAttribute('xlink:href') ?? '';
          return !href.includes('plass.invalid/.well-known/inline-atom');
        })
        .map((element) => ({
          tag: element.localName,
          bounds: bounds(element),
          href: element.getAttribute('href') ?? element.getAttribute('xlink:href') ?? '',
          d: element.getAttribute('d') ?? '',
          fill: element.getAttribute('fill') ?? '',
          stroke: element.getAttribute('stroke') ?? '',
        }))
        .sort((left, right) => {
          for (const coordinate of [1, 0, 3, 2]) {
            const difference = (left.bounds?.[coordinate] ?? 0) - (right.bounds?.[coordinate] ?? 0);
            if (Math.abs(difference) > 0.0001) return difference;
          }
          return `${left.tag}|${left.href}|${left.d}`.localeCompare(`${right.tag}|${right.href}|${right.d}`);
        });
      const pages = [...svg.querySelectorAll<SVGGElement>('.typst-page')].map((compiledPage) => ({
        matrix: matrix(compiledPage),
        width: compiledPage.dataset.pageWidth,
        height: compiledPage.dataset.pageHeight,
      }));
      const viewBox = svg.getAttribute('viewBox');
      host.remove();
      return { viewBox, pages, paints };
    };

    return {
      normal: geometry(normal),
      instrumented: geometry(publication.svg),
      internalAnchors: new Set(
        [...publication.svg.matchAll(/\.well-known\/inline-atom\/(\d+)/g)].map((match) => match[1]),
      ).size,
    };
  });

  expect(result.internalAnchors).toBe(4);
  expect(result.instrumented.viewBox).toBe(result.normal.viewBox);
  expect(result.instrumented.pages).toEqual(result.normal.pages);
  expect(result.instrumented.paints).toHaveLength(result.normal.paints.length);
  for (let index = 0; index < result.normal.paints.length; index++) {
    const normal = result.normal.paints[index];
    const instrumented = result.instrumented.paints[index];
    expect({ ...instrumented, bounds: undefined }).toEqual({ ...normal, bounds: undefined });
    expect(instrumented.bounds).toHaveLength(normal.bounds?.length ?? 0);
    for (let coordinate = 0; coordinate < (normal.bounds?.length ?? 0); coordinate++) {
      const actual = instrumented.bounds?.[coordinate];
      const expected = normal.bounds![coordinate];
      if (actual === undefined || Math.abs(actual - expected) >= 0.005) {
        throw new Error(`paint ${index} differs: ${JSON.stringify({ normal, instrumented })}`);
      }
    }
  }
});

test('fixed inline Typst carries its exact Typst baseline into native line flow', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const { state } = window.view;
    const s = state.schema;
    const line = (baseline: string) => s.nodes.paragraph.create(null, [
      s.text('baseline before '),
      s.nodes.typst_inline.create({
        src: `#box(width: 24pt, height: 16pt, baseline: ${baseline})[A]`,
      }),
      s.text(' after'),
    ]);
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, [line('2pt'), line('12pt')]));
  });

  const atoms = page.locator('.ts-inline-raw');
  await expect(atoms).toHaveCount(2);
  await expect(atoms.nth(0)).toHaveAttribute('data-preview-state', 'ready', { timeout: 30_000 });
  await expect(atoms.nth(1)).toHaveAttribute('data-preview-state', 'ready', { timeout: 30_000 });
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 30_000 });
  const geometry = await atoms.evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect();
    const paragraph = element.parentElement!.getBoundingClientRect();
    return {
      verticalAlign: Number.parseFloat(getComputedStyle(element).verticalAlign),
      topInLine: rect.top - paragraph.top,
      height: rect.height,
    };
  }));
  expect(geometry.every((entry) => Number.isFinite(entry.verticalAlign))).toBe(true);
  expect(Math.abs(geometry[0].verticalAlign - geometry[1].verticalAlign)).toBeGreaterThan(8);
  expect(Math.abs(geometry[0].topInLine - geometry[1].topInLine)).toBeGreaterThan(8);
  expect(Math.abs(geometry[0].height - geometry[1].height)).toBeLessThan(0.5);
});
