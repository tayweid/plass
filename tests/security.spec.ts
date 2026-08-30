import { expect, test } from 'playwright/test';

test('document CSP blocks inline code, eval, and direct remote images', async ({ page }) => {
  let remoteRequests = 0;
  await page.route('https://csp-probe.test/direct.png', async (route) => {
    remoteRequests++;
    await route.abort();
  });
  await page.goto('/?new=1');
  const result = await page.evaluate(async () => {
    const policy = document.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"]')?.content ?? '';
    (globalThis as typeof globalThis & { cspInlineRan?: boolean }).cspInlineRan = false;
    const script = document.createElement('script');
    script.textContent = 'globalThis.cspInlineRan = true';
    document.head.appendChild(script);

    const { testJavaScriptEvalBlocked } = await import('/src/security-policy.ts');
    const evalBlocked = testJavaScriptEvalBlocked();

    const image = document.createElement('img');
    image.src = 'https://csp-probe.test/direct.png';
    document.body.appendChild(image);
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    return {
      policy,
      inlineRan: (globalThis as typeof globalThis & { cspInlineRan?: boolean }).cspInlineRan,
      evalBlocked,
    };
  });

  expect(result.policy).toContain("default-src 'self'");
  expect(result.policy).toContain("worker-src 'self'");
  expect(result.policy).toContain("script-src-attr 'none'");
  expect(result.inlineRan).toBe(false);
  expect(result.evalBlocked).toBe(true);
  expect(remoteRequests).toBe(0);
});

test('oversized documents are rejected before their contents are read', async ({ page }) => {
  await page.goto('/?new=1');
  const result = await page.evaluate(async () => {
    const app = window as typeof window & {
      view: import('prosemirror-view').EditorView;
      __fm: {
        loadHandle(handle: FileSystemFileHandle): Promise<boolean>;
        handle: FileSystemFileHandle | null;
      };
    };
    const before = app.view.state.doc.toJSON();
    let reads = 0;
    const handle = {
      kind: 'file',
      name: 'oversized.typ',
      async getFile() {
        return {
          name: 'oversized.typ',
          size: 33 * 1024 * 1024,
          async text() {
            reads++;
            throw new Error('oversized file contents should never be read');
          },
        } as File;
      },
    } as FileSystemFileHandle;
    const opened = await app.__fm.loadHandle(handle);
    return {
      opened,
      reads,
      unchanged: JSON.stringify(before) === JSON.stringify(app.view.state.doc.toJSON()),
      attached: app.__fm.handle !== null,
    };
  });

  expect(result).toEqual({ opened: false, reads: 0, unchanged: true, attached: false });
  await expect(page.locator('#toast')).toContainText("oversized.typ is larger than Plass's 32 MiB limit");
});

