import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const OUT = process.env.OUT_DIR || 'dist';
const file = path.join(OUT, 'sites.json');
const sites = JSON.parse(await readFile(file, 'utf8'));
await mkdir(path.join(OUT, 'icons'), { recursive: true });

const EXT = {
  'image/svg+xml': 'svg', 'image/png': 'png', 'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp'
};

function iconHref(html) {
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
  const get = (t, a) => {
    const m = t.match(new RegExp(a + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'i'));
    return m && (m[1] ?? m[2]);
  };
  const withRel = links.map((t) => ({ rel: (get(t, 'rel') || '').toLowerCase(), href: get(t, 'href') }))
                       .filter((l) => l.href);
  const normal = withRel.filter((l) => /\bicon\b/.test(l.rel) && !l.rel.includes('apple'));
  const apple = withRel.filter((l) => l.rel.includes('apple-touch-icon'));
  const svg = normal.find((l) => /\.svg|image\/svg/i.test(l.href));
  return (svg || normal[0] || apple[0])?.href;
}

async function grab(site) {
  const page = await fetch(site.url, { redirect: 'follow' });
  if (!page.ok) throw new Error('page HTTP ' + page.status);
  const href = iconHref(await page.text());

  let buf, mime;
  if (href && href.startsWith('data:')) {
    const m = href.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!m) throw new Error('data URI illisible');
    mime = m[1] || 'image/svg+xml';
    buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
  } else {
    const tries = [href && new URL(href, page.url).href, new URL('favicon.ico', page.url).href].filter(Boolean);
    for (const u of tries) {
      const r = await fetch(u, { redirect: 'follow' });
      const ct = (r.headers.get('content-type') || '').split(';')[0].trim();
      if (r.ok && (EXT[ct] || /\.(svg|png|ico|jpe?g|gif|webp)(\?|$)/i.test(u))) {
        buf = Buffer.from(await r.arrayBuffer());
        mime = EXT[ct] ? ct : 'image/' + (u.match(/\.(svg|png|ico|jpe?g|gif|webp)/i)[1].toLowerCase().replace('svg', 'svg+xml'));
        break;
      }
    }
  }
  if (!buf) throw new Error('aucun favicon trouvé');
  const ext = EXT[mime] || 'png';
  await writeFile(path.join(OUT, 'icons', `${site.id}.${ext}`), buf);
  site.favicon = `icons/${site.id}.${ext}`;
}

for (const s of sites) {
  try { await grab(s); console.log('icône ok :', s.id, '->', s.favicon); }
  catch (e) { console.warn('pas d\'icône pour', s.id, '-', e.message); }
}
await writeFile(file, JSON.stringify(sites, null, 2));
