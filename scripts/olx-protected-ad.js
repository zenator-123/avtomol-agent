function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required setting: ${name}`);
  return value;
}

const PROTECTED_AD_ID = 148564438;

async function olxRequest(path, options = {}) {
  const response = await fetch(`https://www.olx.bg/api/partner${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${required('OLX_ACCESS_TOKEN')}`,
      Version: '2.0',
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path}: ${response.status} ${text.slice(0, 500)}`);
  return json;
}

async function main() {
  const before = (await olxRequest(`/adverts/${PROTECTED_AD_ID}`))?.data;
  if (!before || before.id !== PROTECTED_AD_ID) throw new Error('Protected advert was not found in this OLX account.');
  if (before.status !== 'active') {
    await olxRequest(`/adverts/${PROTECTED_AD_ID}/commands`, {
      method: 'POST',
      body: JSON.stringify({ command: 'activate' }),
    });
  }
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