test('Typst SVG boundary strips active content and preserves safe glyph references', async ({ page }) => {
  await page.goto('/?new=1');
  const result = await page.evaluate(async () => {
    const { mountTypstSvg } = await import('/src/safe-svg.ts');
    const host = document.createElement('div');
    mountTypstSvg(
      host,
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
        <script data-bad="script">globalThis.compromised = true</script>
        <foreignObject data-bad="foreign"><div xmlns="http://www.w3.org/1999/xhtml">bad</div></foreignObject>
        <image data-bad="remote-image" href="https://tracker.invalid/pixel.png" onerror="globalThis.compromised = true"/>
        <a data-bad="js-link" xlink:href="javascript:alert(1)" onclick="globalThis.compromised = true"><text>bad</text></a>
        <a data-safe="web-link" href="https://example.com/paper"><text>safe</text></a>
        <path id="glyph" d="M0 0"/>
        <use data-safe="glyph" href="#glyph"/>
      </svg>`,
    );
    const attrs = [...host.querySelectorAll('*')].flatMap((el) =>
      el.getAttributeNames().map((name) => `${name}=${el.getAttribute(name)}`),
    );
    return {
      activeElements: host.querySelectorAll('script, foreignObject, iframe, object, embed').length,
      remoteImageHref: host.querySelector('[data-bad="remote-image"]')?.getAttribute('href') ?? null,
      jsHref: host.querySelector('[data-bad="js-link"]')?.getAttribute('href') ??
        host.querySelector('[data-bad="js-link"]')?.getAttribute('xlink:href') ?? null,
      eventAttrs: attrs.filter((attr) => /^on/i.test(attr)),
      safeHref: host.querySelector('[data-safe="web-link"]')?.getAttribute('href') ?? null,
      safeRel: host.querySelector('[data-safe="web-link"]')?.getAttribute('rel') ?? null,
      glyphHref: host.querySelector('[data-safe="glyph"]')?.getAttribute('href') ??
        host.querySelector('[data-safe="glyph"]')?.getAttribute('xlink:href') ?? null,
      compromised: Boolean((globalThis as typeof globalThis & { compromised?: boolean }).compromised),
    };
  });

  expect(result.activeElements).toBe(0);
  expect(result.remoteImageHref).toBeNull();
  expect(result.jsHref).toBeNull();
  expect(result.eventAttrs).toEqual([]);
  expect(result.safeHref).toBe('https://example.com/paper');
  expect(result.safeRel).toContain('noopener');
  expect(result.glyphHref).toBe('#glyph');
  expect(result.compromised).toBe(false);
});

test('extraction path keeps the tsel text layer but stays inert', async ({ page }) => {
  await page.goto('/?new=1');
  const result = await page.evaluate(async () => {
    const { parseTypstSvg } = await import('/src/safe-svg.ts');
    // Shape mirrors typst.ts output: h5:-prefixed HTML inside foreignObject.
    const div = parseTypstSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:h5="http://www.w3.org/1999/xhtml">
        <g class="typst-page">
          <foreignObject width="10" height="10"><h5:div class="tsel" style="font-size: 62px">Line one text</h5:div></foreignObject>
          <foreignObject width="10" height="10"><h5:div class="tsel" onclick="globalThis.compromised = true"><script>globalThis.compromised = true</script><iframe src="https://evil.invalid"></iframe>Line two text</h5:div></foreignObject>
        </g>
      </svg>`,
    );
    return {
      tselTexts: [...div.querySelectorAll('.tsel')].map((el) => el.textContent),
      active: div.querySelectorAll('script, iframe, object, embed').length,
      eventAttrs: [...div.querySelectorAll('*')].flatMap((el) =>
        el.getAttributeNames().filter((name) => /^on/i.test(name)),
      ),
      compromised: Boolean((globalThis as typeof globalThis & { compromised?: boolean }).compromised),
    };
  });

  expect(result.tselTexts).toEqual(['Line one text', 'Line two text']);
  expect(result.active).toBe(0);
  expect(result.eventAttrs).toEqual([]);
  expect(result.compromised).toBe(false);
});

test('hostile bibliography values never become autocomplete markup', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const app = window as typeof window & { view: import('prosemirror-view').EditorView };
    const content = `
@article{safe-key,
  author = {Example, Alice},
  title = {<img src=x onerror=alert(1)>},
  year = {2026}
}
@article{<img/src=x/onerror=alert(1)>, title={Invalid Key}}
`;
    app.view.dispatch(app.view.state.tr.setDocAttribute('bib', { name: 'hostile.bib', content }));
  });

  const editor = page.locator('.ProseMirror[contenteditable="true"]');
  await editor.click();
  await page.keyboard.type('@');
  await expect(page.locator('.ref-menu')).toBeVisible();
  await expect(page.locator('.ref-menu img')).toHaveCount(0);
  await expect(page.locator('.ref-menu')).toContainText('<img src=x onerror=alert(1');
  await expect(page.locator('.ref-menu')).not.toContainText('Invalid Key');
});

