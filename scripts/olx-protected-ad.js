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
  const pendingStatuses = new Set(['new', 'unconfirmed']);
  const terminalFailureStatuses = new Set(['unpaid', 'limited', 'moderated', 'blocked', 'disabled', 'removed_by_moderator', 'removed_by_user']);
  let advert = (await olxRequest('/adverts/' + PROTECTED_AD_ID))?.data;
  if (!advert || advert.id !== PROTECTED_AD_ID) throw new Error('Protected advert was not found in this OLX account.');
  const beforeStatus = advert.status;

  if (advert.status !== 'active' && !pendingStatuses.has(advert.status)) {
    await olxRequest('/adverts/' + PROTECTED_AD_ID + '/commands', {
      method: 'POST',
      body: JSON.stringify({ command: 'activate' }),
    });
  }

  for (let attempt = 0; attempt < 12; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    advert = (await olxRequest('/adverts/' + PROTECTED_AD_ID))?.data;
    if (advert?.status === 'active') {
      console.log(JSON.stringify({ id: PROTECTED_AD_ID, title: advert.title, before: beforeStatus, after: advert.status }));
      return;
    }
    if (terminalFailureStatuses.has(advert?.status)) throw new Error('Protected advert activation stopped with status: ' + advert.status);
    if (!pendingStatuses.has(advert?.status)) throw new Error('Unexpected protected advert status: ' + (advert?.status || 'unknown'));
  }

  console.log('::notice title=OLX protected advert pending::Advert 148564438 was accepted and is still being processed by OLX.');
  console.log(JSON.stringify({ id: PROTECTED_AD_ID, title: advert?.title, before: beforeStatus, after: advert?.status, pending: true }));
}
main().catch(error => {
  console.error(error.message);
  console.error('::error title=OLX protected advert activation::' + String(error.message));
  process.exitCode = 1;
});
