#!/usr/bin/env node
// Downloads each company's icon into logos/<token>.<ext> so the page can serve them
// from its own origin (the CSP only allows same-origin images). Existing files are
// kept; pass --force to refetch. Preference: apple-touch-icon > largest declared icon >
// /apple-touch-icon.png > Google's favicon service.

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'logos');
const FORCE = process.argv.includes('--force');
const MAX_BYTES = 1024 * 1024;
const UA = 'Mozilla/5.0 (compatible; rishikkolli-job-board/1.0; +https://rishikkolli.github.io/jobs/)';

const TYPES = { 'image/png': 'png', 'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

function sniff(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return 'ico';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'webp';
  const head = buf.slice(0, 512).toString('utf8').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return 'svg';
  return null;
}

async function get(url, asText) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('too large');
  return asText ? buf.toString('utf8') : { buf, type: (res.headers.get('content-type') || '').split(';')[0].trim() };
}

function candidates(html, base) {
  const out = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = (tag.match(/\brel\s*=\s*["']([^"']+)["']/i) || [])[1]?.toLowerCase() || '';
    const href = (tag.match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!href || !/icon/.test(rel) || /mask-icon/.test(rel)) continue;
    const sizes = (tag.match(/\bsizes\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    const size = /any/i.test(sizes) ? 512 : Math.max(0, ...sizes.split(/\s+/).map(s => parseInt(s, 10) || 0));
    let score = size || (/apple-touch-icon/.test(rel) ? 180 : /\.svg(\?|$)/i.test(href) ? 256 : 32);
    if (/apple-touch-icon/.test(rel)) score += 1;
    try { out.push({ url: new URL(href, base).href, score }); } catch {}
  }
  return out.sort((a, b) => b.score - a.score);
}

async function fetchLogo(c) {
  const base = `https://${c.domain}/`;
  const tries = [];
  try { tries.push(...candidates(await get(base, true), base).map(x => x.url)); } catch {}
  tries.push(`${base}apple-touch-icon.png`);
  tries.push(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(c.domain)}&sz=256`);
  for (const url of tries) {
    if (!url.startsWith('https://')) continue;
    try {
      const { buf, type } = await get(url, false);
      const ext = sniff(buf) || TYPES[type];
      if (!ext || buf.length < 200) continue; // tiny = placeholder
      if (ext === 'svg' && /<script|on\w+\s*=|javascript:/i.test(buf.toString('utf8'))) continue;
      return { buf, ext, url };
    } catch {}
  }
  return null;
}

const { companies } = JSON.parse(await readFile(join(ROOT, 'config/companies.json'), 'utf8'));
await mkdir(OUT, { recursive: true });
const existing = new Set((await readdir(OUT)).map(f => f.replace(/\.\w+$/, '')));
const manifest = {};
for (const f of await readdir(OUT)) manifest[f.replace(/\.\w+$/, '')] = f;

let got = 0, failed = [];
for (const c of companies) {
  if (!c.domain || (!FORCE && existing.has(c.token))) continue;
  const logo = await fetchLogo(c);
  if (!logo) { failed.push(c.name); continue; }
  const file = `${c.token}.${logo.ext}`;
  await writeFile(join(OUT, file), logo.buf);
  manifest[c.token] = file;
  got++;
  console.log(`${c.name.padEnd(16)} ${file.padEnd(22)} ${logo.buf.length}B  ${logo.url}`);
}
await writeFile(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
console.log(`downloaded ${got}; missing: ${failed.join(', ') || 'none'}`);
