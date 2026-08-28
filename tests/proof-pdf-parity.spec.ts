import { execFile as execFileCallback } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test, type Page } from 'playwright/test';

const execFile = promisify(execFileCallback);
const PAGE_WIDTH_PT = 612;
const PAGE_HEIGHT_PT = 792;
const RASTER_DPI = 96;

declare global {
  interface Window {
    view: import('prosemirror-view').EditorView;
  }
}

interface RasterComparison {
  width: number;
  height: number;
  bestShift: { x: number; y: number };
  symmetricInkDelta: number;
  proofInkCovered: number;
  pdfInkCovered: number;
  inkMassRatio: number;
  chromaticInkDelta: number;
}

/** Compare two independently rasterized versions of a page. The Proof is
 * painted by Chromium from Typst's SVG outlines; Poppler paints the exported
 * PDF. Their edge antialiasing is intentionally different, so compare ink
 * energy after a two-pixel box reduction and tolerate a one-cell neighborhood
 * for occupancy. Content loss, reflow, font/style drift, and changed geometry
 * remain highly visible to these metrics without making the test a screenshot
 * test of one rasterizer's edge pixels. */
async function comparePageRasters(
  page: Page,
  proofPng: Buffer,
  pdfPng: Buffer,
): Promise<RasterComparison> {
  return page.evaluate(async ({ proofBase64, pdfBase64 }) => {
    const decode = async (base64: string) => {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('2D canvas is unavailable');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, bitmap.width, bitmap.height);
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      return {
        width: canvas.width,
        height: canvas.height,
        pixels: context.getImageData(0, 0, canvas.width, canvas.height).data,
      };
    };

    const [proof, pdf] = await Promise.all([decode(proofBase64), decode(pdfBase64)]);
    if (proof.width !== pdf.width || proof.height !== pdf.height) {
      return {
        width: proof.width,
        height: proof.height,
        bestShift: { x: 999, y: 999 },
        symmetricInkDelta: Number.POSITIVE_INFINITY,
        proofInkCovered: 0,
        pdfInkCovered: 0,
        inkMassRatio: 0,
        chromaticInkDelta: Number.POSITIVE_INFINITY,
      };
    }

    const blockSize = 2;
    const gridWidth = Math.floor(proof.width / blockSize);
    const gridHeight = Math.floor(proof.height / blockSize);
    const channels = 3;
    const proofInk = new Float32Array(gridWidth * gridHeight * channels);
    const pdfInk = new Float32Array(gridWidth * gridHeight * channels);
    const reduce = (pixels: Uint8ClampedArray, target: Float32Array) => {
      for (let gridY = 0; gridY < gridHeight; gridY++) {
        for (let gridX = 0; gridX < gridWidth; gridX++) {
          const targetOffset = (gridY * gridWidth + gridX) * channels;
          for (let y = 0; y < blockSize; y++) {
            for (let x = 0; x < blockSize; x++) {
              const sourceOffset = (
                (gridY * blockSize + y) * proof.width + gridX * blockSize + x
              ) * 4;
              // Store distance from white for each channel. This retains color
              // changes while making the white paper contribute no weight.
              target[targetOffset] += 255 - pixels[sourceOffset];
              target[targetOffset + 1] += 255 - pixels[sourceOffset + 1];
              target[targetOffset + 2] += 255 - pixels[sourceOffset + 2];
            }
          }
          target[targetOffset] /= blockSize * blockSize;
          target[targetOffset + 1] /= blockSize * blockSize;
          target[targetOffset + 2] /= blockSize * blockSize;
        }
      }
    };
    reduce(proof.pixels, proofInk);
    reduce(pdf.pixels, pdfInk);

    const luminanceInk = (values: Float32Array, offset: number) =>
      values[offset] * 0.2126 + values[offset + 1] * 0.7152 + values[offset + 2] * 0.0722;
    const scoreShift = (shiftX: number, shiftY: number) => {
      let difference = 0;
      let union = 0;
      // A sparse search is enough to correct fractional clip rounding while
      // keeping this gate quick for ten-plus page documents.
      for (let y = 2; y < gridHeight - 2; y += 2) {
        const pdfY = y + shiftY;
        if (pdfY < 0 || pdfY >= gridHeight) continue;
        for (let x = 2; x < gridWidth - 2; x += 2) {
          const pdfX = x + shiftX;
          if (pdfX < 0 || pdfX >= gridWidth) continue;
          const proofOffset = (y * gridWidth + x) * channels;
          const pdfOffset = (pdfY * gridWidth + pdfX) * channels;
          const left = luminanceInk(proofInk, proofOffset);
          const right = luminanceInk(pdfInk, pdfOffset);
          difference += Math.abs(left - right);
          union += Math.max(left, right);
        }
      }
      return union > 0 ? difference / union : Number.POSITIVE_INFINITY;
    };

    let bestShift = { x: 0, y: 0 };
    let bestScore = Number.POSITIVE_INFINITY;
    for (let y = -1; y <= 1; y++) {
      for (let x = -1; x <= 1; x++) {
        const score = scoreShift(x, y);
        if (score < bestScore) {
          bestScore = score;
          bestShift = { x, y };
        }
      }
    }

    const occupied = (values: Float32Array, gridX: number, gridY: number) => {
      if (gridX < 0 || gridY < 0 || gridX >= gridWidth || gridY >= gridHeight) return false;
      const offset = (gridY * gridWidth + gridX) * channels;
      return luminanceInk(values, offset) >= 3;
    };
    const occupiedNearby = (values: Float32Array, gridX: number, gridY: number) => {
      for (let y = -1; y <= 1; y++) {
        for (let x = -1; x <= 1; x++) {
          if (occupied(values, gridX + x, gridY + y)) return true;
        }
      }
      return false;
    };

    let channelDifference = 0;
    let channelUnion = 0;
    let proofOccupied = 0;
    let pdfOccupied = 0;
    let proofMatched = 0;
    let pdfMatched = 0;
    let proofMass = 0;
    let pdfMass = 0;
    const proofChannelMass = [0, 0, 0];
    const pdfChannelMass = [0, 0, 0];
    for (let y = 0; y < gridHeight; y++) {
      for (let x = 0; x < gridWidth; x++) {
        const shiftedX = x + bestShift.x;
        const shiftedY = y + bestShift.y;
        const proofOffset = (y * gridWidth + x) * channels;
        const proofValue = luminanceInk(proofInk, proofOffset);
        if (proofValue >= 3) {
          proofOccupied++;
          if (occupiedNearby(pdfInk, shiftedX, shiftedY)) proofMatched++;
        }
        proofMass += proofValue;
        for (let channel = 0; channel < channels; channel++) {
          proofChannelMass[channel] += proofInk[proofOffset + channel];
        }

        if (shiftedX < 0 || shiftedY < 0 || shiftedX >= gridWidth || shiftedY >= gridHeight) continue;
        const pdfOffset = (shiftedY * gridWidth + shiftedX) * channels;
        const pdfValue = luminanceInk(pdfInk, pdfOffset);
        if (pdfValue >= 3) pdfOccupied++;
        pdfMass += pdfValue;
        for (let channel = 0; channel < channels; channel++) {
          const left = proofInk[proofOffset + channel];
          const right = pdfInk[pdfOffset + channel];
          pdfChannelMass[channel] += right;
          channelDifference += Math.abs(left - right);
          channelUnion += Math.max(left, right);
        }
      }
    }
    // Reverse occupancy coverage is evaluated in PDF coordinates, with the
    // selected global alignment mapped back into Proof coordinates.
    for (let y = 0; y < gridHeight; y++) {
      for (let x = 0; x < gridWidth; x++) {
        if (!occupied(pdfInk, x, y)) continue;
        if (occupiedNearby(proofInk, x - bestShift.x, y - bestShift.y)) pdfMatched++;
      }
    }

    const normalizedChannels = (mass: number[]) => {
      const total = mass.reduce((sum, value) => sum + value, 0);
      return mass.map((value) => value / Math.max(total, 1));
    };
    const proofChromaticity = normalizedChannels(proofChannelMass);
    const pdfChromaticity = normalizedChannels(pdfChannelMass);
    return {
      width: proof.width,
      height: proof.height,
      bestShift,
      symmetricInkDelta: channelDifference / Math.max(channelUnion, 1),
      proofInkCovered: proofMatched / Math.max(proofOccupied, 1),
      pdfInkCovered: pdfMatched / Math.max(pdfOccupied, 1),
      inkMassRatio: pdfMass / Math.max(proofMass, 1),
      // Total-variation distance between RGB ink mixtures. Unlike luminance,
      // this catches a black/red/blue style split even when glyph geometry and
      // total darkness stay unchanged.
      chromaticInkDelta: proofChromaticity.reduce(
        (difference, value, channel) => difference + Math.abs(value - pdfChromaticity[channel]),
        0,
      ) / 2,
    };
  }, {
    proofBase64: proofPng.toString('base64'),
    pdfBase64: pdfPng.toString('base64'),
  });
}

