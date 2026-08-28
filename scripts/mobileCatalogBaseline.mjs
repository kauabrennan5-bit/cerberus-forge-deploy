import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const targets = [
  { label: 'branch-local', url: process.env.LOCAL_BASE_URL || 'http://127.0.0.1:4173' },
  { label: 'production-live', url: process.env.LIVE_BASE_URL || 'https://cerberus-static-catalog.onrender.com' },
];

const outDir = process.env.ARTIFACT_DIR || 'mobile-baseline-artifacts';
await fs.mkdir(outDir, { recursive: true });

async function dispatchVerticalTouch(page, x, y, distance = 180) {
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y, radiusX: 4, radiusY: 4, force: 1 }],
  });
  for (const delta of [30, 70, 120, distance]) {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + 2, y: y - delta, radiusX: 4, radiusY: 4, force: 1 }],
    });
    await page.waitForTimeout(35);
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(350);
}

async function auditTarget(browser, target) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    screen: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    locale: 'pt-BR',
  });
  const page = await context.newPage();
  const result = {
    label: target.label,
    url: target.url,
    loaded: false,
    consoleErrors: [],
    cardHeights: [],
    cardHeightSpread: null,
    categories: [],
    scrollRestore: null,
    relatedVerticalTouch: null,
    errors: [],
  };
  page.on('console', (msg) => {
    if (msg.type() === 'error') result.consoleErrors.push(msg.text());
  });
  page.on('pageerror', (error) => result.consoleErrors.push(`pageerror:${error.message}`));

  try {
    await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForSelector('[id^="product-card-"]', { timeout: 45_000 });
    result.loaded = true;
    await page.screenshot({ path: `${outDir}/${target.label}-catalog-390.png`, fullPage: true });

    const cards = page.locator('[id^="product-card-"]');
    const cardCount = await cards.count();
    for (let i = 0; i < cardCount; i += 1) {
      const box = await cards.nth(i).boundingBox();
      if (box) result.cardHeights.push(Math.round(box.height * 100) / 100);
    }
    if (result.cardHeights.length) {
      result.cardHeightSpread = Math.round((Math.max(...result.cardHeights) - Math.min(...result.cardHeights)) * 100) / 100;
    }

    const categoryToggle = page.locator('button[aria-controls="category-panel"]');
    if (await categoryToggle.count()) {
      await categoryToggle.click();
      const panel = page.locator('#category-panel');
      await panel.waitFor({ state: 'visible' });
      result.categories = await panel.locator('button').evaluateAll((buttons) => buttons.map((button) => (button.textContent || '').replace(/\s+/g, ' ').trim()));
      await page.screenshot({ path: `${outDir}/${target.label}-categories-390.png`, fullPage: false });
      await categoryToggle.click();
    }

    const targetCard = cards.nth(Math.max(0, cardCount - 2));
    await targetCard.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, -120));
    await page.waitForTimeout(100);
    const beforeY = await page.evaluate(() => window.scrollY);
    const beforeCardId = await targetCard.getAttribute('id');
    await page.screenshot({ path: `${outDir}/${target.label}-scroll-before-detail-390.png`, fullPage: false });
    await targetCard.click({ position: { x: 30, y: 30 } });
    await page.waitForURL(/\/produto\//, { timeout: 15_000 });
    const detailPath = new URL(page.url()).pathname;
    await page.screenshot({ path: `${outDir}/${target.label}-detail-390.png`, fullPage: false });
    const backButton = page.getByRole('button', { name: /Voltar ao Acervo/i });
    await backButton.click();
    await page.waitForSelector('[id^="product-card-"]', { timeout: 10_000 });
    await page.waitForTimeout(650);
    const afterY = await page.evaluate(() => window.scrollY);
    result.scrollRestore = {
      beforeY,
      afterY,
      delta: Math.round(Math.abs(afterY - beforeY)),
      beforeCardId,
      detailPath,
    };
    await page.screenshot({ path: `${outDir}/${target.label}-scroll-after-back-390.png`, fullPage: false });

    await cards.first().click({ position: { x: 30, y: 30 } });
    await page.waitForURL(/\/produto\//, { timeout: 15_000 });
    const rail = page.getByRole('region', { name: /Produtos recomendados/i });
    if (await rail.count()) {
      await rail.scrollIntoViewIfNeeded();
      await page.waitForTimeout(150);
      const railBox = await rail.boundingBox();
      if (railBox) {
        const y0 = await page.evaluate(() => window.scrollY);
        const x = railBox.x + Math.min(railBox.width / 2, 150);
        const y = railBox.y + Math.min(railBox.height / 2, 160);
        await dispatchVerticalTouch(page, x, y, 190);
        const y1 = await page.evaluate(() => window.scrollY);
        result.relatedVerticalTouch = { beforeY: y0, afterY: y1, movedBy: Math.round(y1 - y0) };
        await page.screenshot({ path: `${outDir}/${target.label}-related-after-vertical-touch-390.png`, fullPage: false });
      }
    }
  } catch (error) {
    result.errors.push(error instanceof Error ? error.stack || error.message : String(error));
  } finally {
    await context.close();
  }
  return result;
}

const browser = await chromium.launch({ headless: true });
const results = [];
for (const target of targets) results.push(await auditTarget(browser, target));
await browser.close();
await fs.writeFile(`${outDir}/baseline.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
