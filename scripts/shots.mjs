import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const OUT = process.env.OUT_DIR || 'dist';
const sites = JSON.parse(await readFile(process.env.SITES_FILE || 'sites.json', 'utf8'));
await mkdir(`${OUT}/thumbs`, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
for (const s of sites) {
  try {
    await page.goto(s.url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${OUT}/thumbs/${s.id}.jpg`, type: 'jpeg', quality: 80 });
    console.log('capture ok :', s.id);
  } catch (e) {
    console.warn('pas de capture pour', s.id, '-', e.message);
  }
}
await browser.close();
