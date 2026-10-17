// Takes the README's screenshots (docs/images/*.png) from the demo
// document. Run it whenever the app's look changes:
//
//   npm run dev                       (in another terminal)
//   npm run screenshots
//
// PLASS_URL points it at another server (default http://127.0.0.1:5199).

import { chromium, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';

const url = process.env.PLASS_URL ?? 'http://127.0.0.1:5199';
const out = 'docs/images';

// Wait until pagination has run at least once and then stayed quiet.
async function settle(page: Page, quietMs = 1200): Promise<void> {
  await page.waitForFunction(() => typeof (window as any).__pagCount === 'function');
  let seen = -1;
  let seenAt = Date.now();
  for (;;) {
    const n = await page.evaluate(() => (window as any).__pagCount() as number);
    if (n !== seen) {
      seen = n;
      seenAt = Date.now();
    } else if (n > 0 && Date.now() - seenAt >= quietMs) {
      return;
    }
    await page.waitForTimeout(200);
  }
}

// Scroll the editor so the element sits `offset` px below the window's top.
async function scrollTo(page: Page, selector: string, offset: number): Promise<void> {
  await page.evaluate(
    ([sel, off]) => {
      const scroller = document.getElementById('scroll')!;
      const el = document.querySelector(sel as string)!;
      const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTop += top - (off as number);
    },
    [selector, offset],
  );
  await page.waitForTimeout(300);
}

async function open(width: number, height: number): Promise<Page> {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    colorScheme: 'light',
  });
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForSelector('.ProseMirror');
  await settle(page);
  return page;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(`${out}/${name}.png`);
  await page.context().browser()!.close();
}

mkdirSync(out, { recursive: true });

// A whole first page: title, justified text, the footnote at its foot.
{
  const page = await open(760, 950);
  await shot(page, 'page');
}

// Math: a display equation open in its editor, LaTeX above the result.
{
  const page = await open(1100, 640);
  await scrollTo(page, '.ProseMirror .math-display', 200);
  await page.locator('.ProseMirror .math-display').first().click();
  await page.waitForTimeout(800);
  await shot(page, 'math');
}

// A table being edited: the caret in a cell, its controls in the margin.
{
  const page = await open(1100, 640);
  await scrollTo(page, '.ProseMirror table', 170);
  await page.locator('.ProseMirror table td').nth(4).click();
  await page.waitForTimeout(600);
  await shot(page, 'table');
}

// The same document as Markdown text (⌘/).
{
  const page = await open(1100, 640);
  await page.locator('.ProseMirror h1').first().click();
  await page.keyboard.press('ControlOrMeta+Slash');
  await page.waitForTimeout(1200);
  await shot(page, 'plain-text');
}
