const fs = require('node:fs/promises');

const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
const FACEBOOK_API_VERSION = process.env.FACEBOOK_GRAPH_VERSION || 'v25.0';
const MODE = String(process.env.SYNC_MODE || 'dry-run').toLowerCase();
const CHANNEL = String(process.env.SYNC_CHANNEL || 'all').toLowerCase();
const PLAN_PATH = process.env.INACTIVE_PLAN_PATH || 'data/inactive-vehicle-sync.json';
const REPORT_PATH = process.env.INACTIVE_REPORT_PATH || 'inactive-vehicle-sync-report.json';

if (!['dry-run', 'apply'].includes(MODE)) throw new Error(`Invalid SYNC_MODE: ${MODE}`);
if (!['all', 'shopify', 'facebook', 'olx'].includes(CHANNEL)) throw new Error(`Invalid SYNC_CHANNEL: ${CHANNEL}`);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required setting: ${name}`);
  return value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function requestJson(url, options = {}, attempts = 4) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url, options);
    const text = await response.text();
    let json = null;
    if (text) {
      try { json = JSON.parse(text); }
      catch { json = { raw: text.slice(0, 1000) }; }
    }
    if (response.ok) return { response, json };
    if ((response.status === 429 || response.status >= 500) && attempt < attempts) {
      await sleep(Math.min(8000, 700 * (2 ** (attempt - 1))));
      continue;
    }
    throw new Error(`${options.method || 'GET'} ${url} failed: HTTP ${response.status} ${JSON.stringify(json)}`);
  }
  throw new Error(`Request failed after ${attempts} attempts: ${url}`);
}

function stockFromText(value) {
  return String(value || '').toUpperCase().match(/\b([A-Z]{2}\d{5})\b/)?.[1] || '';
}

function validatePlan(doc) {
  if (!doc || doc.total_checked !== 744 || !Array.isArray(doc.inactive_stocks) || !Array.isArray(doc.olx_adverts)) {
    throw new Error('Safety stop: invalid inactive-vehicle plan.');
  }
  if (doc.inactive_stocks.length !== 462) {
    throw new Error(`Safety stop: expected 462 inactive stocks, received ${doc.inactive_stocks.length}.`);
  }
  const stocks = new Set();
  for (const value of doc.inactive_stocks) {
    const stock = String(value || '').toUpperCase();
    if (!/^[A-Z]{2}\d{5}$/.test(stock) || stocks.has(stock)) {
      throw new Error(`Safety stop: invalid or duplicate stock ${stock || '(empty)'}.`);
    }
    stocks.add(stock);
  }
  const adverts = [];
  const advertIds = new Set();
  for (const row of doc.olx_adverts) {
    const id = String(row.olx_ad_id || '');
    const stock = String(row.stock_number || '').toUpperCase();
    if (!/^\d+$/.test(id) || advertIds.has(id) || !stocks.has(stock)) {
      throw new Error(`Safety stop: invalid OLX mapping ${id}/${stock}.`);
    }
    advertIds.add(id);
    adverts.push({ olx_ad_id: id, stock_number: stock });
  }
  if (adverts.length !== 533) {
    throw new Error(`Safety stop: expected 533 unique OLX advert IDs, received ${adverts.length}.`);
  }
  return { stocks, adverts };
}

let shopifyToken = '';
async function getShopifyToken(shop) {
  if (process.env.SHOPIFY_ACCESS_TOKEN) return process.env.SHOPIFY_ACCESS_TOKEN;
  if (shopifyToken) return shopifyToken;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: required('SHOPIFY_CLIENT_ID'),
    client_secret: required('SHOPIFY_CLIENT_SECRET'),
  });
  const { json } = await requestJson(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body,
  });
  if (!json?.access_token) throw new Error('Shopify authentication failed: no access token.');
  shopifyToken = json.access_token;
  return shopifyToken;
}

async function shopifyGraphql(query, variables) {
  const shop = required('SHOPIFY_SHOP_DOMAIN').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const { json } = await requestJson(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': await getShopifyToken(shop),
    },
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  if (json.errors) throw new Error(`Shopify GraphQL failed: ${JSON.stringify(json.errors)}`);
  return json.data;
}

async function listShopifyProducts() {
  const products = [];
  let cursor = null;
  do {
    const data = await shopifyGraphql(
      `query InactiveVehicleProducts($cursor: String) {
        products(first: 250, after: $cursor) {
          nodes {
            id title handle descriptionHtml status
            metafield(namespace: "custom", key: "incoming_number") { value }
            variants(first: 20) {
              nodes {
                id sku
                inventoryItem {
                  id
                  inventoryLevels(first: 20) {
                    nodes {
                      location { id name }
                      quantities(names: ["available"]) { name quantity }
                    }
                  }
                }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { cursor },
    );
    products.push(...data.products.nodes);
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);
  return products;
}

function stockForShopifyProduct(product, stocks) {
  const candidates = [
    product.metafield?.value,
    ...(product.variants?.nodes || []).map((variant) => variant.sku),
    product.handle,
    product.title,
    product.descriptionHtml,
  ];
  for (const candidate of candidates) {
    const stock = stockFromText(candidate);
    if (stock && stocks.has(stock)) return stock;
  }
  return '';
}

async function draftShopifyProduct(product) {
  const data = await shopifyGraphql(
    `mutation DraftInactiveVehicle($product: ProductUpdateInput!) {
      productUpdate(product: $product) { userErrors { field message } }
    }`,
    { product: { id: product.id, status: 'DRAFT' } },
  );
  const errors = data.productUpdate.userErrors;
  if (errors.length) throw new Error(`Shopify draft rejected: ${JSON.stringify(errors)}`);
}

async function zeroShopifyInventory(product) {
  const quantities = [];
  for (const variant of product.variants?.nodes || []) {
    const itemId = variant.inventoryItem?.id;
    if (!itemId) continue;
    for (const level of variant.inventoryItem?.inventoryLevels?.nodes || []) {
      const available = level.quantities?.find((entry) => entry.name === 'available')?.quantity;
      if (Number(available) === 0) continue;
      quantities.push({
        inventoryItemId: itemId,
        locationId: level.location.id,
        quantity: 0,
      });
    }
  }
  if (!quantities.length) return 0;
  const data = await shopifyGraphql(
    `mutation ZeroInactiveInventory($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        userErrors { code field message }
      }
    }`,
    {
      input: {
        name: 'available',
        reason: 'correction',
        ignoreCompareQuantity: true,
        quantities,
      },
    },
  );
  const errors = data.inventorySetQuantities.userErrors;
  if (errors.length) throw new Error(`Shopify inventory rejected: ${JSON.stringify(errors)}`);
  return quantities.length;
}

async function syncShopify(plan, report) {
  const products = await listShopifyProducts();
  report.shopify.products_read = products.length;
  for (const product of products) {
    const stock = stockForShopifyProduct(product, plan.stocks);
    if (!stock) continue;
    report.shopify.matched += 1;
    try {
      const needsDraft = String(product.status || '').toUpperCase() !== 'DRAFT';
      if (MODE === 'apply' && needsDraft) await draftShopifyProduct(product);
      let inventoryChanges = 0;
      if (MODE === 'apply') inventoryChanges = await zeroShopifyInventory(product);
      if (needsDraft) report.shopify.drafted += 1;
      report.shopify.inventory_zeroed += inventoryChanges;
      report.shopify.results.push({ stock, handle: product.handle, action: needsDraft ? 'draft' : 'already-draft', inventoryChanges });
    } catch (error) {
      report.shopify.failures.push({ stock, handle: product.handle, error: error.message });
    }
  }
}

function facebookUrl(pathname, token) {
  const url = new URL(`https://graph.facebook.com/${FACEBOOK_API_VERSION}/${pathname}`);
  url.searchParams.set('access_token', token);
  return url;
}

async function listFacebookPosts() {
  const token = required('FACEBOOK_PAGE_ACCESS_TOKEN');
  const pageId = process.env.FACEBOOK_PAGE_ID || 'me';
  const posts = [];
  let next = facebookUrl(`${pageId}/feed?fields=id,message,permalink_url,created_time&limit=100`, token).toString();
  let pages = 0;
  while (next && pages < 50) {
    const { json } = await requestJson(next);
    posts.push(...(json.data || []));
    next = json.paging?.next || '';
    pages += 1;
  }
  return posts;
}

async function deleteFacebookPost(postId) {
  const token = required('FACEBOOK_PAGE_ACCESS_TOKEN');
  await requestJson(`https://graph.facebook.com/${FACEBOOK_API_VERSION}/${postId}`, {
    method: 'DELETE',
    body: new URLSearchParams({ access_token: token }),
  });
}

async function syncFacebook(plan, report) {
  const posts = await listFacebookPosts();
  report.facebook.posts_read = posts.length;
  for (const post of posts) {
    const stock = stockFromText(post.message);
    if (!stock || !plan.stocks.has(stock)) continue;
    report.facebook.matched += 1;
    try {
      if (MODE === 'apply') await deleteFacebookPost(post.id);
      report.facebook.removed += 1;
      report.facebook.results.push({ stock, post_id: post.id, action: 'remove-inactive' });
    } catch (error) {
      report.facebook.failures.push({ stock, post_id: post.id, error: error.message });
    }
  }
}

function olxHeaders() {
  return {
    Authorization: `Bearer ${required('OLX_ACCESS_TOKEN')}`,
    Version: '2.0',
    Accept: 'application/json',
  };
}

async function readOlxAdvert(advertId) {
  const { json } = await requestJson(`https://www.olx.bg/api/partner/adverts/${advertId}`, {
    headers: olxHeaders(),
  });
  return json;
}

async function deleteOlxAdvert(advertId) {
  await requestJson(`https://www.olx.bg/api/partner/adverts/${advertId}`, {
    method: 'DELETE',
    headers: olxHeaders(),
  });
}

async function syncOlx(plan, report) {
  report.olx.planned = plan.adverts.length;
  for (let index = 0; index < plan.adverts.length; index += 1) {
    const row = plan.adverts[index];
    try {
      const advert = await readOlxAdvert(row.olx_ad_id);
      const status = String(advert.status || '').toLowerCase();
      if (status === 'active') {
        report.olx.results.push({ ...row, action: 'retained-for-verified-replacement' });
      } else {
        report.olx.already_inactive += 1;
        report.olx.results.push({ ...row, action: 'already-inactive', status });
      }
    } catch (error) {
      report.olx.failures.push({ ...row, error: error.message });
    }
    if (MODE === 'apply') await sleep(300);
    if ((index + 1) % 50 === 0 || index === plan.adverts.length - 1) {
      console.log(`OLX ${index + 1}/${plan.adverts.length}; removed=${report.olx.removed}; inactive=${report.olx.already_inactive}; failed=${report.olx.failures.length}`);
    }
  }
}

async function main() {
  const doc = JSON.parse(await fs.readFile(PLAN_PATH, 'utf8'));
  const plan = validatePlan(doc);
  const report = {
    started_at: new Date().toISOString(),
    mode: MODE,
    channel: CHANNEL,
    plan: {
      verified_at: doc.verified_at,
      total_checked: doc.total_checked,
      active_stocks: doc.active_stocks,
      inactive_stocks: plan.stocks.size,
      olx_adverts: plan.adverts.length,
    },
    shopify: { enabled: CHANNEL === 'all' || CHANNEL === 'shopify', products_read: 0, matched: 0, drafted: 0, inventory_zeroed: 0, failures: [], results: [] },
    facebook: { enabled: CHANNEL === 'all' || CHANNEL === 'facebook', posts_read: 0, matched: 0, removed: 0, failures: [], results: [] },
    olx: { enabled: CHANNEL === 'all' || CHANNEL === 'olx', planned: 0, removed: 0, already_inactive: 0, failures: [], results: [] },
  };

  if (report.shopify.enabled) await syncShopify(plan, report);
  if (report.facebook.enabled) await syncFacebook(plan, report);
  if (report.olx.enabled) await syncOlx(plan, report);

  report.finished_at = new Date().toISOString();
  await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({
    shopify: { matched: report.shopify.matched, drafted: report.shopify.drafted, failures: report.shopify.failures.length },
    facebook: { matched: report.facebook.matched, removed: report.facebook.removed, failures: report.facebook.failures.length },
    olx: { planned: report.olx.planned, removed: report.olx.removed, alreadyInactive: report.olx.already_inactive, failures: report.olx.failures.length },
  }, null, 2));
  if (report.shopify.failures.length || report.facebook.failures.length || report.olx.failures.length) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error(error.stack || error.message);
  try {
    await fs.writeFile(REPORT_PATH, JSON.stringify({ fatal: error.message, stack: error.stack }, null, 2) + '\n', 'utf8');
  } catch {}
  process.exitCode = 1;
});
