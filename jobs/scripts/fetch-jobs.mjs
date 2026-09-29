#!/usr/bin/env node
// Pulls postings from public Greenhouse / Lever / Ashby job-board APIs, keeps the
// full-time, sponsorship-compatible roles in target cities, scores them against
// config/profile.json, and writes data/jobs.json for the static page.
// No dependencies; needs Node 18+ (global fetch).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOP_N = 20;
const MAX_PER_COMPANY = 3;
const FETCH_TIMEOUT_MS = 20000;
const MAX_RESPONSE_BYTES = 40 * 1024 * 1024;
const CONCURRENCY = 6;

const readJson = async (rel) => JSON.parse(await readFile(join(ROOT, rel), 'utf8'));

// ---------- sanitizing (all third-party text is untrusted) ----------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', bull: '•' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
function htmlToText(html) {
  if (typeof html !== 'string') return '';
  // Greenhouse double-encodes: entity-escaped HTML. Decode once, strip tags, decode again.
  let s = decodeEntities(html);
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
       .replace(/<\/(p|div|li|h\d|br|tr)>/gi, '\n')
       .replace(/<br\s*\/?>/gi, '\n')
       .replace(/<[^>]*>/g, ' ');
  return decodeEntities(s);
}
function cleanText(s, max) {
  if (typeof s !== 'string') return '';
  // drop control chars (keep \n\t), collapse whitespace, cap length
  const t = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u2028\u2029]/g, '')
             .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  return max && t.length > max ? t.slice(0, max - 1) + '…' : t;
}
function safeUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

// ---------- fetching ----------
async function fetchJson(url) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'rishikkolli-job-board/1.0 (+https://rishikkolli.github.io/jobs/)' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const len = Number(res.headers.get('content-length') || 0);
      if (len > MAX_RESPONSE_BYTES) throw new Error('response too large');
      const text = await res.text();
      if (text.length > MAX_RESPONSE_BYTES) throw new Error('response too large');
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      if (/HTTP 4\d\d/.test(e.message)) break; // not transient
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

// ---------- normalizing per ATS ----------
function fromGreenhouse(c, data) {
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  return jobs.map(j => ({
    id: `gh-${c.token}-${j.id}`,
    title: j.title,
    location: j.location?.name || '',
    url: j.absolute_url,
    posted: j.first_published || j.updated_at,
    text: htmlToText(j.content || ''),
    employment: '',
    salary: null,
  }));
}
function fromLever(c, data) {
  const jobs = Array.isArray(data) ? data : [];
  return jobs.map(j => {
    const lists = Array.isArray(j.lists) ? j.lists.map(l => `${l.text || ''}\n${htmlToText(l.content || '')}`).join('\n') : '';
    const locs = [j.categories?.location, ...(j.categories?.allLocations || [])].filter(Boolean);
    let salary = null;
    if (j.salaryRange && Number.isFinite(j.salaryRange.min) && Number.isFinite(j.salaryRange.max)) {
      salary = `${j.salaryRange.currency || 'USD'} ${Math.round(j.salaryRange.min / 1000)}K–${Math.round(j.salaryRange.max / 1000)}K`;
    }
    return {
      id: `lv-${c.token}-${j.id}`,
      title: j.text,
      location: [...new Set(locs)].join(' / '),
      url: j.hostedUrl,
      posted: Number.isFinite(j.createdAt) ? new Date(j.createdAt).toISOString() : null,
      text: [j.descriptionPlain, lists, j.additionalPlain].filter(Boolean).join('\n'),
      employment: j.categories?.commitment || '',
      salary,
    };
  });
}
function fromAshby(c, data) {
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  return jobs.filter(j => j.isListed !== false).map(j => {
    const locs = [j.location, ...(j.secondaryLocations || []).map(s => s.location)].filter(Boolean);
    if (j.isRemote && !locs.some(l => /remote/i.test(l))) locs.push('Remote');
    return {
      id: `ab-${c.token}-${j.id}`,
      title: j.title,
      location: [...new Set(locs)].join(' / '),
      url: j.jobUrl,
      posted: j.publishedAt,
      text: j.descriptionPlain || htmlToText(j.descriptionHtml || ''),
      employment: j.employmentType || '',
      salary: j.compensation?.compensationTierSummary || null,
    };
  });
}
const ENDPOINTS = {
  greenhouse: c => [`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(c.token)}/jobs?content=true`, fromGreenhouse],
  lever: c => [`https://api.lever.co/v0/postings/${encodeURIComponent(c.token)}?mode=json`, fromLever],
  ashby: c => [`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(c.token)}?includeCompensation=true`, fromAshby],
};

