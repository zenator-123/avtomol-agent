const fs = require('node:fs');
const path = require('node:path');
const { getOlxAccessToken } = require('./olx-auth');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required setting: ${name}`);
  return value;
}

async function main() {
  const token = await getOlxAccessToken();
  const advertsById = new Map();
  const limit = 100;
  let rawCount = 0;

  for (let offset = 0; ; offset += limit) {
    const url = new URL('https://www.olx.bg/api/partner/adverts');
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('limit', String(limit));
    const response = await fetch(url, { headers: {
      Authorization: `Bearer ${token}`, Version: '2.0', Accept: 'application/json',
    } });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); }
    catch { throw new Error(`OLX returned ${response.status} instead of JSON`); }
    if (!response.ok) throw new Error(`OLX adverts failed: ${response.status} ${JSON.stringify(json)}`);
    const rows = Array.isArray(json.data) ? json.data : [];
    rawCount += rows.length;
    for (const advert of rows) {
      if (advert?.id === undefined || advert?.id === null) continue;
      advertsById.set(String(advert.id), advert);
    }
    console.log(`Downloaded ${rawCount} rows; ${advertsById.size} unique OLX adverts`);
    if (rows.length < limit) break;
    if (rawCount > 5000) throw new Error('Safety stop: more than 5000 advert rows');
  }

  const adverts = [...advertsById.values()];
  const duplicateRowsRemoved = rawCount - adverts.length;
  const outputPath = path.join(required('RUNNER_TEMP'), 'olx-adverts.json');
  fs.writeFileSync(outputPath, JSON.stringify({
    downloaded_at: new Date().toISOString(),
    raw_count: rawCount,
    count: adverts.length,
    duplicate_rows_removed: duplicateRowsRemoved,
    adverts,
  }, null, 2), { mode: 0o600 });
  console.log(`OLX export complete: ${adverts.length} unique adverts; removed ${duplicateRowsRemoved} repeated rows`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
