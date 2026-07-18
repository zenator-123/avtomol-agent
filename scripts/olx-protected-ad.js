function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required setting: ${name}`);
  return value;
}

const PROTECTED_AD_ID = 148564438;
let accessToken = required('OLX_ACCESS_TOKEN');

async function refreshAccessToken() {
  const refreshToken = process.env.OLX_REFRESH_TOKEN;
  const clientId = process.env.OLX_CLIENT_ID;
  const clientSecret = process.env.OLX_CLIENT_SECRET;
  const missing = [!refreshToken && 'OLX_REFRESH_TOKEN', !clientId && 'OLX_CLIENT_ID', !clientSecret && 'OLX_CLIENT_SECRET'].filter(Boolean);
  if (missing.length) throw new Error(`OLX access token expired; missing refresh settings: ${missing.join(', ')}`);
  const response = await fetch('https://www.olx.bg/api/open/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, scope: 'v2 read write' }),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok || !json?.access_token) throw new Error(`OLX token refresh failed: ${response.status} ${json?.error_description || json?.error || 'unknown error'}`);
  accessToken = json.access_token;
}

async function olxRequest(path, options = {}, allowRefresh = true) {
  const response = await fetch(`https://www.olx.bg/api/partner${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${accessToken}`, Version: '2.0', Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (response.status === 401 && allowRefresh) { await refreshAccessToken(); return olxRequest(path, options, false); }
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path}: ${response.status} ${text.slice(0, 500)}`);
  return json;
}

async function main() {
  const before = (await olxRequest(`/adverts/${PROTECTED_AD_ID}`))?.data;
  if (!before || before.id !== PROTECTED_AD_ID) throw new Error('Protected advert was not found in this OLX account.');
  if (before.status !== 'active') await olxRequest(`/adverts/${PROTECTED_AD_ID}/commands`, { method: 'POST', body: JSON.stringify({ command: 'activate' }) });
  await new Promise(resolve => setTimeout(resolve, 4000));
  const after = (await olxRequest(`/adverts/${PROTECTED_AD_ID}`))?.data;
  console.log(JSON.stringify({ id: PROTECTED_AD_ID, title: after?.title, before: before.status, after: after?.status }));
  if (after?.status !== 'active') throw new Error(`Protected advert is not active after activation: ${after?.status || 'unknown'}`);
}

main().catch(error => {
  console.error(error.message);
  console.error('::error title=OLX protected advert activation::' + String(error.message));
  process.exitCode = 1;
});
