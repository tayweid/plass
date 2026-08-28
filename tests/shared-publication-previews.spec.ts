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
    __compileCoordinatorStats(): {
      submitted: number;
      running: boolean;
      queueDepth: number;
      succeeded: number;
    };
  }
}

test('many math nodes consume one atomic whole-document publication', async ({ page }) => {
  await page.goto('/?new=1');
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => {
    const stats = window.__compileCoordinatorStats();
    return Number(stats.running) + stats.queueDepth;
  })).toBe(0);
  const before = await page.evaluate(() => ({
    broker: window.__documentCompileBrokerStats(),
    compiler: window.__compileCoordinatorStats(),
  }));

  await page.evaluate(() => {
    const { state } = window.view;
    const s = state.schema;
    const inline: import('prosemirror-model').Node[] = [];
    for (let index = 0; index < 30; index++) {
      inline.push(s.text(`term ${index} `));
      inline.push(s.nodes.math_inline.create({
        src: index % 3 === 0 ? `\\frac{x_${index}}{1+y_${index}}` : `x_${index}^2`,
      }));
      inline.push(s.text(' '));
    }
    const blocks: import('prosemirror-model').Node[] = [s.nodes.paragraph.create(null, inline)];
    for (let index = 0; index < 6; index++) {
      blocks.push(s.nodes.math_display.create({
        src: `\\sum_{i=1}^{${index + 2}} x_i = ${index + 1}`,
        label: `eq:${index}`,
      }));
    }
    window.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, blocks));
  });

  const inline = page.locator('.math-inline');
  const display = page.locator('.math-display');
  await expect(inline).toHaveCount(30);
  await expect(display).toHaveCount(6);
  await expect.poll(() => inline.evaluateAll((elements) =>
    elements.every((element) => (element as HTMLElement).dataset.previewState === 'ready'),
  ), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => display.evaluateAll((elements) =>
    elements.every((element) => (element as HTMLElement).dataset.previewState === 'ready'),
  ), { timeout: 30_000 }).toBe(true);
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 30_000 });
  await expect(inline.locator('image[data-exact-document-publication]')).toHaveCount(30);
  await expect(display.locator('image[data-exact-document-publication]')).toHaveCount(6);
  await expect(page.locator('.math-inline .katex, .math-display .katex')).toHaveCount(0);
  expect(await inline.locator('svg').first().evaluate((svg) => getComputedStyle(svg).overflow)).toBe('hidden');

  const result = await page.evaluate(() => {
    const hrefs = [...document.querySelectorAll<SVGImageElement>(
      '.math-inline image[data-exact-document-publication], .math-display image[data-exact-document-publication]',
    )].map((image) => image.getAttribute('href'));
    const inlineRects = [...document.querySelectorAll<HTMLElement>('.math-inline')]
      .map((element) => element.getBoundingClientRect());
    const displayRects = [...document.querySelectorAll<HTMLElement>('.math-display')]
      .map((element) => element.getBoundingClientRect());
    return {
      hrefs: [...new Set(hrefs)],
      inlineWidths: inlineRects.map((rect) => rect.width),
      inlineHeights: inlineRects.map((rect) => rect.height),
      displayHeights: displayRects.map((rect) => rect.height),
      broker: window.__documentCompileBrokerStats(),
      compiler: window.__compileCoordinatorStats(),
    };
  });
  expect(result.hrefs).toHaveLength(1);
  expect(Math.min(...result.inlineWidths)).toBeGreaterThan(3);
  expect(Math.min(...result.inlineHeights)).toBeGreaterThan(3);
  expect(Math.min(...result.displayHeights)).toBeGreaterThan(10);
  expect(result.broker.compilerTasks - before.broker.compilerTasks).toBe(1);
  expect(result.broker.publications - before.broker.publications).toBe(1);
  expect(result.compiler.submitted - before.compiler.submitted).toBe(1);
});

