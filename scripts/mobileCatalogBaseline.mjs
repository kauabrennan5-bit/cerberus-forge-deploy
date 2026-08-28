import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const baseUrl = process.env.LOCAL_BASE_URL || 'http://127.0.0.1:4173';
const outDir = process.env.ARTIFACT_DIR || 'mobile-validation-artifacts';
const viewports = [
  { label: '375', width: 375, height: 812, mobile: true },
  { label: '390', width: 390, height: 844, mobile: true },
  { label: '430', width: 430, height: 932, mobile: true },
  { label: '768', width: 768, height: 1024, mobile: false },
  { label: '1440', width: 1440, height: 900, mobile: false },
];

await fs.mkdir(outDir, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForCatalog(page) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('[data-testid="product-card"]', { timeout: 45_000 });
  await page.waitForTimeout(350);
}

async function openCategoryPanel(page) {
  const toggle = page.locator('button[aria-controls="category-panel"]');
  await toggle.scrollIntoViewIfNeeded();
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await page.locator('[data-testid="category-panel"]').waitFor({ state: 'visible' });
}

async function selectCategory(page, name) {
  await openCategoryPanel(page);
  const option = page.locator(`[data-testid="category-option-${name}"]`);
  assert(await option.count(), `category option missing: ${name}`);
  await option.click();
  await page.waitForTimeout(150);
}

async function selectAll(page) {
  await openCategoryPanel(page);
  const reset = page.getByRole('button', { name: /Ver todo o acervo/i });
  if (await reset.count()) {
    await reset.click();
    await page.waitForTimeout(120);
  } else {
    const toggle = page.locator('button[aria-controls="category-panel"]');
    if ((await toggle.getAttribute('aria-expanded')) === 'true') await toggle.click();
  }
}

async function dispatchTouch(page, points) {
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const first = points[0];
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: first.x, y: first.y, radiusX: 5, radiusY: 5, force: 1 }],
  });
  for (const point of points.slice(1)) {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: point.x, y: point.y, radiusX: 5, radiusY: 5, force: 1 }],
    });
    await page.waitForTimeout(40);
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(450);
}

function interpolate(x0, y0, x1, y1, steps = 5) {
  return Array.from({ length: steps + 1 }, (_, i) => ({
    x: x0 + ((x1 - x0) * i) / steps,
    y: y0 + ((y1 - y0) * i) / steps,
  }));
}

async function measureCards(page) {
  const cards = page.locator('[data-testid="product-card"]');
  const count = await cards.count();
  const measurements = [];
  for (let i = 0; i < count; i += 1) {
    const card = cards.nth(i);
    const box = await card.boundingBox();
    if (!box) continue;
    const imageBox = await card.locator('img').first().boundingBox().catch(() => null);
    measurements.push({ id: await card.getAttribute('data-product-id'), height: box.height, imageHeight: imageBox?.height ?? null });
  }
  const heights = measurements.map((m) => m.height);
  const spread = heights.length ? Math.max(...heights) - Math.min(...heights) : Infinity;
  return { count, spread, measurements };
}

async function assertNoGlobalHorizontalOverflow(page, label) {
  const widths = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  assert(widths.scrollWidth <= widths.clientWidth + 2, `${label}: document horizontal overflow ${JSON.stringify(widths)}`);
  assert(widths.bodyScrollWidth <= widths.clientWidth + 2, `${label}: body horizontal overflow ${JSON.stringify(widths)}`);
  return widths;
}

