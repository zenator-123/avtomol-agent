const fs = require('node:fs');
const path = require('node:path');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required setting: ${name}`);
  return value;
}

async function main() {
  const token = required('OLX_ACCESS_TOKEN');
  const adverts = [];
  const limit = 100;

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
    adverts.push(...rows);
    console.log(`Downloaded ${adverts.length} OLX adverts`);
    if (rows.length < limit) break;
    if (adverts.length > 5000) throw new Error('Safety stop: more than 5000 adverts');
  }

  const outputPath = path.join(required('RUNNER_TEMP'), 'olx-adverts.json');
  fs.writeFileSync(outputPath, JSON.stringify({ downloaded_at: new Date().toISOString(), count: adverts.length, adverts }, null, 2), { mode: 0o600 });
  console.log(`OLX export complete: ${adverts.length} adverts`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
