const fs = require('node:fs');
const path = require('node:path');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required setting: ${name}`);
  return value;
}

async function main() {
  const response = await fetch('https://www.olx.bg/api/open/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: required('OLX_CLIENT_ID'),
      client_secret: required('OLX_CLIENT_SECRET'),
      code: required('OLX_AUTHORIZATION_CODE'),
      scope: 'v2 read write',
    }),
  });
  const text = await response.text();
  let token;
  try { token = JSON.parse(text); }
  catch { throw new Error(`OLX returned ${response.status} instead of JSON`); }
  if (!response.ok || !token.access_token || !token.refresh_token) {
    throw new Error(`OLX token exchange failed: ${response.status} ${token.error_description || token.error || token.message || 'unknown error'}`);
  }
  console.log(`::add-mask::${token.access_token}`);
  console.log(`::add-mask::${token.refresh_token}`);
  const outputPath = path.join(required('RUNNER_TEMP'), 'olx-token.json');
  fs.writeFileSync(outputPath, JSON.stringify(token), { mode: 0o600 });
  console.log('OLX authorization succeeded; encrypted handoff will be created.');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
