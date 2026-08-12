const fs = require('node:fs/promises');

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
const FB_VERSION = process.env.FACEBOOK_GRAPH_VERSION || 'v25.0';
const APPLY = String(process.env.APPLY_PRICE_CHANGES || 'false').toLowerCase() === 'true';
const LIMIT = Math.max(0, Number(process.env.PRICE_SYNC_LIMIT || 0));
const CHANNEL = String(process.env.PRICE_SYNC_CHANNEL || 'all').toLowerCase();
const FACEBOOK_STRICT = String(process.env.FACEBOOK_STRICT || 'false').toLowerCase() === 'true';
const REPORT_PATH = process.env.PRICE_SYNC_REPORT_PATH || 'price-sync-report.json';
const MINIMUM_PROFIT_EUR = Number(process.env.MINIMUM_PROFIT_EUR || 350);
if (!(MINIMUM_PROFIT_EUR >= 350)) throw new Error('MINIMUM_PROFIT_EUR cannot be below 350');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error('Missing required setting: ' + name);
  return value;
}

function stockFromText(value) {
  return String(value || '').toUpperCase().match(/\b([A-Z]{2}\d{5})\b/)?.[1] || '';
}

function replaceEurPrice(text, price) {
  const source = String(text || '');
  if (!source) return source;
  return source.replace(/\d[\d\s.,]*\s*EUR\b/i, Number(price).toFixed(2) + ' EUR');
}

function buildVehiclePlans(doc) {
  if (!doc || !Array.isArray(doc.updates) || doc.updates.length !== 800) {
    throw new Error('Safety stop: expected exactly 800 advert price plans.');
  }
  const advertIds = new Set();
  const byStock = new Map();
  const rejected = [];
  for (const row of doc.updates) {
    const advertId = Number(row.olx_ad_id);
    const stock = String(row.stock_number || '').toUpperCase();
    const oldPrice = Number(row.expected_old_price_eur);
    const newPrice = Number(row.new_price_eur);
    const landedCost = Number(row.landed_cost_eur);
    const floor = Math.max(Number(row.protected_minimum_eur), landedCost + MINIMUM_PROFIT_EUR);
    const profit = newPrice - landedCost;
    if (!advertId || advertIds.has(advertId)) throw new Error('Safety stop: duplicate or invalid advert id ' + advertId);
    if (!/^[A-Z]{2}\d{5}$/.test(stock)) throw new Error('Safety stop: invalid stock number ' + stock);
    advertIds.add(advertId);
    if (!(landedCost > 0 && newPrice < oldPrice && newPrice >= floor && profit >= MINIMUM_PROFIT_EUR)) {
      rejected.push({ advertId, stock, reason: 'Price is below the required 350 EUR profit', newPrice, landedCost, profit });
      continue;
    }
    const normalized = {
      stock,
      externalId: String(row.external_id || '').toLowerCase(),
      oldPrice,
      newPrice,
      landedCost,
      protectedMinimum: floor,
      forecastProfit: profit,
      olxAdvertId: advertId,
      olxUrl: row.olx_url || '',
    };
    const existing = byStock.get(stock);
    if (existing && Math.abs(existing.newPrice - newPrice) > 0.01) {
      throw new Error('Safety stop: conflicting prices for stock ' + stock);
    }
    if (!existing) byStock.set(stock, normalized);
  }
  return { inputAdvertCount: advertIds.size, advertCount: advertIds.size - rejected.length, vehicles: [...byStock.values()], rejected };
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
  const response = await fetch('https://' + shop + '/admin/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body,
  });
  const json = await response.json();
  if (!response.ok || !json.access_token) throw new Error('Shopify authentication failed: ' + JSON.stringify(json));
  shopifyToken = json.access_token;
  return shopifyToken;
}

