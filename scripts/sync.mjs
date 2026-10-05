// Synchronise les sites listés dans sites.json.
// Pour chaque site : télécharge la version déployée (HTML + fichiers qu'elle utilise)
// et la range dans dist/<id>/  ->  le site est alors servi sur  ton-domaine.com/<id>/
//
// Récupération des fichiers (3 sources, cumulées) :
//  1. les références classiques : src=, href=, srcset=, url(...), import ... from
//  2. les chemins écrits en JavaScript ("assets/image1", 'sons/pop.mp3', ...), y compris
//     SANS extension : on teste alors png, jpg, jpeg, webp, gif, svg, avif
//  3. le dossier assets (et images, img, static, media, fonts, sounds, ...) listé directement
//     dans le dépôt GitHub du site, pour les sites en  <compte>.github.io/<depot>/
//     -> récupère aussi les fichiers que la page ne cite jamais en toutes lettres
//
// Options facultatives par site dans sites.json :
//   "repo": "compte/depot"      dépôt GitHub (déduit de l'URL des sites github.io)
//   "branch": "main"            branche à lister (défaut : branche par défaut)
//   "include": ["assets","img"] dossiers à récupérer en entier (remplace la liste par défaut)
//   "autoAssets": false         désactive la source 3
//
// Aucune dépendance : Node 18 ou plus récent suffit.
// GITHUB_TOKEN (fourni automatiquement par GitHub Actions) évite la limite de requêtes de l'API.

import { readFile, writeFile, mkdir, rm, copyFile, access } from 'node:fs/promises';
import path from 'node:path';

const SITES_FILE = process.env.SITES_FILE || 'sites.json';
const OUT = process.env.OUT_DIR || 'dist';
const GH_API = process.env.GH_API || 'https://api.github.com';
const MAX_FILES = 800;
const MAX_PROBES = 400; // essais d'extensions pour les chemins sans extension, par site
const ASSET_DIRS = ['assets', 'asset', 'images', 'img', 'static', 'media', 'fonts', 'sounds', 'audio', 'textures', 'models'];
const PROBE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif'];
const KNOWN_EXT = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|mp3|wav|ogg|m4a|mp4|webm|woff2?|ttf|otf|json|glb|gltf|obj|wasm|css|m?js|txt|csv)$/i;
const MIME_TOP = /^(?:application|text|image|audio|video|font|multipart|message|model)\//i;

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

// Chemins écrits dans des chaînes JavaScript : 'assets/image1', "img/logo.png", `./sons/pop.mp3`
// known = avec une extension de fichier connue ; bare = sans extension (on devine laquelle)
function findScriptRefs(text) {
  const known = new Set(), bare = new Set();
  for (const m of text.matchAll(/["'`]((?:\.{1,2}\/)?[\w@%-][\w@%.-]*(?:\/[\w@%.-]+)+)["'`]/g)) {
    const r = m[1];
    if (MIME_TOP.test(r) || /^[\d/.-]+$/.test(r)) continue; // types MIME, dates, nombres
    if (KNOWN_EXT.test(r)) known.add(r);
    else if (!/\.[A-Za-z0-9]{1,5}$/.test(r)) bare.add(r);
  }
  return { known, bare };
}

async function get(url) {
  for (let i = 0; ; i++) {
    try { return await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30000) }); }
    catch (e) { if (i >= 2) throw e; await new Promise((r) => setTimeout(r, 800 * (i + 1))); }
  }
}

