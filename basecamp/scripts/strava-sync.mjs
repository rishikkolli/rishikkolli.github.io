// Pulls recent Strava activities and writes basecamp/strava.json, which the
// weekly-runs plan reads to turn completed days green. Runs in GitHub Actions.
// Needs repo secrets STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_REFRESH_TOKEN.
import { writeFileSync, readFileSync } from 'node:fs';

const { STRAVA_CLIENT_ID: id, STRAVA_CLIENT_SECRET: secret, STRAVA_REFRESH_TOKEN: refresh } = process.env;
if (!id || !secret || !refresh) {
  console.log('Strava secrets not set yet; skipping.');
  process.exit(0);
}

const OUT = 'basecamp/strava.json';
const SINCE = Math.floor(Date.UTC(2026, 9, 1) / 1000); // Oct 1, 2026
const TYPES = new Set(['Run', 'TrailRun', 'VirtualRun', 'Hike', 'Walk']);

const tok = await fetch('https://www.strava.com/oauth/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'refresh_token', refresh_token: refresh }),
}).then(r => r.json());
if (!tok.access_token) { console.error('Token refresh failed:', tok.message || tok); process.exit(1); }
if (tok.refresh_token && tok.refresh_token !== refresh) {
  console.warn('Strava issued a new refresh token. Update the STRAVA_REFRESH_TOKEN secret if syncing stops.');
}

const acts = [];
for (let page = 1; page < 20; page++) {
  const r = await fetch(`https://www.strava.com/api/v3/athlete/activities?after=${SINCE}&per_page=100&page=${page}`, {
    headers: { Authorization: `Bearer ${tok.access_token}` },
  });
  if (!r.ok) { console.error('Activities request failed:', r.status, await r.text()); process.exit(1); }
  const batch = await r.json();
  acts.push(...batch);
  if (batch.length < 100) break;
}

const days = {};
for (const a of acts) {
  const type = a.sport_type || a.type;
  if (!TYPES.has(type)) continue;
  const date = (a.start_date_local || a.start_date).slice(0, 10);
  const d = (days[date] ||= { mi: 0, n: 0 });
  d.mi = Math.round((d.mi + a.distance / 1609.344) * 10) / 10;
  d.n += 1;
}

let prev = null;
try { prev = JSON.parse(readFileSync(OUT, 'utf8')); } catch {}
if (prev && JSON.stringify(prev.days) === JSON.stringify(days)) {
  console.log('No new activities.');
  process.exit(0);
}
writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString(), days }, null, 1) + '\n');
console.log(`Wrote ${Object.keys(days).length} active days from ${acts.length} activities.`);
