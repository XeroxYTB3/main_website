// Synchronise les sites listés dans sites.json.
// Pour chaque site : télécharge la version déployée (HTML + fichiers qu'elle utilise)
// et la range dans dist/<id>/  ->  le site est alors servi sur  ton-domaine.com/<id>/
//
// Aucune dépendance : Node 18 ou plus récent suffit.

import { readFile, writeFile, mkdir, rm, copyFile, access } from 'node:fs/promises';
import path from 'node:path';

const SITES_FILE = process.env.SITES_FILE || 'sites.json';
const OUT = process.env.OUT_DIR || 'dist';
const MAX_FILES = 800;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const kindOf = (file) =>
  /\.html?$/i.test(file) ? 'html' : /\.css$/i.test(file) ? 'css' : /\.m?js$/i.test(file) ? 'js' : 'other';

function findRefs(text, kind) {
  const out = new Set();
  if (kind === 'html') {
    for (const m of text.matchAll(/\b(?:src|href|poster|data-src)\s*=\s*["']([^"']+)["']/gi)) out.add(m[1]);
    for (const m of text.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi))
      m[1].split(',').forEach((s) => out.add(s.trim().split(/\s+/)[0]));
  }
  if (kind === 'html' || kind === 'css')
    for (const m of text.matchAll(/url\(\s*["']?([^"')]+?)["']?\s*\)/gi)) out.add(m[1]);
  if (kind === 'js')
    for (const m of text.matchAll(/(?:from|import)\s*["'](\.{0,2}\/[^"']+)["']/g)) out.add(m[1]);
  return out;
}

async function mirror(site) {
  if (!site.id || !/^[a-z0-9][a-z0-9._-]*$/i.test(site.id)) throw new Error(`id invalide : "${site.id}"`);
  if (!site.url) throw new Error('url manquante');

  const start = new URL(site.url);
  start.hash = '';
  const lastSeg = start.pathname.split('/').pop();
  let basePath;
  if (lastSeg.includes('.')) basePath = start.pathname.replace(/[^/]*$/, ''); // .../index.html -> .../
  else {
    if (!start.pathname.endsWith('/')) start.pathname += '/';
    basePath = start.pathname;
  }

  const dest = path.resolve(OUT, site.id);
  const queue = [start.href];
  const seen = new Set();
  const warned = new Set();
  let count = 0;

  while (queue.length) {
    const href = queue.shift();
    const url = new URL(href);
    const key = url.origin + url.pathname + url.search;
    if (seen.has(key)) continue;
    seen.add(key);
    if (++count > MAX_FILES) throw new Error(`plus de ${MAX_FILES} fichiers, arrêt de sécurité`);

    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) {
      if (url.href === start.href) throw new Error(`${url.href} -> HTTP ${res.status}`);
      console.warn(`  ! ignoré (HTTP ${res.status}) : ${url.pathname}`);
      continue;
    }
    const ctype = res.headers.get('content-type') || '';
    let rel = decodeURIComponent(url.pathname.slice(basePath.length));
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    else if (/text\/html/i.test(ctype) && !/\.html?$/i.test(rel)) rel += '/index.html';

    const file = path.resolve(dest, rel);
    if (!file.startsWith(dest + path.sep)) { console.warn(`  ! chemin refusé : ${rel}`); continue; }

    const kind = kindOf(file);
    let data = Buffer.from(await res.arrayBuffer());

    if (kind !== 'other') {
      let text = data.toString('utf8');
      for (const ref of findRefs(text, kind)) {
        if (!ref || /^(data:|mailto:|tel:|javascript:|blob:|#)/i.test(ref)) continue;
        let next;
        try { next = new URL(ref, url); } catch { continue; }
        if (!/^https?:$/.test(next.protocol) || next.origin !== url.origin) continue;
        next.hash = '';
        if (next.pathname.startsWith(basePath)) queue.push(next.href);
        else if (ref.startsWith('/') && !warned.has(ref)) {
          warned.add(ref);
          console.warn(`  ! chemin absolu hors du site (ne marchera pas sous /${site.id}/) : ${ref}`);
        }
      }
      // réécrit les chemins absolus  /ancien-chemin/...  ->  /<id>/...
      if (basePath !== '/' && basePath !== `/${site.id}/`) {
        text = text.split(url.origin + basePath).join(`/${site.id}/`);
        text = text.replace(new RegExp(`(["'(=])${esc(basePath)}`, 'g'), `$1/${site.id}/`);
      }
      data = Buffer.from(text, 'utf8');
    }

    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  }
  console.log(`  ${count} fichier(s) -> ${path.join(OUT, site.id)}/`);
}

async function exists(p) { try { await access(p); return true; } catch { return false; } }

const sites = JSON.parse(await readFile(SITES_FILE, 'utf8'));
if (!Array.isArray(sites)) throw new Error('sites.json doit contenir une liste [ ... ]');
const ids = sites.map((s) => s.id);
const dup = ids.find((id, i) => ids.indexOf(id) !== i);
if (dup) throw new Error(`id en double dans sites.json : ${dup}`);

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, '.nojekyll'), '');
for (const f of ['index.html', 'sites.json', '404.html']) {
  const src = f === 'sites.json' ? SITES_FILE : f;
  if (await exists(src)) await copyFile(src, path.join(OUT, f));
}

const failedIds = new Set();
for (const site of sites) {
  console.log(`> ${site.id}  (${site.url})`);
  try { await mirror(site); }
  catch (e) {
    failedIds.add(site.id);
    console.error(`  X ${e.message}`);
    console.log(`::warning title=Site ignoré : ${site.id}::${e.message}`);
    await rm(path.join(OUT, site.id), { recursive: true, force: true }); // pas de dossier à moitié copié
  }
}
if (failedIds.size) {
  // les sites en erreur disparaissent de la liste du portail, les autres sont déployés normalement
  const ok = sites.filter((s) => !failedIds.has(s.id));
  await writeFile(path.join(OUT, 'sites.json'), JSON.stringify(ok, null, 2));
  console.error(`\n${failedIds.size} site(s) ignoré(s) : ${[...failedIds].join(', ')}`);
  if (!ok.length) { console.error('Aucun site n\'a pu être récupéré : rien ne sera déployé.'); process.exit(1); }
}
console.log('\nTerminé.');