async function shopifyGraphql(query, variables) {
  const shop = required('SHOPIFY_SHOP_DOMAIN').replace(/^https?:\/\//, '').replace(/\/$/, '');
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const response = await fetch('https://' + shop + '/admin/api/' + API_VERSION + '/graphql.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await getShopifyToken(shop) },
      body: JSON.stringify({ query, variables: variables || {} }),
    });
    const json = await response.json();
    const errors = json.errors || [];
    const throttled = errors.some((error) => error?.extensions?.code === 'THROTTLED');
    if (throttled && attempt < 12) {
      const throttle = json?.extensions?.cost?.throttleStatus || {};
      const restoreRate = Math.max(1, Number(throttle.restoreRate || 50));
      const requested = Math.max(
        1,
        Number(json?.extensions?.cost?.requestedQueryCost || 100),
      );
      const available = Math.max(0, Number(throttle.currentlyAvailable || 0));
      const waitMs = Math.min(
        30000,
        Math.max(
          1000,
          Math.ceil(((requested - available) / restoreRate) * 1000) + 500,
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    if (!response.ok || errors.length) {
      throw new Error(
        'Shopify request failed: '
          + response.status
          + ' '
          + JSON.stringify(errors.length ? errors : json),
      );
    }
    return json.data;
  }
  throw new Error('Shopify request remained throttled after 12 attempts.');
}

async function listShopifyProducts() {
  const products = [];
  let cursor = null;
  do {
    const data = await shopifyGraphql(
      'query PriceSyncProducts($cursor: String) { products(first: 250, after: $cursor) { nodes { id title handle descriptionHtml status variants(first: 1) { nodes { id price } } metafield(namespace: "custom", key: "incoming_number") { value } } pageInfo { hasNextPage endCursor } } }',
      { cursor }
    );
    products.push(...data.products.nodes);
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);
  return products;
}

function matchPlanForProduct(product, byStock, byExternal) {
  const handle = String(product.handle || '').toLowerCase();
  if (byExternal.has(handle)) return byExternal.get(handle);
  for (const value of [product.metafield?.value, product.handle, product.title, product.descriptionHtml]) {
    const stock = stockFromText(value);
    if (stock && byStock.has(stock)) return byStock.get(stock);
  }
  return null;
}

async function updateShopifyProduct(product, plan) {
  const variant = product.variants?.nodes?.[0];
  if (!variant?.id) throw new Error('No Shopify variant for ' + product.handle);
  const currentPrice = Number(variant.price || 0);
  // This workflow is strictly reduction-only. A stale plan must never raise a
  // price that has already been lowered by another valid process.
  const priceChanged = currentPrice - plan.newPrice > 0.009;
  const newDescription = priceChanged ? replaceEurPrice(product.descriptionHtml, plan.newPrice) : product.descriptionHtml;
  const descriptionChanged = priceChanged && Boolean(product.descriptionHtml) && newDescription !== product.descriptionHtml;
  if (APPLY && priceChanged) {
    const data = await shopifyGraphql(
      'mutation SetVehiclePrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } } }',
      { productId: product.id, variants: [{ id: variant.id, price: plan.newPrice.toFixed(2) }] }
    );
    const errors = data.productVariantsBulkUpdate.userErrors;
    if (errors.length) throw new Error('Shopify price rejected for ' + product.handle + ': ' + JSON.stringify(errors));
  }
  if (APPLY && descriptionChanged) {
    const data = await shopifyGraphql(
      'mutation SetVehicleDescription($product: ProductUpdateInput!) { productUpdate(product: $product) { userErrors { field message } } }',
      { product: { id: product.id, descriptionHtml: newDescription } }
    );
    const errors = data.productUpdate.userErrors;
    if (errors.length) throw new Error('Shopify description rejected for ' + product.handle + ': ' + JSON.stringify(errors));
  }
  return { currentPrice, targetPrice: plan.newPrice, priceChanged, descriptionChanged };
}

async function facebookJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('Facebook returned non-JSON HTTP ' + response.status); }
  if (!response.ok || json.error) throw new Error('Facebook request failed: ' + (json.error?.message || response.status));
  return json;
}

function facebookUrl(pathname, token) {
  const url = new URL('https://graph.facebook.com/' + FB_VERSION + '/' + pathname);
  url.searchParams.set('access_token', token);
  return url;
}

function isFacebookAuthError(error) {
  return /access token|session has expired|oauth|error validating access token/i.test(String(error?.message || error || ''));
}

let facebookPageToken = '';

async function resolveFacebookPage() {
  const token = required('FACEBOOK_PAGE_ACCESS_TOKEN');
  const configuredPageId = required('FACEBOOK_PAGE_ID');
  const me = await facebookJson(facebookUrl('me?fields=id,name', token));
  if (String(me.id) === configuredPageId) {
    facebookPageToken = token;
    return {
      id: String(me.id),
      name: me.name || '',
      configuredPageId,
      tokenDerivedFromManagedPages: false,
    };
  }

  const managedPages = [];
  let next = facebookUrl('me/accounts?fields=id,name,access_token&limit=100', token).toString();
  let pages = 0;
  while (next && pages < 20) {
    const json = await facebookJson(next);
    managedPages.push(...(json.data || []));
    next = json.paging?.next || '';
    pages += 1;
  }
  const page = managedPages.find((item) => String(item.id) === configuredPageId);
  if (!page?.access_token) {
    throw new Error(
      'Facebook identity mismatch: configured page '
        + configuredPageId
        + ' is not available to token identity '
        + String(me.id || 'unknown')
        + '.'
    );
  }
  facebookPageToken = page.access_token;
  return {
    id: String(page.id),
    name: page.name || '',
    configuredPageId,
    tokenDerivedFromManagedPages: true,
  };
}

async function listFacebookPosts() {
  const page = await resolveFacebookPage();
  const posts = [];
  let next = facebookUrl(page.id + '/published_posts?fields=id,message,permalink_url,created_time&limit=100', facebookPageToken).toString();
  let pages = 0;
  while (next && pages < 100) {
    const json = await facebookJson(next);
    posts.push(...(json.data || []));
    next = json.paging?.next || '';
    pages += 1;
  }
  return { page, posts };
}