// Liste les fichiers des dossiers d'assets directement dans le dépôt GitHub du site
async function repoAssets(site, start, basePath) {
  if (site.autoAssets === false && !site.include) return [];
  let repo = site.repo;
  if (!repo) {
    const m = start.hostname.match(/^([^.]+)\.github\.io$/i);
    if (!m) return [];
    const first = basePath.split('/').filter(Boolean)[0];
    repo = first ? `${m[1]}/${first}` : `${m[1]}/${m[1]}.github.io`;
  }
  const dirs = (site.include || ASSET_DIRS).map((d) => d.replace(/^\/+|\/+$/g, '').toLowerCase()).filter(Boolean);
  const headers = { 'User-Agent': 'portal-sync', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  let res;
  try {
    res = await fetch(`${GH_API}/repos/${repo}/git/trees/${encodeURIComponent(site.branch || 'HEAD')}?recursive=1`, { headers, signal: AbortSignal.timeout(30000) });
  } catch (e) { console.warn(`  ! liste des fichiers GitHub indisponible (${e.message})`); return []; }
  if (!res.ok) {
    if (site.include || site.repo) console.warn(`  ! liste des fichiers GitHub indisponible (${repo} -> HTTP ${res.status})`);
    return [];
  }
  const tree = await res.json();
  if (tree.truncated) console.warn(`  ! dépôt ${repo} trop gros : liste de fichiers tronquée`);
  return (tree.tree || [])
    .filter((n) => n.type === 'blob' && dirs.some((d) => n.path.toLowerCase().startsWith(d + '/')))
    .map((n) => n.path);
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
  // file d'attente : { href, probe?, quiet? }
  //  probe : chemin sans extension -> on essaie png, jpg, ... jusqu'à trouver
  //  quiet : pas d'avertissement si le fichier n'existe pas (liste « au cas où »)
  const queue = [{ href: start.href }];
  const seen = new Set();
  const warned = new Set();
  let count = 0, probes = 0, fromRepo = 0;

  for (const p of await repoAssets(site, start, basePath)) {
    queue.push({ href: new URL(basePath + p.split('/').map(encodeURIComponent).join('/'), start.origin).href, quiet: true });
    fromRepo++;
  }

  const keyOf = (u) => u.origin + u.pathname + u.search;
  const add = (ref, from, probe) => {
    let next;
    try { next = new URL(ref, from); } catch { return; }
    if (!/^https?:$/.test(next.protocol) || next.origin !== from.origin) return;
    next.hash = '';
    if (next.pathname.startsWith(basePath)) queue.push({ href: next.href, probe });
    else if (!probe && ref.startsWith('/') && !warned.has(ref)) {
      warned.add(ref);
      console.warn(`  ! chemin absolu hors du site (ne marchera pas sous /${site.id}/) : ${ref}`);
    }
  };

  while (queue.length) {
    const item = queue.shift();
    const key0 = keyOf(new URL(item.href));
    if (seen.has(key0)) continue;
    seen.add(key0);

    let url = new URL(item.href), res;
    if (item.probe) {
      if (probes >= MAX_PROBES) continue;
      probes++;
      res = null;
      for (const ext of PROBE_EXT) {
        const u = new URL(item.href);
        u.pathname += '.' + ext;
        if (seen.has(keyOf(u))) { res = null; break; } // déjà récupéré (ou en cours) sous cette extension
        const r = await get(u);
        if (r.ok && !/text\/html/i.test(r.headers.get('content-type') || '')) { res = r; url = u; seen.add(keyOf(u)); break; }
      }
      if (!res) continue; // aucune extension ne correspond : ce n'était pas un fichier
    } else {
      res = await get(url);
      if (!res.ok) {
        if (url.href === start.href) throw new Error(`${url.href} -> HTTP ${res.status}`);
        if (!item.quiet) console.warn(`  ! ignoré (HTTP ${res.status}) : ${url.pathname}`);
        continue;
      }
    }
    if (++count > MAX_FILES) throw new Error(`plus de ${MAX_FILES} fichiers, arrêt de sécurité`);

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
        add(ref, url);
      }
      if (kind === 'html' || kind === 'js') {
        const { known, bare } = findScriptRefs(text);
        known.forEach((r) => add(r, url));
        bare.forEach((r) => add(r, url, true));
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
  console.log(`  ${count} fichier(s) -> ${path.join(OUT, site.id)}/` + (fromRepo ? `  (dont dossiers d'assets listés dans le dépôt : ${fromRepo})` : ''));
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