test('compiled bibliography SVG cannot restore a dangerous URL', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const app = window as typeof window & { view: import('prosemirror-view').EditorView };
    const { state } = app.view;
    const citation = state.schema.nodes.citation.create({ key: 'safe' });
    const bibliography = state.schema.nodes.bibliography.create();
    let tr = state.tr.replaceWith(1, 1, citation);
    tr = tr.insert(tr.doc.content.size, bibliography);
    tr = tr.setDocAttribute('bib', {
      name: 'hostile-link.bib',
      content: '@misc{safe, title={Link Probe}, author={Example, Alice}, year={2026}, url={javascript:alert(1)}}',
    });
    app.view.dispatch(tr);
  });

  const ink = page.locator('.bib-ink');
  await expect(ink.locator('svg')).toBeVisible({ timeout: 20_000 });
  await expect(ink.locator('use')).not.toHaveCount(0);
  const active = await ink.locator('*').evaluateAll((els) =>
    els.flatMap((el) =>
      el.getAttributeNames()
        .filter((name) => name.startsWith('on') || /^(?:href|xlink:href)$/i.test(name))
        .map((name) => `${name}=${el.getAttribute(name)}`),
    ),
  );
  expect(active.some((attr) => /javascript:/i.test(attr))).toBe(false);
  expect(active.some((attr) => /^on/i.test(attr))).toBe(false);
});

test('raw Typst previews use the sanitized SVG boundary', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const app = window as typeof window & { view: import('prosemirror-view').EditorView };
    const { state } = app.view;
    const raw = state.schema.nodes.code_block.create(
      { params: 'typst-raw' },
      state.schema.text('#link("javascript:alert(1)")[danger]'),
    );
    app.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, raw));
  });

  const render = page.locator('.ts-raw-render');
  await expect(render.locator('svg')).toHaveCount(1, { timeout: 20_000 });
  const active = await render.locator('*').evaluateAll((elements) =>
    elements.flatMap((element) =>
      element.getAttributeNames()
        .filter((name) => name.startsWith('on') || /^(?:href|xlink:href)$/i.test(name))
        .map((name) => `${name}=${element.getAttribute(name)}`),
    ),
  );
  expect(active.some((attribute) => /javascript:/i.test(attribute))).toBe(false);
  expect(active.some((attribute) => /^on/i.test(attribute))).toBe(false);
});

test('compiler package policy makes only one pinned integrity-checked request', async ({ page }) => {
  const packageRequests: string[] = [];
  await page.route('https://packages.typst.org/**', async (route) => {
    packageRequests.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/gzip',
      headers: { 'access-control-allow-origin': '*' },
      body: Buffer.from('tampered package'),
    });
  });
  await page.goto('/?new=1');

  const unsupported = await page.evaluate(async () => {
    const { compileSvg } = await import('/src/pdf.ts');
    return compileSvg('#import "@preview/not-a-real-package:9.9.9": *\n[probe]');
  });
  expect(unsupported).toBeNull();
  expect(packageRequests).toEqual([]);

  const tampered = await page.evaluate(async () => {
    const { compileSvg } = await import('/src/pdf.ts');
    return compileSvg('#import "@preview/mitex:0.2.5": mitex\n#mitex(`x`)');
  });
  expect(tampered).toBeNull();
  expect(packageRequests).toEqual(['https://packages.typst.org/preview/mitex-0.2.5.tar.gz']);
});

