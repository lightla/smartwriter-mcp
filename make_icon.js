import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  const svgOn = `<svg width="128" height="128" viewBox="0 0 24 24" fill="none" stroke="#116466" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="background:transparent;"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>`;
  await page.setContent(svgOn);
  const el1 = await page.$('svg');
  await el1.screenshot({ path: 'extensions/chrome/src/icon-on.png', omitBackground: true });
  await el1.screenshot({ path: 'extensions/chrome/src/icon.png', omitBackground: true });
  
  const svgOff = `<svg width="128" height="128" viewBox="0 0 24 24" fill="none" stroke="#405551" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="background:transparent;"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>`;
  await page.setContent(svgOff);
  const el2 = await page.$('svg');
  await el2.screenshot({ path: 'extensions/chrome/src/icon-off.png', omitBackground: true });
  
  await browser.close();
})();
