const fs = require('node:fs/promises');

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
const SHOP = String(process.env.SHOPIFY_SHOP_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
const REPORT = 'rollback-price-increases-report.json';
const rows = [
  ['avtomol-audi-fb00841', 7800, 6900],
  ['avtomol-bmw-vz29084', 4500, 4450],
  ['avtomol-bmw-zc06756', 4500, 4450],
  ['avtomol-volkswagen-ha50669', 4800, 4550],
  ['avtomol-volkswagen-vu20693', 6000, 5900],
  ['avtomol-volkswagen-ys09397', 6900, 6350],
  ['avtomol-volkswagen-am24722', 8700, 8050],
  ['avtomol-volkswagen-yh93903', 12200, 11250],
  ['avtomol-mercedes-benz-ph89207', 3900, 3550],
];

function required(name) { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; }
let accessToken = '';
async function token() {
  if (process.env.SHOPIFY_ACCESS_TOKEN) return process.env.SHOPIFY_ACCESS_TOKEN;
  if (accessToken) return accessToken;
  const response = await fetch(`https://${SHOP}/admin/oauth/access_token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: required('SHOPIFY_CLIENT_ID'), client_secret: required('SHOPIFY_CLIENT_SECRET') }) });
  const json = await response.json(); if (!response.ok || !json.access_token) throw new Error(`Shopify authentication failed: ${response.status}`);
  accessToken = json.access_token; return accessToken;
}
async function gql(query, variables) {
  const response = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await token() }, body: JSON.stringify({ query, variables }) });
  const json = await response.json(); if (!response.ok || json.errors?.length) throw new Error(JSON.stringify(json.errors || json)); return json.data;
}
function replacePrice(text, price) { return String(text || '').replace(/\d[\d\s.,]*\s*EUR\b/i, `${price.toFixed(2)} EUR`); }

(async () => {
  required('SHOPIFY_SHOP_DOMAIN');
  const report = { startedAt: new Date().toISOString(), planned: rows.length, restored: 0, alreadyRestored: 0, failed: 0, results: [] };
  for (const [handle, incorrect, restore] of rows) {
    try {
      const data = await gql('query RollbackProduct($query: String!) { products(first: 2, query: $query) { nodes { id handle descriptionHtml variants(first: 1) { nodes { id price } } } } }', { query: `handle:${handle}` });
      const product = data.products.nodes.find((item) => item.handle === handle); if (!product) throw new Error('Product not found');
      const variant = product.variants.nodes[0]; const current = Number(variant.price);
      if (Math.abs(current - restore) < 0.01) { report.alreadyRestored++; report.results.push({ handle, result: 'already-restored', price: current }); continue; }
      if (Math.abs(current - incorrect) > 0.01) throw new Error(`Current price ${current} differs from rollback guard ${incorrect}`);
      const changed = await gql('mutation RestorePrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $product: ProductUpdateInput!) { productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } } productUpdate(product: $product) { userErrors { field message } } }', { productId: product.id, variants: [{ id: variant.id, price: restore.toFixed(2) }], product: { id: product.id, descriptionHtml: replacePrice(product.descriptionHtml, restore) } });
      const errors = [...changed.productVariantsBulkUpdate.userErrors, ...changed.productUpdate.userErrors]; if (errors.length) throw new Error(JSON.stringify(errors));
      report.restored++; report.results.push({ handle, result: 'restored', from: current, to: restore });
    } catch (error) { report.failed++; report.results.push({ handle, result: 'failed', error: error.message }); }
  }
  report.finishedAt = new Date().toISOString(); await fs.writeFile(REPORT, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); if (report.failed) process.exitCode = 1;
})().catch(async (error) => { await fs.writeFile(REPORT, JSON.stringify({ fatal: error.message }, null, 2)); throw error; });
