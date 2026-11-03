import { test, expect } from '@playwright/test';

// ?e2e=1 swaps the AI transcription for a fixed fake one, so CI doesn't download the model.
const FIXTURE = 'tests/fixtures/sample.mp4';

function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g/.test(m.text())) errors.push(m.text()); });
  return errors;
}

for (const path of ['/', '/es/', '/pt/', '/privacy/', '/es/privacy/', '/pt/terms/']) {
  test(`page ${path} loads without errors`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(`${path}?e2e=1`);
    await expect(page.locator('h1')).toBeVisible();
    expect(errors).toEqual([]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
}

test('Spanish page is fully translated', async ({ page }) => {
  await page.goto('/es/?e2e=1');
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expect(page.locator('.drop-title')).toHaveText('Soltá tu video acá');
});

test('upload → captions → edit → fake door → export', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?e2e=1');
  await page.evaluate(() => { window.WF.debug = true; });
  const tracked = [];
  page.on('console', (m) => { if (m.text().startsWith('[track]')) tracked.push(m.text()); });

  await page.setInputFiles('#fileInput', FIXTURE);
  await expect(page.locator('#app')).toHaveAttribute('data-state', 'editor', { timeout: 20_000 });
  await expect(page.locator('#frame')).toBeVisible();
  expect(await page.locator('#frame').evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(200);
  await expect(page.locator('#exportProg')).toBeHidden();

  // style
  await page.click('.style-btn[data-style="neon"]');
  expect(await page.evaluate(() => window.__wf.state.style)).toBe('neon');

  // edit first caption
  await page.click('.tab[data-tab="text"]');
  const first = page.locator('#lines .line-text').first();
  await first.click();
  await first.fill('Hello brand new world');
  await first.press('Enter');
  expect(await page.evaluate(() => window.__wf.state.chunks[0].words.map((w) => w.text).join(' '))).toBe('Hello brand new world');

  // fake door
  await page.click('.tab[data-tab="pro"]');
  await page.click('[data-door="autoplace"]');
  await expect(page.locator('#doorDialog')).toBeVisible();
  expect(tracked.some((t) => t.includes('fake_door_autoplace'))).toBe(true);
  await page.click('#doorDialog .dlg-x');

  // srt
  const srt = page.waitForEvent('download');
  await page.click('#srtBtn');
  expect((await srt).suggestedFilename()).toMatch(/\.srt$/);

  // export
  const video = page.waitForEvent('download', { timeout: 30_000 });
  await page.click('#exportBtn');
  expect((await video).suggestedFilename()).toMatch(/-wordflare\.(mp4|webm)$/);

  expect(errors).toEqual([]);
});

test('videos longer than the free limit open the Pro door', async ({ page }) => {
  await page.goto('/?e2e=1');
  await page.evaluate(() => window.__wf.openDoor('longvideo'));
  await expect(page.locator('#doorDialog')).toBeVisible();
});