async function openCardAndBack(page, card, contextLabel) {
  await card.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -110));
  await page.waitForTimeout(120);
  const beforeY = await page.evaluate(() => window.scrollY);
  const cardId = await card.getAttribute('data-product-id');
  const beforeBox = await card.boundingBox();
  await card.locator('[data-testid="product-card-link"]').click({ position: { x: 15, y: 15 } });
  await page.waitForURL(/\/produto\//, { timeout: 15_000 });
  const detailPath = new URL(page.url()).pathname;
  await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => null);
  await page.waitForSelector('[data-testid="product-card"]', { timeout: 15_000 });
  await page.waitForTimeout(650);
  const afterY = await page.evaluate(() => window.scrollY);
  const restored = page.locator(`[data-product-id="${cardId}"]`);
  const afterBox = await restored.boundingBox();
  const delta = Math.abs(afterY - beforeY);
  assert(delta <= 220, `${contextLabel}: scroll restoration delta too large (${beforeY} -> ${afterY}, delta ${delta})`);
  assert(afterBox, `${contextLabel}: originating card missing after back`);
  return { beforeY, afterY, delta, cardId, beforeTop: beforeBox?.y ?? null, afterTop: afterBox?.y ?? null, detailPath };
}

async function auditViewport(browser, viewport) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    screen: { width: viewport.width, height: viewport.height },
    isMobile: viewport.mobile,
    hasTouch: viewport.mobile,
    deviceScaleFactor: viewport.mobile ? 2 : 1,
    locale: 'pt-BR',
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && /(?:Uncaught|TypeError|ReferenceError|RangeError|SyntaxError)/i.test(msg.text())) consoleErrors.push(msg.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror:${error.message}`));

  const result = { viewport, cardLayout: null, overflow: null, categories: null, scroll: {}, relatedTouch: null, consoleErrors };
  try {
    await waitForCatalog(page);
    result.overflow = await assertNoGlobalHorizontalOverflow(page, viewport.label);

    const beforeImages = await measureCards(page);
    await page.waitForTimeout(1200);
    const afterImages = await measureCards(page);
    assert(afterImages.count >= 2, `${viewport.label}: insufficient catalog cards`);
    assert(afterImages.spread <= 3, `${viewport.label}: card height spread ${afterImages.spread.toFixed(2)}px`);
    assert(Math.abs(afterImages.spread - beforeImages.spread) <= 3, `${viewport.label}: card geometry spread shifted after images`);
    const beforeById = new Map(beforeImages.measurements.map((item) => [item.id, item.height]));
    for (const item of afterImages.measurements) {
      const beforeHeight = beforeById.get(item.id);
      if (typeof beforeHeight === 'number') assert(Math.abs(item.height - beforeHeight) <= 3, `${viewport.label}: card ${item.id} height shifted ${beforeHeight} -> ${item.height}`);
    }
    result.cardLayout = { beforeImages, afterImages };
    await page.screenshot({ path: `${outDir}/catalog-${viewport.label}.png`, fullPage: true });

    await openCategoryPanel(page);
    const categoryRows = await page.locator('[data-testid="category-panel"] button[data-testid^="category-option-"]').evaluateAll((buttons) => buttons.map((button) => ({
      testid: button.getAttribute('data-testid'),
      text: (button.textContent || '').replace(/\s+/g, ' ').trim(),
    })));
    const illumination = categoryRows.find((row) => row.testid === 'category-option-Iluminação');
    const kitchen = categoryRows.find((row) => row.testid === 'category-option-Cozinha & Mesa');
    assert(illumination && /0*[1-9]\d*\s+peças?/i.test(illumination.text), `${viewport.label}: Iluminação has no published products`);
    assert(kitchen && /0*[1-9]\d*\s+peças?/i.test(kitchen.text), `${viewport.label}: Cozinha & Mesa has no published products`);
    result.categories = categoryRows;
    await page.screenshot({ path: `${outDir}/categories-${viewport.label}.png`, fullPage: false });

    await selectCategory(page, 'Iluminação');
    const filteredCards = page.locator('[data-testid="product-card"]');
    assert(await filteredCards.count() >= 1, `${viewport.label}: category filter returned no cards`);
    result.scroll.category = await openCardAndBack(page, filteredCards.last(), `${viewport.label}/category`);
    assert((await page.locator('button[aria-controls="category-panel"]').textContent()).includes('Iluminação'), `${viewport.label}: category context not restored`);

    const search = page.getByPlaceholder('Buscar por peça, marca, tipo...');
    await selectAll(page);
    const firstTitle = ((await page.locator('[data-testid="product-card"] h3').first().textContent()) || '').trim();
    const query = firstTitle.split(/\s+/).find((part) => part.length >= 5)?.slice(0, 8) || firstTitle.slice(0, 5);
    assert(query.length >= 3, `${viewport.label}: unable to derive search query`);
    await search.fill(query);
    await page.waitForTimeout(150);
    const searchCards = page.locator('[data-testid="product-card"]');
    assert(await searchCards.count() >= 1, `${viewport.label}: search returned no cards for ${query}`);
    result.scroll.search = await openCardAndBack(page, searchCards.last(), `${viewport.label}/search`);
    assert((await search.inputValue()) === query, `${viewport.label}: search context not restored`);

    await search.fill('');
    await page.waitForTimeout(120);
    const catalogCards = page.locator('[data-testid="product-card"]');
    result.scroll.catalog = await openCardAndBack(page, catalogCards.nth(Math.max(0, (await catalogCards.count()) - 2)), `${viewport.label}/catalog`);

    if (viewport.mobile && viewport.label === '390') {
      await page.locator('[data-testid="product-card-link"]').first().click({ position: { x: 15, y: 15 } });
      await page.waitForURL(/\/produto\//, { timeout: 15_000 });
      const originalDetailPath = new URL(page.url()).pathname;
      const rail = page.locator('[data-testid="related-products-rail"]');
      await rail.waitFor({ state: 'visible', timeout: 15_000 });
      await rail.scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${outDir}/related-390.png`, fullPage: false });
      const relatedCard = rail.locator('[data-testid="product-card"]').first();
      assert(await relatedCard.count(), '390/related: no related cards');
      const box = await relatedCard.boundingBox();
      assert(box, '390/related: missing card box');
      const x = box.x + Math.min(box.width / 2, 90);
      const y = box.y + Math.min(box.height / 2, 120);

      const verticalState = await page.evaluate(() => ({ y: window.scrollY, max: Math.max(0, document.documentElement.scrollHeight - window.innerHeight) }));
      const verticalBefore = verticalState.y;
      const verticalFingerDelta = verticalState.max - verticalState.y > 120 ? -190 : 190;
      const pathBeforeVertical = new URL(page.url()).pathname;
      await dispatchTouch(page, interpolate(x, y, x + 3, y + verticalFingerDelta, 6));
      const verticalAfter = await page.evaluate(() => window.scrollY);
      assert(new URL(page.url()).pathname === pathBeforeVertical, '390/related vertical swipe navigated');
      assert(Math.abs(verticalAfter - verticalBefore) >= 45, `390/related vertical swipe did not scroll page (${verticalBefore} -> ${verticalAfter})`);

      await rail.scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollBy(0, -20));
      const railBox = await rail.boundingBox();
      assert(railBox, '390/related: missing rail box');
      await rail.evaluate((el) => { el.scrollLeft = 0; });
      const horizontalBefore = await rail.evaluate((el) => el.scrollLeft);
      const hx = railBox.x + Math.min(railBox.width - 30, 280);
      const hy = railBox.y + Math.min(railBox.height / 2, 120);
      const pathBeforeHorizontal = new URL(page.url()).pathname;
      await dispatchTouch(page, interpolate(hx, hy, hx - 180, hy + 2, 6));
      const horizontalAfter = await rail.evaluate((el) => el.scrollLeft);
      assert(new URL(page.url()).pathname === pathBeforeHorizontal, '390/related horizontal swipe navigated');
      assert(horizontalAfter - horizontalBefore >= 30, `390/related horizontal swipe did not move rail (${horizontalBefore} -> ${horizontalAfter})`);

      await rail.scrollIntoViewIfNeeded();
      const diagBox = await relatedCard.boundingBox();
      assert(diagBox, '390/related: missing diagonal card box');
      const diagState = await page.evaluate(() => ({ y: window.scrollY, max: Math.max(0, document.documentElement.scrollHeight - window.innerHeight) }));
      const diagBeforeY = diagState.y;
      const diagFingerDelta = diagState.max - diagState.y > 100 ? -165 : 165;
      const diagPath = new URL(page.url()).pathname;
      await dispatchTouch(page, interpolate(diagBox.x + 80, diagBox.y + 100, diagBox.x + 35, diagBox.y + 100 + diagFingerDelta, 6));
      const diagAfterY = await page.evaluate(() => window.scrollY);
      assert(new URL(page.url()).pathname === diagPath, '390/related diagonal gesture navigated');
      assert(Math.abs(diagAfterY - diagBeforeY) >= 25, `390/related diagonal gesture did not follow dominant vertical direction (${diagBeforeY} -> ${diagAfterY})`);

      await rail.scrollIntoViewIfNeeded();
      const tapLinks = rail.locator('[data-testid="product-card-link"]');
      const tapLinkCount = await tapLinks.count();
      let tapPoint = null;
      for (let i = 0; i < tapLinkCount; i += 1) {
        const tapBox = await tapLinks.nth(i).boundingBox();
        if (!tapBox) continue;
        const centerX = tapBox.x + Math.min(tapBox.width / 2, 90);
        const centerY = tapBox.y + Math.min(tapBox.height / 2, 100);
        if (centerX >= railBox.x + 12 && centerX <= railBox.x + railBox.width - 12) {
          tapPoint = { x: centerX, y: centerY };
          break;
        }
      }
      assert(tapPoint, '390/related: no visible related link available for native tap');
      const railBeforeTap = await rail.evaluate((el) => el.scrollLeft);
      await page.touchscreen.tap(tapPoint.x, tapPoint.y);
      await page.waitForURL(/\/produto\//, { timeout: 15_000 });
      const relatedDetailPath = new URL(page.url()).pathname;
      assert(relatedDetailPath !== originalDetailPath, '390/related tap did not open another product');
      await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => null);
      await page.waitForTimeout(500);
      assert(new URL(page.url()).pathname === originalDetailPath, `390/related back did not restore prior detail (${page.url()})`);
      const restoredRailLeft = await page.locator('[data-testid="related-products-rail"]').evaluate((el) => el.scrollLeft);
      assert(Math.abs(restoredRailLeft - railBeforeTap) <= 80, `390/related horizontal position not preserved (${railBeforeTap} -> ${restoredRailLeft})`);
      await page.screenshot({ path: `${outDir}/related-after-interactions-390.png`, fullPage: false });

      result.relatedTouch = {
        vertical: { before: verticalBefore, after: verticalAfter },
        horizontal: { before: horizontalBefore, after: horizontalAfter },
        diagonal: { before: diagBeforeY, after: diagAfterY },
        tap: { originalDetailPath, relatedDetailPath, restored: new URL(page.url()).pathname, railBefore: railBeforeTap, railAfter: restoredRailLeft },
      };
    }

    const directPath = result.scroll.catalog.detailPath;
    await page.goto(`${baseUrl}${directPath}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.getByRole('button', { name: /Voltar ao Acervo/i }).waitFor({ state: 'visible', timeout: 15_000 });
    const directBeforeRefresh = new URL(page.url()).pathname;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /Voltar ao Acervo/i }).waitFor({ state: 'visible', timeout: 15_000 });
    const directAfterRefresh = new URL(page.url()).pathname;
    assert(directAfterRefresh === directBeforeRefresh, `${viewport.label}: direct detail refresh changed route`);
    result.scroll.directRefresh = { before: directBeforeRefresh, after: directAfterRefresh, scrollY: await page.evaluate(() => window.scrollY) };

    assert(consoleErrors.length === 0, `${viewport.label}: browser runtime errors: ${consoleErrors.join(' | ')}`);
    return result;
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch({ headless: true });
const results = [];
let failure = null;
try {
  for (const viewport of viewports) {
    results.push(await auditViewport(browser, viewport));
  }
} catch (error) {
  failure = error instanceof Error ? error.stack || error.message : String(error);
} finally {
  await browser.close();
}

const report = { baseUrl, passed: !failure, failure, results };
await fs.writeFile(`${outDir}/validation.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (failure) process.exit(1);