test('compiler timeout circuit blocks automatic retries until a document edit resets it', async ({ page }) => {
  await page.goto('/?new=1');
  const result = await page.evaluate(async () => {
    const app = window as typeof window & { view: import('prosemirror-view').EditorView };
    const { state } = app.view;
    const raw = state.schema.nodes.code_block.create(
      { params: 'typst-raw' },
      state.schema.text('#rect(width: 20pt, height: 20pt)'),
    );
    app.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, raw));

    const { testCompilerLifecycleStats, testCompilerTimeoutCircuitBreaker } =
      await import('/src/typst-worker-client.ts');
    let uiTicks = 0;
    const timer = window.setInterval(() => uiTicks++, 10);
    const started = performance.now();
    const circuit = await testCompilerTimeoutCircuitBreaker();
    const watchdogMs = performance.now() - started;
    window.clearInterval(timer);

    // compileSvg is the error-erasing wrapper used by raw previews and math
    // ink. It must fail fast while the circuit is open, and the raw node's
    // own delayed retry must do the same without creating or feeding a worker.
    const { compileSvg, compileTyp, typstQuery } = await import('/src/pdf.ts');
    const beforeRetry = testCompilerLifecycleStats();
    const blockedSvg = await compileSvg('[automatic retry must stay blocked]');
    const blockedQuery = await typstQuery('[automatic query must stay blocked]', 'metadata');
    await new Promise((resolve) => window.setTimeout(resolve, 1_400));
    const afterRetry = testCompilerLifecycleStats();

    // A real editor transaction is the central reset boundary. The next
    // background compile and PDF task should run on a fresh worker.
    const edited = app.view.state;
    app.view.dispatch(edited.tr.insert(
      edited.doc.content.size,
      edited.schema.nodes.paragraph.create(null, edited.schema.text('new user input')),
    ));
    const afterEdit = testCompilerLifecycleStats();
    const svg = await compileSvg('[worker recovered]');
    const pdf = await compileTyp('[worker recovered]');
    return {
      code: circuit.timedOut.code,
      canceledCodes: circuit.canceled.map((error) => error.code),
      canceledMessages: circuit.canceled.map((error) => error.message),
      watchdogMs,
      uiTicks,
      blockedSvg,
      blockedQuery,
      stayedOpen: beforeRetry.circuitOpen && afterRetry.circuitOpen,
      noRetryWorker: beforeRetry.workersCreated === afterRetry.workersCreated,
      noRetryWork: beforeRetry.tasksPosted === afterRetry.tasksPosted,
      automaticAttemptsBlocked: afterRetry.circuitRejects > beforeRetry.circuitRejects,
      idleWhileOpen: !afterRetry.active && afterRetry.queued === 0,
      resetByEdit: !afterEdit.circuitOpen,
      hasSvg: svg?.includes('<svg') ?? false,
      pdfHeader: pdf ? new TextDecoder().decode(pdf.slice(0, 5)) : '',
    };
  });

  expect(result.code).toBe('timeout');
  expect(result.canceledCodes).toEqual(['timeout', 'timeout', 'timeout']);
  expect(result.canceledMessages.every((message) => message.includes('earlier request timed out'))).toBe(true);
  expect(result.watchdogMs).toBeLessThan(2_000);
  expect(result.uiTicks).toBeGreaterThan(0);
  expect(result.blockedSvg).toBeNull();
  expect(result.blockedQuery).toBeNull();
  expect(result.stayedOpen).toBe(true);
  expect(result.noRetryWorker).toBe(true);
  expect(result.noRetryWork).toBe(true);
  expect(result.automaticAttemptsBlocked).toBe(true);
  expect(result.idleWhileOpen).toBe(true);
  expect(result.resetByEdit).toBe(true);
  expect(result.hasSvg).toBe(true);
  expect(result.pdfHeader).toBe('%PDF-');
});

test('an explicit PDF export resets an open compiler circuit', async ({ page }) => {
  await page.goto('/?new=1');
  const result = await page.evaluate(async () => {
    const app = window as typeof window & { view: import('prosemirror-view').EditorView };
    const { testCompilerLifecycleStats, testCompilerTimeoutCircuitBreaker } =
      await import('/src/typst-worker-client.ts');
    await testCompilerTimeoutCircuitBreaker();
    const before = testCompilerLifecycleStats();

    const messages: string[] = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = () => {};
    try {
      const { exportPdf } = await import('/src/pdf.ts');
      await exportPdf(app.view.state.doc, 'circuit-export', (message) => messages.push(message));
    } finally {
      HTMLAnchorElement.prototype.click = click;
    }
    const after = testCompilerLifecycleStats();
    return {
      wasOpen: before.circuitOpen,
      reset: !after.circuitOpen,
      postedFreshWork: after.tasksPosted > before.tasksPosted,
      exported: messages.some((message) => message.startsWith('Exported circuit-export.pdf')),
    };
  });

  expect(result).toEqual({ wasOpen: true, reset: true, postedFreshWork: true, exported: true });
});

