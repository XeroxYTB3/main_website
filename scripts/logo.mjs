// Convertit le logo du portail (SVG) en PNG / ICO pour les téléphones et les anciens navigateurs,
// et écrit le manifeste (icône d'écran d'accueil). Si quelque chose manque ou plante,
// on passe : le site marche très bien avec le logo SVG de index.html.
//
// Dépendance (installée par le workflow, facultative) : @resvg/resvg-js

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const OUT = process.env.OUT_DIR || 'dist';
const P = 'M30 20H52a19 19 0 0 1 0 38H44V80H30Z M44 32H51a7 7 0 0 1 0 14H44Z';

// le logo ; avec fond = carré plein (iOS / Android arrondissent eux-mêmes)
const svg = (full) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
${full ? '<rect width="100" height="100" fill="#fffdf5"/>' : ''}
<g${full ? ' transform="translate(9 9) scale(.82)"' : ''}>
<rect x="13" y="14" width="82" height="80" rx="22" fill="#3ddc97"/>
<rect x="6" y="7" width="82" height="80" rx="22" fill="#fffdf5" stroke="#1d1b2e" stroke-width="6"/>
<rect x="20" y="54" width="54" height="16" rx="6" fill="#ffd93d" transform="rotate(-3 47 62)"/>
<path d="${P}" fill="#1d1b2e" fill-rule="evenodd" transform="translate(-3 0)"/>
</g></svg>`;

// un .ico qui contient simplement un PNG (accepté par tous les navigateurs récents)
function ico(png, size) {
  const head = Buffer.alloc(22);
  head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
  head[6] = size; head[7] = size; head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12);
  head.writeUInt32LE(png.length, 14); head.writeUInt32LE(22, 18);
  return Buffer.concat([head, png]);
}

try {
  const { Resvg } = await import('@resvg/resvg-js');
  const png = (full, size) => new Resvg(svg(full), { fitTo: { mode: 'width', value: size } }).render().asPng();
  await mkdir(OUT, { recursive: true });
  const files = {
    'favicon-32.png': png(false, 32),
    'apple-touch-icon.png': png(true, 180),
    'icon-192.png': png(true, 192),
    'icon-512.png': png(true, 512),
  };
  files['favicon.ico'] = ico(files['favicon-32.png'], 32);
  for (const [name, data] of Object.entries(files)) await writeFile(path.join(OUT, name), data);
  await writeFile(path.join(OUT, 'manifest.webmanifest'), JSON.stringify({
    name: 'Mes projets', short_name: 'Projets', start_url: './', scope: './', display: 'standalone',
    background_color: '#fffdf5', theme_color: '#fffdf5',
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  }, null, 2));
  console.log('icônes PNG/ICO + manifeste : ok');
} catch (e) {
  console.warn('icônes PNG ignorées (le logo SVG reste utilisé) :', e.message);
}