test('bibliography crop updates on a same-length BibTeX replacement', async ({ page }) => {
  await page.goto('/?new=1');
  const original = '@article{alpha,author={A. Author},title={First Title},journal={Journal},year={2024}}';
  const replacement = original.replace('First', 'Other');
  expect(replacement).toHaveLength(original.length);
  await page.evaluate((bib) => {
    const { state } = window.view;
    const s = state.schema;
    const paragraph = s.nodes.paragraph.create(null, [
      s.text('See '),
      s.nodes.citation.create({ key: 'alpha' }),
      s.text(' for the result.'),
    ]);
    let tr = state.tr.setDocAttribute('bib', { name: 'refs.bib', content: bib });
    tr = tr.replaceWith(0, tr.doc.content.size, [paragraph, s.nodes.bibliography.create()]);
    window.view.dispatch(tr);
  }, original);

  const bibliography = page.locator('.ts-bibliography');
  await expect(bibliography).toHaveAttribute('data-preview-state', 'ready', { timeout: 30_000 });
  await expect(bibliography).toHaveClass(/bib-has-ink/);
  const firstHref = await bibliography.locator('image[data-exact-document-publication]').getAttribute('href');
  expect(firstHref).toMatch(/^blob:/);
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 30_000 });

  await page.evaluate((bib) => {
    const { state } = window.view;
    window.view.dispatch(state.tr.setDocAttribute('bib', { name: 'refs.bib', content: bib }));
  }, replacement);
  await expect(bibliography).toHaveAttribute('data-preview-state', 'ready', { timeout: 30_000 });
  await expect.poll(async () => bibliography.locator('image').getAttribute('href')).not.toBe(firstHref);
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 30_000 });
});

