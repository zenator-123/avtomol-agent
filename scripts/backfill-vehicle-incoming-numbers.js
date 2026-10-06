#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
const PAGE_SIZE = 100;
const MAX_PER_RUN = Math.max(1, Number(process.env.LEGACY_INCOMING_BACKFILL_LIMIT || 500));

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^\uFEFF/, '');
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
}
loadDotEnv(path.join(ROOT, '.env'));

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required setting: ${name}`);
  return value;
}

let cachedToken = '';
async function token(shop) {
  if (process.env.SHOPIFY_ACCESS_TOKEN) return process.env.SHOPIFY_ACCESS_TOKEN;
  if (cachedToken) return cachedToken;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env('SHOPIFY_CLIENT_ID'),
    client_secret: env('SHOPIFY_CLIENT_SECRET'),
  });
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, { method: 'POST', headers: { Accept: 'application/json' }, body });
  const json = await response.json();
  if (!response.ok || !json.access_token) throw new Error(`Shopify auth failed: ${json.error_description || json.error || response.status}`);
  cachedToken = json.access_token;
  return cachedToken;
}

async function gql(query, variables = {}) {
  const shop = env('SHOPIFY_SHOP_DOMAIN').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const response = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await token(shop) },
    body: JSON.stringify({ query, variables }),
  });
  const json = await response.json();
  if (!response.ok || json.errors) throw new Error(`Shopify request failed: ${response.status} ${JSON.stringify(json.errors || json)}`);
  return json.data;
}

function extractIncomingNumber(product) {
  const variant = product?.variants?.nodes?.[0] || {};
  const pieces = [
    product?.metafield?.value,
    variant.sku,
    ...(Array.isArray(product?.tags) ? product.tags : []),
    product?.handle,
    product?.title,
    product?.descriptionHtml,
  ].filter(Boolean).map(String);

  for (const value of pieces) {
    const tagged = value.match(/incoming[-_\s:]?([A-Z]{2}\d{5})/i);
    if (tagged) return tagged[1].toUpperCase();
    const plain = value.match(/(?:^|[^A-Z0-9])([A-Z]{2}\d{5})(?:[^A-Z0-9]|$)/i);
    if (plain) return plain[1].toUpperCase();
  }
  return '';
}

function incomingBox(stock) {
  return `<div data-avtomol-incoming="1" style="margin:0 0 22px;padding:18px 16px;border:4px solid #d40000;background:#fff4f4;border-radius:10px;text-align:center"><div style="font-size:30px;line-height:1.1;font-weight:900;color:#d40000;letter-spacing:2px">ВХОДЯЩ НОМЕР</div><div style="font-size:52px;line-height:1.1;font-weight:900;color:#d40000;letter-spacing:4px">${stock}</div></div>`;
}

function withIncomingBox(html, stock) {
  const cleaned = String(html || '')
    .replace(/<div[^>]*data-avtomol-incoming=["']1["'][^>]*>[\s\S]*?<\/div>\s*<\/div>/i, '')
    .replace(/<div[^>]*data-avtomol-incoming=["']1["'][^>]*>[\s\S]*?<\/div>/i, '')
    .trim();
  return incomingBox(stock) + cleaned;
}

async function nextLegacyPage() {
  const data = await gql(`query LegacyVehicles($query: String!) {
    products(first: ${PAGE_SIZE}, query: $query) {
      nodes {
        id title handle descriptionHtml tags
        variants(first: 1) { nodes { id sku } }
        metafield(namespace: "custom", key: "incoming_number") { value }
      }
    }
  }`, { query: 'product_type:"Автомобили втора употреба" AND tag_not:vehicle-sync' });
  return data.products.nodes || [];
}

async function updateLegacy(product, stock) {
  const tags = [...new Set([...(product.tags || []), 'vehicle-sync', `incoming-${stock}`])];
  const descriptionHtml = withIncomingBox(product.descriptionHtml, stock);

  const updated = await gql(`mutation BackfillVehicle($product: ProductUpdateInput!) {
    productUpdate(product: $product) { userErrors { field message } }
  }`, { product: { id: product.id, descriptionHtml, tags } });
  const errors = updated.productUpdate?.userErrors || [];
  if (errors.length) throw new Error(JSON.stringify(errors));

  const mf = await gql(`mutation SaveIncoming($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { userErrors { field message } }
  }`, {
    metafields: [{
      ownerId: product.id,
      namespace: 'custom',
      key: 'incoming_number',
      type: 'single_line_text_field',
      value: stock,
    }],
  });
  const mfErrors = mf.metafieldsSet?.userErrors || [];
  if (mfErrors.length) throw new Error(JSON.stringify(mfErrors));
}

async function main() {
  let repaired = 0;
  let skippedNoStock = 0;

  while (repaired < MAX_PER_RUN) {
    const page = await nextLegacyPage();
    if (!page.length) break;

    let changedOnPage = 0;
    for (const product of page) {
      if (repaired >= MAX_PER_RUN) break;
      const stock = extractIncomingNumber(product);
      if (!stock) {
        skippedNoStock += 1;
        // Tag products with no detectable stock so one bad record cannot block the queue forever.
        const tags = [...new Set([...(product.tags || []), 'incoming-number-missing'])];
        const result = await gql(`mutation FlagMissingStock($product: ProductUpdateInput!) {
          productUpdate(product: $product) { userErrors { field message } }
        }`, { product: { id: product.id, tags } });
        if ((result.productUpdate?.userErrors || []).length) {
          console.warn(`SKIP ${product.id}: no incoming number and could not flag`);
        }
        continue;
      }

      await updateLegacy(product, stock);
      repaired += 1;
      changedOnPage += 1;
      console.log(`BACKFILL ${stock} ${product.title}`);
    }

    if (!changedOnPage && page.every((p) => !extractIncomingNumber(p))) break;
  }

  console.log(JSON.stringify({ repaired, skippedNoStock, maxPerRun: MAX_PER_RUN }));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