// ---------- matching helpers ----------
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (term, flags) => new RegExp(`(?<![A-Za-z0-9+#])${escapeRe(term)}(?![A-Za-z0-9+#])`, flags);

const NO_SPONSOR = [
  /\b(unable|not able|cannot|can ?not|can't|will not|won't|do not|does not|don't|doesn't|are not able|is not able)\s+(to\s+)?(currently\s+)?(provide|offer|support|consider)?\s*(any\s+)?(employment\s+|work\s+)?(visa\s+)?sponsor/i,
  /\bnot\s+(eligible|available)\s+for\s+(visa\s+)?sponsorship/i,
  /\bno\s+(visa\s+)?sponsorship\b/i,
  /\bwithout\s+(the\s+)?(need\s+for\s+)?(current\s+or\s+future\s+|future\s+)?(employer\s+|visa\s+)?sponsorship/i,
  /\bsponsorship\s+(is\s+)?not\s+(available|offered|provided)/i,
  /\bmust\s+be\s+(a\s+)?(u\.?s\.?|united states)\s+citizen/i,
  /\b(u\.?s\.?|united states)\s+citizenship\s+(is\s+)?required/i,
  /\b(active|current|ability to obtain( and maintain)?)\s+(a\s+)?(ts\/sci|top secret|secret|security)\s+clearance/i,
  /\bitar\b/i,
  /\bgreen card holders?\s+only\b/i,
];
const SPONSOR_OK = [
  /\b(will|can|able to|happy to|do)\s+(provide\s+|offer\s+)?(visa\s+)?sponsor/i,
  /\bvisa\s+sponsorship\s+(is\s+)?(available|offered|provided)/i,
  /\bsponsorship\s+(is\s+)?available/i,
  /\bh-?1b\b/i,
];
const NON_US = /\b(canada|toronto|vancouver|montreal|united kingdom|\buk\b|london|dublin|ireland|india|bangalore|bengaluru|hyderabad|europe|emea|apac|germany|berlin|amsterdam|netherlands|france|paris|spain|madrid|poland|warsaw|singapore|australia|sydney|japan|tokyo|brazil|são paulo|sao paulo|mexico|israel|tel aviv|korea|seoul|china|latam)\b/i;

function locationMatch(loc, profile) {
  const l = loc.toLowerCase();
  const cities = profile.locations.filter(p => p.match.some(m => l.includes(m))).map(p => p.label);
  let remote = false;
  if (profile.includeRemoteUS && /remote/.test(l)) {
    const usHint = /\b(us|usa|u\.s\.|united states|north america|americas|anywhere in the us)\b/.test(l);
    const onlyRemote = /^\s*(fully\s+)?remote\s*$/.test(l);
    remote = usHint || onlyRemote || (!NON_US.test(l) && cities.length === 0 && /remote/.test(l) && !/[,/-]\s*[a-z]{3,}\s*$/.test(l.replace(/remote/g, '')));
  }
  return { cities, remote };
}

function yearsRequired(text) {
  let max = 0;
  const re = /(\d{1,2})\s*\+?\s*(?:-|–|to)?\s*(\d{1,2})?\s*\+?\s*years?(?:\s+of)?(?:\s+\w+){0,4}\s+(?:experience|industry|professional|software|engineering)/gi;
  let m;
  while ((m = re.exec(text))) {
    const n = parseInt(m[1], 10);
    if (n <= 15) max = Math.max(max, n);
  }
  return max;
}
function salaryFromText(text) {
  const m = text.match(/\$\s?(\d{2,3}(?:,\d{3})+|\d{2,3}(?:\.\d)?\s?[kK])\s*(?:-|–|—|to)\s*\$?\s?(\d{2,3}(?:,\d{3})+|\d{2,3}(?:\.\d)?\s?[kK])/);
  if (!m) return null;
  const toK = v => /k/i.test(v) ? Math.round(parseFloat(v)) : Math.round(parseInt(v.replace(/,/g, ''), 10) / 1000);
  const a = toK(m[1]), b = toK(m[2]);
  if (!(a >= 40 && b >= a && b <= 900)) return null;
  return `$${a}K–$${b}K`;
}

