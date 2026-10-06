// Ajoute un "garde" dans chaque page HTML des projets copiés dans dist/<id>/ :
//  JEUX (type "jeu", ou pas de type) :
//   - ouvert seul (hors du cadre du portail)  -> renvoie vers le portail
//   - intégré dans le site de quelqu'un d'autre -> page vide
//   - pas de clic droit, ni F12 / Ctrl+S / Ctrl+U / Ctrl+Maj+I
//  SITES (type "site") : ils s'ouvrent bruts sur ton domaine, donc
//   - PAS de renvoi vers le portail, PAS de blocage du clic droit / des raccourcis
//   - seulement : intégré dans le site de quelqu'un d'autre -> page vide
// Ce sont des freins, pas un blindage : voir l'explication dans la conversation.
//
// Aucune dépendance : Node 18 ou plus récent suffit.

import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const OUT = process.env.OUT_DIR || 'dist';
const sites = JSON.parse(await readFile(process.env.SITES_FILE || 'sites.json', 'utf8'));

const guard = (id) => `<script data-guard>(function(){var ID=${JSON.stringify(id)};
try{
var root=location.pathname.split('/'+ID+'/')[0]+'/';
if(top===window){location.replace(root+'#'+ID);return;}
var same=false;try{same=top.location.host===location.host}catch(e){}
if(!same){document.documentElement.innerHTML='';return;}
}catch(e){}
addEventListener('contextmenu',function(e){e.preventDefault()},true);
addEventListener('dragstart',function(e){if(/^(IMG|A|CANVAS)$/.test(e.target.tagName))e.preventDefault()},true);
addEventListener('keydown',function(e){var k=(e.key||'').toLowerCase(),c=e.ctrlKey||e.metaKey;
if(k==='f12'||(c&&k.length===1&&'sup'.indexOf(k)>-1)||(c&&e.shiftKey&&k.length===1&&'ijc'.indexOf(k)>-1))e.preventDefault()},true);
})();</script>`;

// garde léger pour les sites : uniquement l'anti-intégration (iframe sur un autre domaine)
const guardSite = () => `<script data-guard>(function(){try{if(top!==window){var same=false;try{same=top.location.host===location.host}catch(e){}if(!same)document.documentElement.innerHTML='';}}catch(e){}})();</script>`;
const isSite = (s) => String(s.type || '').toLowerCase() === 'site';

let count = 0;
for (const s of sites) {
  const dir = path.join(OUT, s.id);
  let files;
  try { files = await readdir(dir, { recursive: true }); } catch { continue; }
  for (const f of files) {
    if (!/\.html?$/i.test(f)) continue;
    const file = path.join(dir, f);
    try {
      let html = await readFile(file, 'utf8');
      if (html.includes('data-guard')) continue;
      const tag = isSite(s) ? guardSite() : guard(s.id);
      const re = [/<head[^>]*>/i, /<html[^>]*>/i, /<body[^>]*>/i].find((r) => r.test(html));
      html = re ? html.replace(re, (m) => m + tag) : tag + html;
      await writeFile(file, html);
      count++;
    } catch { /* dossier ou fichier illisible : on passe */ }
  }
}
console.log(`garde ajouté dans ${count} page(s) HTML.`);