test('preview metadata is paint- and page-neutral versus the export document', async ({ page }) => {
  await page.goto('/?new=1');
  await expect(page.locator('#stack')).toHaveAttribute('data-page-mode', 'exact', { timeout: 30_000 });

  const result = await page.evaluate(async () => {
    const { compileDocSvg, compileDocSvgWithEmbedRegions } = await import('/src/pdf.ts');
    const { parseTypstSvg } = await import('/src/safe-svg.ts');
    const { TYPST_PREVIEW_INLINE_MATH_LINK_PREFIX } = await import('/src/typst-preview-regions.ts');
    const state = window.view.state;
    const s = state.schema;
    const bib = [
      '@article{alpha,author={Ada Author},title={A Geometry-Preserving Result},journal={Exact Systems},year={2025}}',
      '@book{beta,author={Bernard Builder},title={Whole Document Typesetting},publisher={Parsimony Press},year={2024}}',
    ].join('\n');
    const paragraph = (text: string) => s.nodes.paragraph.create(null, s.text(text));
    const body = s.nodes.paragraph.create(null, [
      s.text('The inline identity '),
      s.nodes.math_inline.create({ src: 'e^{i\\pi}+1=0' }),
      s.text(' remains on the export baseline; compare '),
      s.nodes.citation.create({ key: 'alpha' }),
      s.text(' and '),
      s.nodes.citation.create({ key: 'beta' }),
      s.text(' for the construction.'),
    ]);
    const pmDoc = s.nodes.doc.create({
      ...state.doc.attrs,
      bib: { name: 'refs.bib', content: bib },
    }, [
      s.nodes.heading.create({ level: 1 }, s.text('One publication, one geometry')),
      paragraph('Metadata may expose crop coordinates, but it must not become a second layout input.'),
      body,
      s.nodes.math_display.create({
        src: '\\int_0^1 x^2\\,dx = \\frac{1}{3}',
        label: 'eq:integral',
      }),
      paragraph('The bibliography below is compiled in the same document world.'),
      s.nodes.bibliography.create(),
    ]);

    const normalSvg = await compileDocSvg(pmDoc);
    const publication = await compileDocSvgWithEmbedRegions(pmDoc);
    if (!normalSvg || !publication) throw new Error('conformance document did not compile');

    type Paint = {
      tag: string;
      bounds: number[];
      matrix: number[];
      d: string;
      href: string;
      fill: string;
      stroke: string;
      strokeWidth: string;
      opacity: string;
      text: string;
    };
    const round = (value: number) => Math.round(value * 100_000) / 100_000;
    const geometry = (source: string) => {
      const host = parseTypstSvg(source);
      host.style.cssText =
        'position:absolute;left:-100000px;top:0;visibility:hidden;pointer-events:none';
      document.body.appendChild(host);
      const svg = host.querySelector('svg');
      if (!svg) throw new Error('Typst output had no SVG root');
      const internalAnchor = (element: Element) => {
        const anchor = element.closest('a');
        const href = anchor?.getAttribute('href') ?? anchor?.getAttribute('xlink:href') ?? '';
        return href.startsWith(TYPST_PREVIEW_INLINE_MATH_LINK_PREFIX);
      };
      const paints = [...svg.querySelectorAll<SVGGraphicsElement>(
        'use,path,rect,circle,ellipse,line,polyline,polygon,image,text',
      )]
        .filter((element) => !element.closest('defs') && !internalAnchor(element))
        .map((element): Paint => {
          const matrix = element.getCTM();
          const box = element.getBBox();
          if (!matrix) throw new Error(`Typst ${element.localName} had no transform`);
          const corners = [
            new DOMPoint(box.x, box.y),
            new DOMPoint(box.x + box.width, box.y),
            new DOMPoint(box.x, box.y + box.height),
            new DOMPoint(box.x + box.width, box.y + box.height),
          ].map((point) => point.matrixTransform(matrix));
          const xs = corners.map((point) => point.x);
          const ys = corners.map((point) => point.y);
          return {
            tag: element.localName,
            bounds: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(round),
            matrix: [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].map(round),
            d: element.getAttribute('d') ?? '',
            href: element.getAttribute('href') ?? element.getAttribute('xlink:href') ?? '',
            fill: element.getAttribute('fill') ?? '',
            stroke: element.getAttribute('stroke') ?? '',
            strokeWidth: element.getAttribute('stroke-width') ?? '',
            opacity: element.getAttribute('opacity') ?? '',
            text: element.textContent ?? '',
          };
        });
      const pages = [...svg.querySelectorAll<SVGGElement>('.typst-page')].map((compiledPage) => ({
        transform: compiledPage.getAttribute('transform'),
        width: compiledPage.dataset.pageWidth,
        height: compiledPage.dataset.pageHeight,
      }));
      const result = {
        root: {
          viewBox: svg.getAttribute('viewBox'),
          width: svg.getAttribute('width'),
          height: svg.getAttribute('height'),
        },
        pages,
        paints,
      };
      host.remove();
      return result;
    };

    const normal = geometry(normalSvg);
    const instrumented = geometry(publication.svg);
    let mismatch: { index: number; normal: Paint; instrumented: Paint } | null = null;
    const close = (left: number[], right: number[]) =>
      left.length === right.length && left.every((value, index) => Math.abs(value - right[index]) < 0.005);
    if (normal.paints.length === instrumented.paints.length) {
      for (let index = 0; index < normal.paints.length; index++) {
        const left = normal.paints[index];
        const right = instrumented.paints[index];
        const { bounds: leftBounds, matrix: leftMatrix, ...leftPaint } = left;
        const { bounds: rightBounds, matrix: rightMatrix, ...rightPaint } = right;
        if (
          JSON.stringify(leftPaint) !== JSON.stringify(rightPaint) ||
          !close(leftBounds, rightBounds) ||
          !close(leftMatrix, rightMatrix)
        ) {
          mismatch = { index, normal: left, instrumented: right };
          break;
        }
      }
    }
    const internalAnchors = [...parseTypstSvg(publication.svg).querySelectorAll('a')]
      .filter((anchor) => {
        const href = anchor.getAttribute('href') ?? anchor.getAttribute('xlink:href') ?? '';
        return href.startsWith(TYPST_PREVIEW_INLINE_MATH_LINK_PREFIX);
      }).length;
    return {
      normal: { root: normal.root, pages: normal.pages, paintCount: normal.paints.length },
      instrumented: {
        root: instrumented.root,
        pages: instrumented.pages,
        paintCount: instrumented.paints.length,
      },
      mismatch,
      internalAnchors,
      regions: publication.previewRegions?.map((region) => ({ index: region.index, kind: region.kind })) ?? [],
    };
  });

  expect(result.regions).toEqual([
    { index: 0, kind: 'math-inline' },
    { index: 1, kind: 'math-display' },
    { index: 2, kind: 'bibliography' },
  ]);
  expect(result.internalAnchors).toBe(1);
  expect(result.instrumented.root).toEqual(result.normal.root);
  expect(result.instrumented.pages).toEqual(result.normal.pages);
  expect(result.instrumented.paintCount).toBe(result.normal.paintCount);
  expect(result.mismatch).toBeNull();
});

