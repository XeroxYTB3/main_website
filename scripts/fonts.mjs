// Héberge les polices du portail (Permanent Marker, Patrick Hand) sur ton propre site :
// plus de requête vers Google à chaque visite, et l'affichage ne change pas.
// Si le téléchargement échoue, index.html n'est pas touché et continue d'utiliser Google Fonts.
//
// Aucune dépendance : Node 18 ou plus récent suffit.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const OUT = process.env.OUT_DIR || 'dist';
const CSS_URL = process.env.FONTS_CSS_URL ||
  'https://fonts.googleapis.com/css2?family=Patrick+Hand&family=Permanent+Marker&display=swap';
// sans ce User-Agent, Google renverrait du format ancien (ttf) au lieu de woff2
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

try {
  const page = path.join(OUT, 'index.html');
  let html = await readFile(page, 'utf8');
  if (!/fonts\.googleapis\.com/.test(html)) throw new Error('index.html n\'utilise pas Google Fonts');

  const res = await fetch(CSS_URL, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('CSS HTTP ' + res.status);
  let css = await res.text();

  const urls = [...new Set([...css.matchAll(/url\(\s*["']?(https?:[^)"']+)["']?\s*\)/g)].map((m) => m[1]))];
  if (!urls.length) throw new Error('aucune police trouvée dans le CSS');
  if (urls.length > 30) throw new Error('trop de fichiers de police, arrêt de sécurité');

  await mkdir(path.join(OUT, 'fonts'), { recursive: true });
  const files = [];
  for (const [i, u] of urls.entries()) {
    const r = await fetch(u, { headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error('police HTTP ' + r.status);
    const name = `f${i + 1}.woff2`;
    files.push([name, Buffer.from(await r.arrayBuffer())]);
    css = css.split(u).join('fonts/' + name);
  }
  // tout est téléchargé : on écrit, puis seulement ensuite on modifie index.html
  for (const [name, data] of files) await writeFile(path.join(OUT, 'fonts', name), data);
  await writeFile(path.join(OUT, 'fonts.css'), css);

  let first = true;
  html = html.replace(/<link\b[^>]*fonts\.(?:googleapis|gstatic)\.com[^>]*>\s*/gi, () => {
    if (!first) return '';
    first = false;
    return '<link rel="stylesheet" href="fonts.css">\n';
  });
  await writeFile(page, html);
  console.log(`polices hébergées : ${files.length} fichier(s)`);
} catch (e) {
  console.warn('polices Google conservées (rien n\'a été modifié) :', e.message);
}
