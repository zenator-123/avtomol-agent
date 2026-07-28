const crypto = require('node:crypto');
const fs = require('node:fs/promises');

const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
const MANIFEST_PATH = process.env.FULL_CATALOG_AUDIT_MANIFEST_PATH
  || 'data/full-catalog-stock-audit.enc.json';
const REPORT_PATH = process.env.FULL_CATALOG_AUDIT_REPORT_PATH
  || 'full-catalog-stock-audit-report.json';

const clean = (value) => String(value ?? '').trim();
const stockFrom = (value) => clean(value).toUpperCase().match(/\b[A-Z]{2}\d{5}\b/)?.[0] || '';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required setting: ${name}`);
  return value;
}

async function request(url, options = {}, attempts = 8) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url, options);
    const text = await response.text();
    let json = null;
    if (text) {
      try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 1000) }; }
    }
    if (response.ok) return { response, json };
    if ((response.status === 429 || response.status >= 500) && attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(15000, 750 * (2 ** (attempt - 1)))));
      continue;
    }
    throw new Error(`${options.method || 'GET'} ${url} failed: HTTP ${response.status} ${JSON.stringify(json)}`);
  }
  throw new Error(`Request failed after ${attempts} attempts: ${url}`);
}

async function decryptManifest() {
  const document = JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8'));
  if (document.algorithm !== 'aes-256-gcm') throw new Error('Unsupported audit manifest encryption.');
  const key = Buffer.from(required('REPLACEMENT_MANIFEST_KEY'), 'base64');
  if (key.length !== 32) throw new Error('REPLACEMENT_MANIFEST_KEY must decode to 32 bytes.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(document.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(document.authTag, 'base64'));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(document.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8'));
}

function validateStocks(name, values) {
  if (!Array.isArray(values)) throw new Error(`${name} must be an array.`);
  const stocks = values.map((value) => stockFrom(value));
  if (stocks.some((stock) => !stock)) throw new Error(`${name} contains an invalid stock number.`);
  if (new Set(stocks).size !== stocks.length) throw new Error(`${name} contains duplicate stock numbers.`);
  return stocks;
}

function validateManifest(manifest) {
  const oldCatalogStocks = validateStocks('oldCatalogStocks', manifest.oldCatalogStocks);
  const stillAvailableStocks = validateStocks('stillAvailableStocks', manifest.stillAvailableStocks);
  const soldOrUnavailableStocks = validateStocks('soldOrUnavailableStocks', manifest.soldOrUnavailableStocks);
  const newEligibleStocks = validateStocks('newEligibleStocks', manifest.newEligibleStocks);

  const old = new Set(oldCatalogStocks);
  const still = new Set(stillAvailableStocks);
  const sold = new Set(soldOrUnavailableStocks);
  const replacements = new Set(newEligibleStocks);

  if (still.size + sold.size !== old.size) {
    throw new Error('Safety stop: current and sold partitions do not cover the old catalog exactly.');
  }
  for (const stock of still) {
    if (!old.has(stock) || sold.has(stock)) throw new Error(`Invalid still-available stock: ${stock}`);
  }
  for (const stock of sold) {
    if (!old.has(stock) || still.has(stock)) throw new Error(`Invalid sold stock: ${stock}`);
  }
  for (const stock of replacements) {
    if (old.has(stock)) throw new Error(`Replacement stock overlaps the old catalog: ${stock}`);
  }

  return {
    ...manifest,
    oldCatalogStocks,
    stillAvailableStocks,
    soldOrUnavailableStocks,
    newEligibleStocks,
  };
}

let shopifyToken = '';
async function getShopifyToken() {
  if (process.env.SHOPIFY_ACCESS_TOKEN) return process.env.SHOPIFY_ACCESS_TOKEN;
  if (shopifyToken) return shopifyToken;
  const shop = required('SHOPIFY_SHOP_DOMAIN').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: required('SHOPIFY_CLIENT_ID'),
    client_secret: required('SHOPIFY_CLIENT_SECRET'),
  });
  const { json } = await request(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body,
  });
  if (!json?.access_token) throw new Error('Shopify authentication did not return an access token.');
  shopifyToken = json.access_token;
  return shopifyToken;
}

async function shopifyGraphql(query, variables = {}) {
  const shop = required('SHOPIFY_SHOP_DOMAIN').replace(/^https?:\/\//, '').replace(/\/$/, '');
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const { json } = await request(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': await getShopifyToken(),
      },
      body: JSON.stringify({ query, variables }),
    });
    const errors = json?.errors || [];
    const throttled = errors.some((error) => error?.extensions?.code === 'THROTTLED');
    if (throttled && attempt < 12) {
      const throttle = json?.extensions?.cost?.throttleStatus || {};
      const restoreRate = Math.max(1, Number(throttle.restoreRate || 50));
      const requested = Math.max(1, Number(json?.extensions?.cost?.requestedQueryCost || 100));
      const available = Math.max(0, Number(throttle.currentlyAvailable || 0));
      const waitMs = Math.min(
        30000,
        Math.max(1000, Math.ceil(((requested - available) / restoreRate) * 1000) + 500),
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    if (errors.length) throw new Error(`Shopify GraphQL error: ${JSON.stringify(errors)}`);
    return json.data;
  }
  throw new Error('Shopify GraphQL remained throttled after 12 attempts.');
}

async function listShopifyProducts() {
  const products = [];
  let cursor = null;
  do {
    const data = await shopifyGraphql(`query FullCatalogAudit($cursor: String) {
      products(first: 250, after: $cursor) {
        nodes {
          id
          title
          handle
          status
          variants(first: 1) { nodes { id sku price } }
          incoming: metafield(namespace: "custom", key: "incoming_number") { value }
          facebookPost: metafield(namespace: "custom", key: "facebook_post_id") { value }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`, { cursor });
    products.push(...data.products.nodes);
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
    if (products.length % 5000 === 0) {
      console.log(JSON.stringify({ phase: 'shopify-read', products: products.length }));
    }
  } while (cursor);
  return products;
}

function productStock(product) {
  return stockFrom(product.incoming?.value)
    || stockFrom(product.variants?.nodes?.[0]?.sku)
    || stockFrom(product.handle)
    || stockFrom(product.title);
}

function auditGroup(stocks, byStock) {
  const rows = [];
  let matchedStocks = 0;
  let productRows = 0;
  let activeProducts = 0;
  let draftProducts = 0;
  let archivedProducts = 0;
  const missingStocks = [];
  const duplicateStocks = [];

  for (const stock of stocks) {
    const products = byStock.get(stock) || [];
    if (!products.length) {
      missingStocks.push(stock);
      continue;
    }
    matchedStocks += 1;
    productRows += products.length;
    if (products.length > 1) duplicateStocks.push(stock);
    for (const product of products) {
      if (product.status === 'ACTIVE') activeProducts += 1;
      else if (product.status === 'DRAFT') draftProducts += 1;
      else if (product.status === 'ARCHIVED') archivedProducts += 1;
    }
    rows.push({
      stock,
      products: products.map((product) => ({
        id: product.id,
        handle: product.handle,
        title: product.title,
        status: product.status,
        sku: product.variants?.nodes?.[0]?.sku || '',
        price: product.variants?.nodes?.[0]?.price || '',
        facebookPostId: product.facebookPost?.value || '',
      })),
    });
  }

  return {
    requestedStocks: stocks.length,
    matchedStocks,
    productRows,
    activeProducts,
    draftProducts,
    archivedProducts,
    missingStocks,
    duplicateStocks,
    rows,
  };
}

async function main() {
  const manifest = validateManifest(await decryptManifest());
  const products = await listShopifyProducts();
  const byStock = new Map();
  for (const product of products) {
    const stock = productStock(product);
    if (!stock) continue;
    if (!byStock.has(stock)) byStock.set(stock, []);
    byStock.get(stock).push(product);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    manifest: {
      generatedAt: manifest.generatedAt,
      criteria: manifest.criteria,
      oldCatalogStocks: manifest.oldCatalogStocks.length,
      stillAvailableStocks: manifest.stillAvailableStocks.length,
      soldOrUnavailableStocks: manifest.soldOrUnavailableStocks.length,
      newEligibleStocks: manifest.newEligibleStocks.length,
    },
    shopify: {
      productsRead: products.length,
      productsWithStock: [...byStock.values()].reduce((sum, rows) => sum + rows.length, 0),
      uniqueStocks: byStock.size,
    },
    stillAvailable: auditGroup(manifest.stillAvailableStocks, byStock),
    soldOrUnavailable: auditGroup(manifest.soldOrUnavailableStocks, byStock),
    newEligible: auditGroup(manifest.newEligibleStocks, byStock),
  };

  await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    report: REPORT_PATH,
    productsRead: report.shopify.productsRead,
    oldCatalog: report.manifest.oldCatalogStocks,
    soldOrUnavailable: report.manifest.soldOrUnavailableStocks,
    soldActiveProducts: report.soldOrUnavailable.activeProducts,
    newEligible: report.manifest.newEligibleStocks,
    newEligibleMatched: report.newEligible.matchedStocks,
    newEligibleActiveProducts: report.newEligible.activeProducts,
    newEligibleDraftProducts: report.newEligible.draftProducts,
    newEligibleMissing: report.newEligible.missingStocks.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
