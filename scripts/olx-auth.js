function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required setting: ${name}`);
  return value;
}

async function getOlxAccessToken() {
  const refreshToken = process.env.OLX_REFRESH_TOKEN;
  const clientId = process.env.OLX_CLIENT_ID;
  const clientSecret = process.env.OLX_CLIENT_SECRET;
  if (!refreshToken || !clientId || !clientSecret) return required('OLX_ACCESS_TOKEN');

  const response = await fetch('https://www.olx.bg/api/open/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      scope: 'v2 read write',
    }),
  });
  const text = await response.text();
  let token = null;
  try { token = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok || !token?.access_token) {
    throw new Error(`Automatic OLX token refresh failed: ${response.status} ${token?.error_description || token?.error || 'unknown error'}`);
  }
  console.log('OLX access token refreshed automatically.');
  return token.access_token;
}

module.exports = { getOlxAccessToken };