test('an old compiler timeout preserves work from a newer document epoch', async ({ page }) => {
  await page.goto('/?new=1');
  const result = await page.evaluate(async () => {
    const app = window as typeof window & { view: import('prosemirror-view').EditorView };
    const { CompilerWorkerError, runCompilerTask, testCompilerLifecycleStats } =
      await import('/src/typst-worker-client.ts');
    const before = testCompilerLifecycleStats();

    // A starts immediately in the old epoch. The document edit advances the
    // epoch while A is still occupying the worker, so B queues behind A with
    // a newer stamp. A's timeout must terminate only A and then pump B.
    const old = runCompilerTask(
      { kind: 'test-busy', milliseconds: 5_000 },
      { timeoutMs: 75 },
    ).then(
      () => null,
      (error: unknown) => error instanceof CompilerWorkerError ? error.code : String(error),
    );
    const state = app.view.state;
    app.view.dispatch(state.tr.insertText('fresh input', 1));
    const afterEdit = testCompilerLifecycleStats();
    const newer = runCompilerTask<string>(
      { kind: 'svg', source: '#set page(width: 120pt, height: auto, margin: 0pt)\n[new epoch]' },
      { timeoutMs: 20_000 },
    );

    const [oldCode, svg] = await Promise.all([old, newer]);
    const after = testCompilerLifecycleStats();
    return {
      oldCode,
      epochAdvanced: afterEdit.epoch === before.epoch + 1,
      remainedOpen: after.circuitOpen,
      newerRan: svg.includes('<svg'),
      replacementWorker: after.workersCreated > before.workersCreated + 1,
      replacementWorkPosted: after.tasksPosted > before.tasksPosted + 1,
    };
  });

  expect(result).toEqual({
    oldCode: 'timeout',
    epochAdvanced: true,
    remainedOpen: false,
    newerRan: true,
    replacementWorker: true,
    replacementWorkPosted: true,
  });
});

test('native table focus is inert and a cell edit authorizes a fresh compiler epoch', async ({ page }) => {
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const app = window as typeof window & { view: import('prosemirror-view').EditorView };
    const { schema } = app.view.state;
    const cell = (text: string) => schema.nodes.table_cell.create(
      null,
      schema.nodes.paragraph.create(null, schema.text(text)),
    );
    const table = schema.nodes.table.create(
      { style: 'booktabs' },
      schema.nodes.table_row.create(null, [cell('A'), cell('B')]),
    );
    const state = app.view.state;
    app.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, table));
  });

  await expect(page.locator('.ProseMirror table')).toHaveCount(1);
  await expect(page.locator('.table-card-overlay, .ts-table-preview')).toHaveCount(0);

  const beforeFocus = await page.evaluate(async () => {
    const { testCompilerLifecycleStats, testCompilerTimeoutCircuitBreaker } =
      await import('/src/typst-worker-client.ts');
    // Let the document's legitimate compile settle before deterministically
    // opening the circuit. Native tables launch no private preview compile.
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    for (let i = 0; i < 100; i++) {
      const stats = testCompilerLifecycleStats();
      if (!stats.active && stats.queued === 0) break;
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    await testCompilerTimeoutCircuitBreaker();
    return testCompilerLifecycleStats();
  });

  await page.locator('.ProseMirror td').first().click();
  const afterFocus = await page.evaluate(async () => {
    const { testCompilerLifecycleStats } = await import('/src/typst-worker-client.ts');
    return testCompilerLifecycleStats();
  });
  await page.keyboard.type('X');
  const afterInput = await page.evaluate(async () => {
    const { testCompilerLifecycleStats } = await import('/src/typst-worker-client.ts');
    return testCompilerLifecycleStats();
  });

  expect(beforeFocus.circuitOpen).toBe(true);
  expect(afterFocus).toMatchObject({ circuitOpen: true, epoch: beforeFocus.epoch });
  expect(afterInput.epoch).toBe(beforeFocus.epoch + 1);
  expect(afterInput.circuitOpen).toBe(false);
});

test('compiler circuit breaker leaves the successful queue path byte-stable', async ({ page }) => {
  await page.goto('/?new=1');
  const result = await page.evaluate(async () => {
    const { runCompilerTask } = await import('/src/typst-worker-client.ts');
    const source = '#set page(width: 120pt, height: auto, margin: 0pt)\n[stable queue output]';
    const compile = () => runCompilerTask<string>(
      { kind: 'svg', source },
      { timeoutMs: 20_000 },
    );

    // The second call is queued behind the first. A later third call proves
    // that both the queued and idle-worker paths produce the same bytes.
    const [first, queued] = await Promise.all([compile(), compile()]);
    const fresh = await compile();
    return {
      isSvg: first.includes('<svg'),
      queuedMatches: queued === first,
      freshMatches: fresh === first,
    };
  });

  expect(result).toEqual({ isSvg: true, queuedMatches: true, freshMatches: true });
});

