const fs = require('node:fs');
const path = require('node:path');

const input = JSON.parse(fs.readFileSync(path.join(process.env.RUNNER_TEMP, 'olx-adverts.json'), 'utf8'));
const adverts = (input.adverts || []).map((advert) => ({
  id: advert.id,
  external_id: advert.external_id || '',
  status: advert.status || '',
  title: advert.title || '',
  category_id: advert.category_id || advert.category?.id || null,
  url: advert.url || advert.external_url || '',
  created_at: advert.created_at || advert.created_time || null,
  updated_at: advert.updated_at || advert.updated_time || null,
  activated_at: advert.activated_at || advert.activation_time || null,
  last_refresh_time: advert.last_refresh_time || advert.last_refresh_at || null,
  valid_to_time: advert.valid_to_time || advert.valid_to || null,
  attributes: (advert.attributes || []).filter((attribute) => ['make', 'model', 'year', 'fuel_type'].includes(String(attribute.code || '').toLowerCase())),
}));
fs.writeFileSync(path.join(process.env.RUNNER_TEMP, 'olx-advert-index.json'), JSON.stringify({ downloaded_at: input.downloaded_at, count: adverts.length, adverts }, null, 2));
