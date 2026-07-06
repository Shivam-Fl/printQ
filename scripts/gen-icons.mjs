// Generates the PWA icon set into apps/web/public/icons.
// Run from repo root: node scripts/gen-icons.mjs
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';

const sheet = `
  <rect x="136" y="104" width="240" height="304" rx="18" fill="#FFFFFF"/>
  <path d="M312 104 h46 a18 18 0 0 1 18 18 v46 z" fill="#C9D2F0"/>
  <rect x="168" y="190" width="150" height="18" rx="9" fill="#AFB4C2"/>
  <rect x="168" y="236" width="176" height="18" rx="9" fill="#AFB4C2"/>
  <rect x="168" y="282" width="112" height="18" rx="9" fill="#AFB4C2"/>
  <circle cx="352" cy="364" r="66" fill="#FFE24A"/>
  <rect x="344" y="330" width="18" height="68" rx="9" fill="#2242C8"/>
`;

const rounded = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="104" fill="#2242C8"/>${sheet}</svg>`;

// maskable: full-bleed background, artwork inside the 80% safe zone
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#2242C8"/>
  <g transform="translate(51.2 51.2) scale(0.8)">${sheet}</g></svg>`;

const badge = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 512 512">
  <rect x="116" y="64" width="280" height="384" rx="40" fill="#FFFFFF"/>
  <rect x="176" y="170" width="160" height="34" rx="17" fill="#2242C8"/>
  <rect x="176" y="240" width="190" height="34" rx="17" fill="#2242C8"/>
  <rect x="176" y="310" width="120" height="34" rx="17" fill="#2242C8"/></svg>`;

await mkdir('apps/web/public/icons', { recursive: true });
await sharp(Buffer.from(rounded)).resize(512, 512).png().toFile('apps/web/public/icons/icon-512.png');
await sharp(Buffer.from(rounded)).resize(192, 192).png().toFile('apps/web/public/icons/icon-192.png');
await sharp(Buffer.from(maskable)).resize(512, 512).png().toFile('apps/web/public/icons/maskable-512.png');
await sharp(Buffer.from(badge)).resize(96, 96).png().toFile('apps/web/public/icons/badge-96.png');
console.log('icons written to apps/web/public/icons');