test('remote images make no request until the user grants their origin', async ({ page }) => {
  let requests = 0;
  await page.route('https://remote.test/pixel.png', async (route) => {
    requests++;
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'access-control-allow-origin': '*' },
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    });
  });

  await page.goto('/?new=1');
  await page.evaluate(() => {
    const app = window as typeof window & { view: import('prosemirror-view').EditorView };
    const { state } = app.view;
    const src = 'https://remote.test/pixel.png';
    const figure = state.schema.nodes.figure.create({ src }, state.schema.text('Remote figure'));
    const inline = state.schema.nodes.image.create({ src, alt: 'Remote inline image' });
    const paragraph = state.schema.nodes.paragraph.create(null, [state.schema.text('Inline: '), inline]);
    app.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, [figure, paragraph]));
  });

  const figure = page.locator('.ts-figure');
  const inline = page.locator('.ts-inline-image');
  await expect(figure.locator('.fig-path-chip.remote')).toBeVisible();
  await expect(inline.locator('.inline-image-action')).toContainText('Load image from remote.test');
  await page.waitForTimeout(1_000);

  expect(requests).toBe(0);
  await expect(figure.locator('img')).not.toHaveAttribute('src', /remote\.test/);
  await expect(inline.locator('img')).not.toHaveAttribute('src', /remote\.test/);

  await figure.locator('.fig-path-chip.remote').click();
  await expect.poll(() => requests).toBe(1);
  await expect(figure.locator('img')).toHaveAttribute('src', /^blob:/);
  await expect(inline.locator('img')).toHaveAttribute('src', /^blob:/);
  // Both node views and background export code share a one-fetch byte cache.
  expect(requests).toBe(1);
});

test('embedded SVG images cannot smuggle an automatic remote subrequest', async ({ page }) => {
  let requests = 0;
  await page.route('https://tracker.test/pixel.png', async (route) => {
    requests++;
    await route.abort();
  });
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const app = window as typeof window & { view: import('prosemirror-view').EditorView };
    const { state } = app.view;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">
      <image href="https://tracker.test/pixel.png" width="20" height="20"/>
      <script>alert(1)</script>
    </svg>`;
    const src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    const figure = state.schema.nodes.figure.create({ src }, state.schema.text('Embedded SVG'));
    app.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, figure));
  });

  await expect(page.locator('.ts-figure img')).toHaveAttribute('src', /^blob:/);
  await page.waitForTimeout(500);
  expect(requests).toBe(0);
});

test('a failed approved image is retried only by another user action', async ({ page }) => {
  let requests = 0;
  await page.route('https://flaky.test/pixel.png', async (route) => {
    requests++;
    if (requests === 1) {
      await route.fulfill({ status: 503, body: 'unavailable' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'access-control-allow-origin': '*' },
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    });
  });
  await page.goto('/?new=1');
  await page.evaluate(() => {
    const app = window as typeof window & { view: import('prosemirror-view').EditorView };
    const { state } = app.view;
    const figure = state.schema.nodes.figure.create(
      { src: 'https://flaky.test/pixel.png' },
      state.schema.text('Flaky figure'),
    );
    app.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, figure));
  });

  await page.locator('.fig-path-chip.remote').click();
  await expect(page.locator('.fig-path-chip.remote-error')).toContainText('retry from flaky.test');
  await page.waitForTimeout(750);
  expect(requests).toBe(1);

  await page.locator('.fig-path-chip.remote-error').click();
  await expect.poll(() => requests).toBe(2);
  await expect(page.locator('.ts-figure img')).toHaveAttribute('src', /^blob:/);
  await expect(page.locator('.fig-path-chip.remote-error')).toHaveCount(0);
});