async function updateFacebookPost(post, plan) {
  if (!facebookPageToken) throw new Error('Facebook page token was not resolved.');
  const message = replaceEurPrice(post.message, plan.newPrice);
  const changed = Boolean(post.message) && message !== post.message;
  if (APPLY && changed) {
    await facebookJson('https://graph.facebook.com/' + FB_VERSION + '/' + post.id, {
      method: 'POST',
      body: new URLSearchParams({ message, access_token: facebookPageToken }),
    });
  }
  return { changed };
}

async function main() {
  const priceDoc = JSON.parse(await fs.readFile(process.env.PRICE_SYNC_DATA || 'data/market-price-updates-800.json', 'utf8'));
  const built = buildVehiclePlans(priceDoc);
  let vehicles = built.vehicles;
  if (LIMIT) vehicles = vehicles.slice(0, LIMIT);
  const byStock = new Map(vehicles.map((plan) => [plan.stock, plan]));
  const byExternal = new Map(vehicles.map((plan) => [plan.externalId, plan]));
  const report = {
    startedAt: new Date().toISOString(),
    applyChanges: APPLY,
    channel: CHANNEL,
    inputAdvertPlans: built.inputAdvertCount,
    advertPlans: built.advertCount,
    rejectedPricePlans: built.rejected,
    uniqueVehiclePlans: built.vehicles.length,
    selectedVehiclePlans: vehicles.length,
    shopify: { enabled: CHANNEL === 'all' || CHANNEL === 'shopify', productsRead: 0, matchedProducts: 0, updatedPrices: 0, updatedDescriptions: 0, missingStocks: [], failures: [] },
    facebook: { enabled: CHANNEL === 'all' || CHANNEL === 'facebook', degraded: false, page: null, postsRead: 0, matchedPosts: 0, updatedPosts: 0, missingStocks: [], failures: [] },
  };

  if (report.shopify.enabled) {
    const products = await listShopifyProducts();
    report.shopify.productsRead = products.length;
    const matchedStocks = new Set();
    for (const product of products) {
      const plan = matchPlanForProduct(product, byStock, byExternal);
      if (!plan) continue;
      matchedStocks.add(plan.stock);
      report.shopify.matchedProducts += 1;
      try {
        const result = await updateShopifyProduct(product, plan);
        if (result.priceChanged) report.shopify.updatedPrices += 1;
        if (result.descriptionChanged) report.shopify.updatedDescriptions += 1;
        console.log((APPLY ? 'SHOPIFY UPDATE ' : 'SHOPIFY CHECK ') + plan.stock + ' ' + result.currentPrice + ' -> ' + result.targetPrice + ' ' + product.handle);
      } catch (error) {
        report.shopify.failures.push({ stock: plan.stock, handle: product.handle, error: error.message });
      }
    }
    report.shopify.missingStocks = vehicles.filter((plan) => !matchedStocks.has(plan.stock)).map((plan) => plan.stock);
  }

  if (report.facebook.enabled) {
    try {
      const result = await listFacebookPosts();
      report.facebook.page = result.page;
      report.facebook.postsRead = result.posts.length;
      const postsByStock = new Map();
      for (const post of result.posts) {
        const stock = stockFromText(post.message);
        if (!stock || !byStock.has(stock)) continue;
        if (!postsByStock.has(stock)) postsByStock.set(stock, []);
        postsByStock.get(stock).push(post);
      }
      for (const plan of vehicles) {
        const posts = postsByStock.get(plan.stock) || [];
        if (!posts.length) {
          report.facebook.missingStocks.push(plan.stock);
          continue;
        }
        for (const post of posts) {
          report.facebook.matchedPosts += 1;
          try {
            const update = await updateFacebookPost(post, plan);
            if (update.changed) report.facebook.updatedPosts += 1;
            console.log((APPLY ? 'FACEBOOK UPDATE ' : 'FACEBOOK CHECK ') + plan.stock + ' ' + post.id);
          } catch (error) {
            report.facebook.failures.push({ stock: plan.stock, postId: post.id, error: error.message });
          }
        }
      }
    } catch (error) {
      report.facebook.degraded = true;
      report.facebook.failures.push({ stage: 'authentication-or-list', error: error.message, authentication: isFacebookAuthError(error) });
      console.warn('::warning::Facebook sync skipped: ' + error.message);
    }
  }
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(report, null, 2));
  if (report.shopify.failures.length || (FACEBOOK_STRICT && report.facebook.failures.length)) process.exitCode = 1;
}

if (require.main === module) main().catch(async (error) => {
  console.error(error.stack || error.message);
  try { await fs.writeFile(REPORT_PATH, JSON.stringify({ fatal: error.message, stack: error.stack }, null, 2) + '\n', 'utf8'); } catch {}
  process.exitCode = 1;
});

module.exports = { stockFromText, replaceEurPrice, buildVehiclePlans, matchPlanForProduct, isFacebookAuthError };