// ---------- main ----------
async function main() {
  const [{ companies }, profile, { skills: catalog }] = await Promise.all([
    readJson('config/companies.json'), readJson('config/profile.json'), readJson('config/skills-catalog.json'),
  ]);

  const skillMatchers = catalog.map(s => ({
    id: s.id,
    // caseTerms are short, ambiguous names (Go, R): also reject neighbours like "Go-to-market" or "R&D"
    res: [...(s.terms || []).map(t => wordRe(t, 'i')), ...(s.caseTerms || []).map(t => new RegExp(`(?<![A-Za-z0-9+#.&/-])${escapeRe(t)}(?![A-Za-z0-9+#&/-])`))],
  }));
  // plain alphanumeric boundaries here, so "Staff+" and "Sr." still count as excluded levels
  const excludeRes = profile.excludeTitle.map(t => new RegExp(`(?<![A-Za-z0-9])${escapeRe(t)}(?![A-Za-z0-9])`, 'i'));
  const prof = id => Math.max(0, Math.min(5, Number(profile.skills[id]) || 0));

  const errors = [];
  const perCompany = await pool(companies, CONCURRENCY, async c => {
    const ep = ENDPOINTS[c.ats];
    if (!ep) { errors.push(`${c.name}: unknown ATS ${c.ats}`); return []; }
    const [url, normalize] = ep(c);
    try {
      const rows = normalize(c, await fetchJson(url));
      return rows.map(r => ({ ...r, company: c.name, companyType: c.type }));
    } catch (e) {
      errors.push(`${c.name}: ${e.message}`);
      return [];
    }
  });
  const all = perCompany.flat();

  const relevant = [];
  const reasons = { title: 0, level: 0, employment: 0, location: 0, sponsorship: 0 };
  for (const j of all) {
    const title = cleanText(j.title, 200);
    const tl = title.toLowerCase();
    const fam = profile.roleFamilies
      .map(f => ({ f, hit: f.match.some(m => tl.includes(m)) }))
      .filter(x => x.hit)
      .sort((a, b) => b.f.weight - a.f.weight)[0]?.f;
    if (!fam) { reasons.title++; continue; }
    if (excludeRes.some(re => re.test(title))) { reasons.level++; continue; }
    if (j.employment && !/full/i.test(j.employment)) { reasons.employment++; continue; }
    const loc = locationMatch(cleanText(j.location, 300), profile);
    if (!loc.cities.length && !loc.remote) { reasons.location++; continue; }
    const text = cleanText(j.text, 60000);
    if (profile.needsSponsorship && NO_SPONSOR.some(re => re.test(text))) { reasons.sponsorship++; continue; }
    const url = safeUrl(j.url);
    if (!url) continue;

    const found = skillMatchers.filter(s => s.res.some(re => re.test(`${title}\n${text}`))).map(s => s.id);
    relevant.push({ j, title, text, fam, loc, url, found });
  }

  // Skill demand across every relevant posting (not just the top 20)
  const counts = Object.fromEntries(catalog.map(s => [s.id, 0]));
  for (const r of relevant) for (const id of r.found) counts[id]++;
  const total = relevant.length || 1;
  const demand = catalog
    .map(s => {
      const pct = counts[s.id] / total;
      const p = prof(s.id);
      return {
        id: s.id, count: counts[s.id], pct: Math.round(pct * 1000) / 10, prof: p,
        status: p === 0 ? 'missing' : p <= 3 ? 'sharpen' : 'maintain',
        // demand weighted by distance from mastery; listed skills still rank if you're not at 5
        priority: Math.round(pct * (1 - p / 5) * 1000) / 10,
      };
    })
    .filter(d => d.count > 0)
    .sort((a, b) => b.priority - a.priority || b.pct - a.pct);

  // Score each posting
  const scored = relevant.map(r => {
    const S = r.found;
    // Shrink toward a neutral prior when few skills are detected, so a posting that only
    // mentions "Python" doesn't look like a 95% fit on thin evidence.
    const PRIOR = 0.45, K = 4;
    const skillFit = (S.reduce((a, id) => a + prof(id) / 5, 0) + PRIOR * K) / (S.length + K);
    const coverage = (S.filter(id => prof(id) >= 2).length + PRIOR * K) / (S.length + K);
    const yrs = yearsRequired(r.text);
    let score = 100 * (0.45 * skillFit + 0.25 * coverage + 0.30 * r.fam.weight);
    if (/\b(new grad|new graduate|university grad|entry[- ]level|early career|recent graduate)\b/i.test(`${r.title} ${r.text}`)) score += 4;
    if (yrs >= 7) score -= 15; else if (yrs >= 5) score -= 9; else if (yrs === 4) score -= 4;
    const ageDays = r.j.posted && !isNaN(Date.parse(r.j.posted)) ? (Date.now() - Date.parse(r.j.posted)) / 864e5 : 0;
    if (ageDays > 365) score -= 10; else if (ageDays > 120) score -= 5; else if (ageDays <= 14) score += 2;
    if (r.loc.cities.includes('New York, NY') || r.loc.cities.includes('Jersey City, NJ')) score += 2; // based in Brooklyn
    const posted = r.j.posted && !isNaN(Date.parse(r.j.posted)) ? new Date(r.j.posted).toISOString() : null;
    return {
      id: cleanText(r.j.id, 120),
      title: r.title,
      company: r.j.company,
      companyType: r.j.companyType,
      family: r.fam.id,
      location: cleanText(r.j.location, 160),
      cities: r.loc.cities,
      remote: r.loc.remote,
      url: r.url,
      posted,
      yearsRequired: yrs || null,
      salary: cleanText(r.j.salary || salaryFromText(r.text) || '', 80) || null,
      sponsorSignal: SPONSOR_OK.some(re => re.test(r.text)) ? 'mentioned' : 'not-stated',
      match: Math.max(0, Math.min(99, Math.round(score))),
      strong: S.filter(id => prof(id) >= 4),
      sharpen: S.filter(id => prof(id) >= 1 && prof(id) <= 3),
      missing: S.filter(id => prof(id) === 0),
    };
  });

  scored.sort((a, b) => b.match - a.match || (Date.parse(b.posted || 0) - Date.parse(a.posted || 0)));
  const top = [];
  const perCo = {};
  const dupes = new Set();
  for (const s of scored) {
    const key = `${s.company}|${s.title.toLowerCase()}|${s.location.toLowerCase()}`;
    if (dupes.has(key)) continue;
    dupes.add(key);
    if ((perCo[s.company] || 0) >= MAX_PER_COMPANY) continue;
    perCo[s.company] = (perCo[s.company] || 0) + 1;
    top.push(s);
    if (top.length === TOP_N) break;
  }

  // "New" badges: remember when each posting was first seen
  const seenPath = join(ROOT, 'data/seen.json');
  let seen = {};
  try { seen = JSON.parse(await readFile(seenPath, 'utf8')); } catch {}
  const firstRun = Object.keys(seen).length === 0;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  for (const s of scored) if (!seen[s.id]) seen[s.id] = today;
  const cutoff = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
  for (const k of Object.keys(seen)) if (seen[k] < cutoff) delete seen[k];
  for (const t of top) t.isNew = !firstRun && seen[t.id] === today;

  const out = {
    generatedAt: new Date().toISOString(),
    stats: {
      companies: companies.length,
      companiesOk: companies.length - errors.length,
      fetched: all.length,
      relevant: relevant.length,
      filteredOut: reasons,
    },
    jobs: top,
    demand: demand.slice(0, 30),
    errors: errors.map(e => cleanText(e, 200)),
  };

  if (all.length === 0 || relevant.length < 5) {
    console.error(`Refusing to overwrite data: fetched=${all.length} relevant=${relevant.length}`, errors);
    process.exit(1);
  }
  await mkdir(join(ROOT, 'data'), { recursive: true });
  await writeFile(join(ROOT, 'data/jobs.json'), JSON.stringify(out, null, 1) + '\n');
  await writeFile(seenPath, JSON.stringify(seen) + '\n');
  console.log(`fetched ${all.length} postings from ${out.stats.companiesOk}/${companies.length} boards; ${relevant.length} relevant; wrote top ${top.length}`);
  console.log('filtered out:', reasons);
  if (errors.length) console.log('errors:', errors);
}

main().catch(e => { console.error(e); process.exit(1); });