test('medium-large mixed document Proof is the exported PDF page for page', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  // A full Letter page at 96 dpi fits inside this viewport. Keeping the SVG
  // group wholly visible also avoids browser screenshot clipping at the
  // proof scrollport boundary.
  await page.setViewportSize({ width: 1200, height: 1400 });
  await page.goto('/?new=1');
  await page.waitForFunction(() => !!window.view);
  await page.evaluate(() => {
    const { state } = window.view;
    const s = state.schema;
    const paragraph = (text: string, attrs: Record<string, unknown> | null = null) =>
      s.nodes.paragraph.create(attrs, s.text(text));
    const cell = (text: string, header = false) =>
      (header ? s.nodes.table_header : s.nodes.table_cell).create(null, paragraph(text));
    const body = 'A publication editor must preserve the geometry of technical prose while keeping input immediate. '
      + 'This deterministic specimen exercises line breaking, emphasis, references, native structures, and whole-document typesetting. '
      + 'Every sentence is long enough to expose a font, margin, or measure change rather than hiding it in unused white space.';
    const blocks: import('prosemirror-model').Node[] = [
      s.nodes.doc_title.create(null, s.text('Exact Technical Publication Specimen')),
      s.nodes.doc_authors.create(null, s.text('Ada Author and Bernard Builder')),
      s.nodes.doc_date.create(null, s.text('August 2026')),
      s.nodes.abstract.create(null, [
        paragraph('This medium-large mixed document is compiled independently for Proof and PDF. The resulting physical pages must remain the same artifact at both product boundaries.'),
      ]),
    ];

    for (let section = 1; section <= 9; section++) {
      blocks.push(s.nodes.heading.create(
        { level: section === 1 ? 1 : 2, label: `sec:${section}` },
        s.text(`Section ${section}: Deterministic geometry`),
      ));
      blocks.push(s.nodes.paragraph.create(null, [
        s.text(`The section-${section} identity `),
        s.nodes.math_inline.create({ src: `x_${section}^2 + y_${section}^2 = r^2` }),
        s.text(' is discussed by '),
        s.nodes.citation.create({ key: section % 2 ? 'knuth' : 'lamport' }),
        s.text(' with a local note'),
        s.nodes.footnote.create(null, s.text(`Footnote ${section} is part of the same immutable publication.`)),
        s.text('. The words '),
        s.text('strong geometry', [s.marks.strong.create()]),
        s.text(' and '),
        s.text('stable paint', [s.marks.em.create()]),
        s.text(' exercise inline styling.'),
      ]));
      for (let paragraphIndex = 0; paragraphIndex < 4; paragraphIndex++) {
        blocks.push(paragraph(
          `${body} Section ${section}, paragraph ${paragraphIndex + 1}, supplies a unique terminal marker ${section}.${paragraphIndex + 1}.`,
          paragraphIndex === 3 && section % 3 === 0 ? { keep: true } : null,
        ));
      }

      blocks.push(s.nodes.math_display.create({
        src: `\\int_0^1 x^${section + 1} \\, dx = \\frac{1}{${section + 2}}`,
        label: `eq:integral-${section}`,
        numbered: true,
      }));

      if (section % 2 === 0) {
        blocks.push(s.nodes.table.create(
          {
            style: section % 4 === 0 ? 'grid' : 'booktabs',
            caption: `Measured results for section ${section}`,
            label: `tab:section-${section}`,
            params: '',
            fontSize: '',
          },
          [
            s.nodes.table_row.create(null, [cell('Method', true), cell('Mean', true), cell('Interval', true)]),
            s.nodes.table_row.create(null, [cell('Shared publication'), cell(`${section}.25`), cell('[0.18, 0.31]')]),
            s.nodes.table_row.create(null, [cell('Independent export'), cell(`${section}.27`), cell('[0.20, 0.34]')]),
          ],
        ));
      }

      if (section % 3 === 0) {
        const item = (text: string) => s.nodes.list_item.create(null, paragraph(text));
        blocks.push(s.nodes.bullet_list.create(null, [
          item(`First structured observation for section ${section}`),
          item(`Second structured observation for section ${section}`),
          item(`Third structured observation for section ${section}`),
        ]));
        blocks.push(s.nodes.code_block.create(
          { params: '' },
          s.text(`sample_${section} = (${section} ** 2) / (${section} + 1)\nprint(sample_${section})`),
        ));
        blocks.push(s.nodes.typst_embed.create(
          null,
          s.text(`#block(fill: luma(244), inset: 6pt, radius: 2pt)[*Typst specimen ${section}:* one shared publication.]`),
        ));
      }

      if (section === 5) blocks.push(s.nodes.page_break.create());
    }
    blocks.push(
      s.nodes.heading.create({ level: 1, label: 'sec:references' }, s.text('References')),
      s.nodes.bibliography.create(),
    );

    const bib = [
      '@book{knuth,author={Donald E. Knuth},title={The TeXbook},publisher={Addison-Wesley},year={1986}}',
      '@book{lamport,author={Leslie Lamport},title={LaTeX: A Document Preparation System},publisher={Addison-Wesley},year={1994}}',
    ].join('\n');
    const document = s.nodes.doc.create({ ...state.doc.attrs, bib: { name: 'refs.bib', content: bib } }, blocks);
    window.view.dispatch(
      state.tr.replaceWith(0, state.doc.content.size, document.content)
        .setDocAttribute('bib', document.attrs.bib)
        .setMeta('addToHistory', false),
    );
  });
  const documentRevision = await page.evaluate(() => JSON.stringify(window.view.state.doc.toJSON()));

  await page.getByRole('button', { name: 'Proof', exact: true }).click();
  const proof = page.getByRole('dialog', { name: 'Exact Typst proof' });
  await expect(proof).toBeVisible();
  await expect(proof.getByRole('status')).toContainText(/\d+ pages · exact Typst output/, { timeout: 60_000 });

  // Proof adds a presentation-only drop shadow around physical sheets. It is
  // deliberately outside Typst's page coordinate system and therefore is not
  // part of the exported artifact being compared here.
  await page.addStyleTag({
    content: '.typst-proof-page-offset > .typst-page { filter: none !important; }',
  });

  const proofSvg = proof.locator('.typst-proof-document > svg');
  const proofGeometry = await proofSvg.evaluate((svg) => {
    const pages = [...svg.querySelectorAll<SVGGElement>('.typst-proof-page-offset')];
    return {
      widthPt: Number.parseFloat(svg.getAttribute('width') ?? ''),
      pageCount: pages.length,
      pages: pages.map((wrapper) => {
        const paper = wrapper.querySelector<SVGRectElement>('.typst-proof-paper');
        return {
          widthPt: Number.parseFloat(paper?.getAttribute('width') ?? ''),
          heightPt: Number.parseFloat(paper?.getAttribute('height') ?? ''),
        };
      }),
    };
  });
  expect(proofGeometry.pageCount).toBeGreaterThanOrEqual(8);
  expect(proofGeometry.widthPt).toBe(PAGE_WIDTH_PT);
  for (const geometry of proofGeometry.pages) {
    expect(geometry.widthPt).toBe(PAGE_WIDTH_PT);
    expect(geometry.heightPt).toBe(PAGE_HEIGHT_PT);
  }

  const proofRasterPaths: string[] = [];
  const proofPages = proof.locator('.typst-proof-page-offset');
  for (let index = 0; index < proofGeometry.pageCount; index++) {
    const path = testInfo.outputPath(`proof-page-${String(index + 1).padStart(2, '0')}.png`);
    await proofPages.nth(index).screenshot({ path, animations: 'disabled' });
    proofRasterPaths.push(path);
  }

  await proof.getByRole('button', { name: 'Back to editing' }).click();
  expect(await page.evaluate(() => JSON.stringify(window.view.state.doc.toJSON()))).toBe(documentRevision);
  const pdfButton = page.locator('button[title="Export PDF via Typst"]');
  await page.locator('.tb-flyout-wrap', { has: pdfButton }).hover();
  const downloadPromise = page.waitForEvent('download');
  await pdfButton.click();
  const download = await downloadPromise;
  const pdfPath = testInfo.outputPath('Plass.pdf');
  await download.saveAs(pdfPath);

  let infoOutput: string;
  try {
    ({ stdout: infoOutput } = await execFile('pdfinfo', [pdfPath], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    }));
  } catch (error) {
    throw new Error(`Proof/PDF parity requires Poppler's pdfinfo: ${String(error)}`);
  }
  const pdfPageCount = Number.parseInt(/^Pages:\s+(\d+)$/m.exec(infoOutput)?.[1] ?? '', 10);
  const pageSize = /^Page size:\s+([\d.]+) x ([\d.]+) pts/m.exec(infoOutput);
  expect(pdfPageCount).toBe(proofGeometry.pageCount);
  expect(Number.parseFloat(pageSize?.[1] ?? '')).toBe(PAGE_WIDTH_PT);
  expect(Number.parseFloat(pageSize?.[2] ?? '')).toBe(PAGE_HEIGHT_PT);

  const pdfRasterPrefix = testInfo.outputPath('pdf-page');
  try {
    await execFile('pdftoppm', [
      '-png',
      '-r', String(RASTER_DPI),
      '-aa', 'yes',
      '-aaVector', 'yes',
      pdfPath,
      pdfRasterPrefix,
    ], { env: { ...process.env, LC_ALL: 'C' } });
  } catch (error) {
    throw new Error(`Proof/PDF parity requires Poppler's pdftoppm: ${String(error)}`);
  }
  const outputDirectory = testInfo.outputDir;
  const pdfRasterNames = (await readdir(outputDirectory))
    .filter((name) => /^pdf-page-\d+\.png$/.test(name))
    .sort((left, right) => {
      const pageNumber = (name: string) => Number.parseInt(/(\d+)\.png$/.exec(name)?.[1] ?? '', 10);
      return pageNumber(left) - pageNumber(right);
    });
  expect(pdfRasterNames).toHaveLength(proofGeometry.pageCount);

  const comparisons: RasterComparison[] = [];
  for (let index = 0; index < proofGeometry.pageCount; index++) {
    const comparison = await comparePageRasters(
      page,
      await readFile(proofRasterPaths[index]),
      await readFile(join(outputDirectory, pdfRasterNames[index])),
    );
    comparisons.push(comparison);
  }
  const negativeControl = await comparePageRasters(
    page,
    await readFile(proofRasterPaths[0]),
    await readFile(join(outputDirectory, pdfRasterNames[pdfRasterNames.length - 1])),
  );
  await testInfo.attach('proof-pdf-raster-metrics', {
    body: Buffer.from(JSON.stringify({ comparisons, negativeControl }, null, 2)),
    contentType: 'application/json',
  });

  // Sanity-check the comparator itself: a real but deliberately wrong PDF
  // page must be separated decisively from the matching Proof page.
  expect(negativeControl.symmetricInkDelta).toBeGreaterThan(0.75);
  expect(negativeControl.proofInkCovered).toBeLessThan(0.50);

  for (const [index, comparison] of comparisons.entries()) {
    const pageLabel = `physical page ${index + 1}`;
    expect(comparison.width, `${pageLabel} raster width`).toBe(PAGE_WIDTH_PT * RASTER_DPI / 72);
    expect(comparison.height, `${pageLabel} raster height`).toBe(PAGE_HEIGHT_PT * RASTER_DPI / 72);
    expect(Math.abs(comparison.bestShift.x), `${pageLabel} horizontal alignment`).toBeLessThanOrEqual(1);
    expect(Math.abs(comparison.bestShift.y), `${pageLabel} vertical alignment`).toBeLessThanOrEqual(1);
    expect(comparison.symmetricInkDelta, `${pageLabel} paint divergence`).toBeLessThan(0.35);
    expect(comparison.proofInkCovered, `${pageLabel} Proof ink represented in PDF`).toBeGreaterThan(0.98);
    expect(comparison.pdfInkCovered, `${pageLabel} PDF ink represented in Proof`).toBeGreaterThan(0.98);
    expect(comparison.inkMassRatio, `${pageLabel} total paint ratio`).toBeGreaterThan(0.95);
    expect(comparison.inkMassRatio, `${pageLabel} total paint ratio`).toBeLessThan(1.05);
    expect(comparison.chromaticInkDelta, `${pageLabel} ink color mixture`).toBeLessThan(0.01);
  }
});