test('a cross-page bibliography stays honest and delegates exact paint to Proof', async ({ page }) => {
  await page.goto('/?new=1');
  const entryCount = 28;
  await page.evaluate((count) => {
    const { state } = window.view;
    const s = state.schema;
    const entries = Array.from({ length: count }, (_, index) =>
      `@article{source${index},author={Researcher ${index} and Collaborator ${index}},` +
      `title={A deliberately detailed technical result number ${index} with enough words to wrap},` +
      `journal={Journal of Exact Document Systems},volume={${index + 1}},pages={101--129},year={2025}}`);
    const citations: import('prosemirror-model').Node[] = [s.text('Sources ')];
    for (let index = 0; index < count; index++) {
      citations.push(s.nodes.citation.create({ key: `source${index}` }));
      if (index + 1 < count) citations.push(s.text(', '));
    }
    const settings = state.doc.attrs.settings as Record<string, unknown>;
    let tr = state.tr.setDocAttribute('bib', { name: 'many.bib', content: entries.join('\n') });
    tr = tr.setDocAttribute('settings', {
      ...settings,
      page: 'b5',
      sizePt: 14,
      marginTop: 1.25,
      marginRight: 1.25,
      marginBottom: 1.25,
      marginLeft: 1.25,
    });
    tr = tr.replaceWith(0, tr.doc.content.size, [
      s.nodes.paragraph.create(null, citations),
      s.nodes.bibliography.create(),
    ]);
    window.view.dispatch(tr);
  }, entryCount);

  const bibliography = page.locator('.ts-bibliography');
  await expect(bibliography).toHaveAttribute('data-preview-state', 'proof', { timeout: 30_000 });
  await expect(bibliography).toHaveClass(/bib-proof/);
  await expect(bibliography).not.toHaveClass(/bib-has-ink/);
  await expect(bibliography.locator('image[data-exact-document-publication]')).toHaveCount(0);
  expect(await page.evaluate(async () => {
    const { documentPreviewManagerFor } = await import('/src/raw-preview.ts');
    return documentPreviewManagerFor(window.view).isReadyFor(window.view.state.doc);
  })).toBe(true);
  await expect(bibliography.locator('.bib-dom')).toBeVisible();
  await expect(bibliography.locator('.bib-item')).toHaveCount(entryCount);
  await expect(bibliography.getByRole('status')).toHaveText(
    /References span (?:[2-9]|\d{2,}) Typst pages — open Proof for exact output\./,
  );

  await page.getByRole('button', { name: 'Proof', exact: true }).click();
  const proof = page.getByRole('dialog', { name: 'Exact Typst proof' });
  await expect(proof.getByRole('status')).toHaveText(/\d+ pages · exact Typst output/, { timeout: 30_000 });
  const proofPages = proof.locator('.typst-proof-document .typst-page');
  expect(await proofPages.count()).toBeGreaterThan(1);
  await page.keyboard.press('Escape');
  await expect(proof).toHaveCount(0);
});
