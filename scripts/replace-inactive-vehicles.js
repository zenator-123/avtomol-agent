const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { isAvailableFeedVehicle } = require('../lib/olx-replacement-matcher');

const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
const FACEBOOK_API_VERSION = process.env.FACEBOOK_GRAPH_VERSION || 'v25.0';
const MODE = String(process.env.REPLACEMENT_MODE || 'dry-run').toLowerCase();
const CHANNEL = String(process.env.REPLACEMENT_CHANNEL || 'all').toLowerCase();
const OFFSET = Math.max(0, Number(process.env.REPLACEMENT_OFFSET || 0));
const LIMIT = Math.max(0, Number(process.env.REPLACEMENT_LIMIT || 0));
const LOCAL_VALIDATE_ONLY = String(process.env.REPLACEMENT_LOCAL_VALIDATE_ONLY || 'false').toLowerCase() === 'true';
const ALLOW_OLX_REFRESH = String(process.env.OLX_ALLOW_REFRESH || 'false').toLowerCase() === 'true';
const OLX_UPDATE_EXISTING = String(process.env.OLX_UPDATE_EXISTING || 'false').toLowerCase() === 'true';
const FACEBOOK_CREATE_LIMIT = Math.max(0, Number(process.env.FACEBOOK_CREATE_LIMIT || 0));
const FACEBOOK_UPDATE_EXISTING = String(process.env.FACEBOOK_UPDATE_EXISTING || 'true').toLowerCase() === 'true';
const MANIFEST_PATH = process.env.REPLACEMENT_MANIFEST_PATH || 'data/replacement-vehicles-2026-07-27.enc.json';
const REPORT_PATH = process.env.REPLACEMENT_REPORT_PATH || 'replacement-vehicle-sync-report.json';
const OLX_TOKEN_HANDOFF_PATH = process.env.OLX_TOKEN_HANDOFF_PATH || '';

if (!['dry-run', 'apply'].includes(MODE)) throw new Error(`Invalid REPLACEMENT_MODE: ${MODE}`);
if (!['all', 'shopify', 'facebook', 'olx'].includes(CHANNEL)) throw new Error(`Invalid REPLACEMENT_CHANNEL: ${CHANNEL}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clean = (value) => String(value ?? '').trim();
const stockFrom = (value) => clean(value).toUpperCase().match(/\b[A-Z]{2}\d{5}\b/)?.[0] || '';
const normalized = (value) => clean(value)
  .normalize('NFKD')
  .replace(/\p{Diacritic}/gu, '')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim();
const normalizedLoose = (value) => normalized(value).replace(/\s+/g, '');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required setting: ${name}`);
  return value;
}

async function request(url, options = {}, attempts = 5) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url, options);
    const text = await response.text();
    let json = null;
    if (text) {
      try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 1000) }; }
    }
    if (response.ok) return { response, json, text };
    const transientCloudFrontBlock = response.status === 403
      && /cloudfront|request blocked|request could not be satisfied/i.test(text);
    if ((response.status === 429 || response.status >= 500 || transientCloudFrontBlock) && attempt < attempts) {
      await sleep(Math.min(15000, 750 * (2 ** (attempt - 1))));
      continue;
    }
    const error = new Error(`${options.method || 'GET'} ${url} failed: HTTP ${response.status} ${JSON.stringify(json)}`);
    error.status = response.status;
    error.body = json;
    throw error;
  }
  throw new Error(`Request failed after ${attempts} attempts: ${url}`);
}

async function decryptManifest() {
  const document = JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8'));
  if (document.algorithm !== 'aes-256-gcm') throw new Error('Unsupported replacement manifest encryption.');
  const key = Buffer.from(required('REPLACEMENT_MANIFEST_KEY'), 'base64');
  if (key.length !== 32) throw new Error('REPLACEMENT_MANIFEST_KEY must decode to 32 bytes.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(document.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(document.authTag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(document.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(plaintext);
}

function validateManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.vehicles) || !Array.isArray(manifest.inactiveVehicles)) {
    throw new Error('Invalid replacement manifest structure.');
  }
  const olxFallbackVehicles = Array.isArray(manifest.olxFallbackVehicles) ? manifest.olxFallbackVehicles : [];
  if (manifest.vehicles.length !== 462 || manifest.inactiveVehicles.length !== 462) {
    throw new Error(`Safety stop: expected 462 replacements and 462 inactive vehicles, received ${manifest.vehicles.length} and ${manifest.inactiveVehicles.length}.`);
  }
  const newStocks = new Set();
  const oldStocks = new Set();
  for (const vehicle of manifest.vehicles) {
    if (!/^[A-Z]{2}\d{5}$/.test(vehicle.stock) || newStocks.has(vehicle.stock)) {
      throw new Error(`Invalid or duplicate replacement stock: ${vehicle.stock}`);
    }
    if (vehicle.directPurchase !== true || vehicle.isUnroadworthy !== false) {
      throw new Error(`Safety stop: ${vehicle.stock} is not a confirmed roadworthy direct purchase.`);
    }
    if (!(Number(vehicle.price) > Number(vehicle.landedCost)) || !(Number(vehicle.expectedGrossProfit) > 0)) {
      throw new Error(`Safety stop: ${vehicle.stock} has no positive protected margin.`);
    }
    if (!vehicle.handle || !vehicle.title || !vehicle.bodyHtml || !Array.isArray(vehicle.images) || !vehicle.images.length) {
      throw new Error(`Safety stop: ${vehicle.stock} has incomplete public listing data.`);
    }
    if (!vehicle.seo?.pageTitle?.startsWith('Продавам')) {
      throw new Error(`Safety stop: ${vehicle.stock} has an invalid SEO page title.`);
    }
    if (vehicle.bodyHtml.includes('???') || vehicle.seo.pageBodyHtml.includes('???')) {
      throw new Error(`Safety stop: ${vehicle.stock} contains invalid UTF-8 placeholders.`);
    }
    newStocks.add(vehicle.stock);
  }
  for (const vehicle of olxFallbackVehicles) {
    if (!/^[A-Z]{2}\d{5}$/.test(vehicle.stock) || newStocks.has(vehicle.stock)) {
      throw new Error(`Invalid or duplicate OLX fallback stock: ${vehicle.stock}`);
    }
    if (vehicle.directPurchase !== true || vehicle.isUnroadworthy !== false) {
      throw new Error(`Safety stop: OLX fallback ${vehicle.stock} is not a confirmed roadworthy direct purchase.`);
    }
    if (!(Number(vehicle.price) > Number(vehicle.landedCost)) || !(Number(vehicle.expectedGrossProfit) > 0)) {
      throw new Error(`Safety stop: OLX fallback ${vehicle.stock} has no positive protected margin.`);
    }
    if (!vehicle.handle || !vehicle.title || !vehicle.plainDescription || !Array.isArray(vehicle.images) || !vehicle.images.length) {
      throw new Error(`Safety stop: OLX fallback ${vehicle.stock} has incomplete listing data.`);
    }
    if (vehicle.plainDescription.includes('???')) {
      throw new Error(`Safety stop: OLX fallback ${vehicle.stock} contains invalid UTF-8 placeholders.`);
    }
    newStocks.add(vehicle.stock);
  }
  for (const vehicle of manifest.inactiveVehicles) {
    if (!/^[A-Z]{2}\d{5}$/.test(vehicle.stock) || oldStocks.has(vehicle.stock)) {
      throw new Error(`Invalid or duplicate inactive stock: ${vehicle.stock}`);
    }
    oldStocks.add(vehicle.stock);
  }
  const overlap = [...newStocks].filter((stock) => oldStocks.has(stock));
  if (overlap.length) throw new Error(`Safety stop: replacement stock overlaps inactive stock: ${overlap.slice(0, 10).join(', ')}`);
  return {
    ...manifest,
    vehicles: LIMIT ? manifest.vehicles.slice(OFFSET, OFFSET + LIMIT) : manifest.vehicles.slice(OFFSET),
    olxFallbackVehicles,
  };
}

function baseReport(manifest) {
  return {
    generatedAt: new Date().toISOString(),
    mode: MODE,
    channel: CHANNEL,
    offset: OFFSET,
    limit: LIMIT,
    manifest: {
      totalReplacements: manifest.vehicles.length,
      selectedReplacements: LIMIT ? Math.min(LIMIT, Math.max(0, manifest.vehicles.length - OFFSET)) : Math.max(0, manifest.vehicles.length - OFFSET),
      olxFallbackVehicles: manifest.olxFallbackVehicles?.length || 0,
      inactiveVehicles: manifest.inactiveVehicles.length,
    },
    shopify: {
      productsRead: 0, inactiveMatched: 0, drafted: 0, inventoryZeroed: 0, inventoryZeroSkippedNoScope: 0,
      replacementsMatched: 0, created: 0, updated: 0, pagesCreated: 0, pagesUpdated: 0,
      pagesSkippedNoScope: 0,
      failures: [], results: [],
    },
    facebook: {
      postsRead: 0, inactiveMatched: 0, removed: 0, replacementsMatched: 0,
      created: 0, updated: 0, existingSkipped: 0, deferred: 0,
      rateLimited: false, rateLimitError: '', readSource: 'facebook-feed',
      configuredPageId: '', tokenPageId: '', tokenPageName: '', pageIdentityMatches: false,
      tokenDerivedFromManagedPages: false,
      failures: [], results: [],
    },
    olx: {
      advertsRead: 0, inactiveMatched: 0, deactivated: 0, deleted: 0,
      replacementsMatched: 0, created: 0, updated: 0, publiclyVerified: 0, existingSkipped: 0,
      skippedUnresolved: 0, deferred: 0, limited: 0,
      tokenRefreshed: false,
      unresolvedAttributes: [], deferredItems: [], failures: [], results: [],
    },
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
    method: 'POST', headers: { Accept: 'application/json' }, body,
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
      const waitMs = Math.min(30000, Math.max(1000, Math.ceil(((requested - available) / restoreRate) * 1000) + 500));
      await sleep(waitMs);
      continue;
    }
    if (errors.length) throw new Error(`Shopify GraphQL error: ${JSON.stringify(errors)}`);
    return json.data;
  }
  throw new Error('Shopify GraphQL remained throttled after 12 attempts.');
}

async function shopifyRest(path, options = {}) {
  const shop = required('SHOPIFY_SHOP_DOMAIN').replace(/^https?:\/\//, '').replace(/\/$/, '');
  return request(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': await getShopifyToken(),
      ...(options.headers || {}),
    },
  });
}

async function listShopifyProducts() {
  const products = [];
  let cursor = null;
  do {
    const data = await shopifyGraphql(`query ReplacementProducts($cursor: String) {
      products(first: 250, after: $cursor) {
        nodes {
          id title handle descriptionHtml status
          variants(first: 1) {
            nodes {
              id price sku
            }
          }
          incoming: metafield(namespace: "custom", key: "incoming_number") { value }
          facebookPost: metafield(namespace: "custom", key: "facebook_post_id") { value }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`, { cursor });
    products.push(...data.products.nodes);
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);
  return products;
}

function productStock(product) {
  return stockFrom(product.incoming?.value)
    || stockFrom(product.variants?.nodes?.[0]?.sku)
    || stockFrom(product.handle)
    || stockFrom(product.title)
    || stockFrom(product.descriptionHtml);
}

async function setProductDraftAndZero(product, report) {
  if (MODE === 'apply' && product.status !== 'DRAFT') {
    const data = await shopifyGraphql(`mutation DraftReplacementProduct($product: ProductUpdateInput!) {
      productUpdate(product: $product) { userErrors { field message } }
    }`, { product: { id: product.id, status: 'DRAFT' } });
    if (data.productUpdate.userErrors.length) throw new Error(JSON.stringify(data.productUpdate.userErrors));
    report.shopify.drafted += 1;
  } else if (product.status !== 'DRAFT') report.shopify.drafted += 1;
  // The installed custom app intentionally has no inventory scopes. Draft status
  // removes the sold product from every storefront without querying restricted
  // inventory levels. Record the skipped quantity update explicitly in the report.
  report.shopify.inventoryZeroSkippedNoScope += 1;
}

async function publicationId() {
  const data = await shopifyGraphql(`query ReplacementPublications {
    publications(first: 50) { nodes { id name } }
  }`);
  return data.publications.nodes.find((node) => /online store/i.test(node.name))?.id || '';
}

async function publishProduct(productId, onlinePublicationId) {
  if (!onlinePublicationId || MODE !== 'apply') return;
  const data = await shopifyGraphql(`mutation PublishReplacementProduct($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) { userErrors { field message } }
  }`, { id: productId, input: [{ publicationId: onlinePublicationId }] });
  const errors = data.publishablePublish.userErrors.filter((item) => !/already published/i.test(item.message));
  if (errors.length) throw new Error(JSON.stringify(errors));
}

async function setProductPrice(productId, variantId, price) {
  const data = await shopifyGraphql(`mutation PriceReplacementProduct($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } }
  }`, { productId, variants: [{ id: variantId, price: Number(price).toFixed(2) }] });
  if (data.productVariantsBulkUpdate.userErrors.length) throw new Error(JSON.stringify(data.productVariantsBulkUpdate.userErrors));
}

async function createReplacementProduct(vehicle, onlinePublicationId) {
  if (MODE !== 'apply') {
    return { id: `dry-run:${vehicle.stock}`, handle: vehicle.handle, variantId: '', hostedImages: [] };
  }
  const media = vehicle.images.map((image, index) => ({
    originalSource: image.url,
    mediaContentType: 'IMAGE',
    alt: image.alt || `${vehicle.title} – снимка ${index + 1}`,
  }));
  const data = await shopifyGraphql(`mutation CreateReplacementProduct($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
    productCreate(product: $product, media: $media) {
      product { id handle variants(first: 1) { nodes { id } } }
      userErrors { field message }
    }
  }`, {
    product: {
      title: vehicle.title,
      handle: vehicle.handle,
      descriptionHtml: vehicle.bodyHtml,
      vendor: 'Avtomol.com',
      productType: 'Автомобил',
      status: 'ACTIVE',
      tags: [],
      seo: {
        title: vehicle.seo.productTitle || vehicle.title,
        description: vehicle.seo.productDescription || vehicle.plainDescription.slice(0, 300),
      },
      metafields: [
        { namespace: 'custom', key: 'incoming_number', type: 'single_line_text_field', value: vehicle.stock },
      ],
    },
    media,
  });
  if (data.productCreate.userErrors.length) throw new Error(JSON.stringify(data.productCreate.userErrors));
  const product = data.productCreate.product;
  const variantId = product.variants.nodes[0]?.id;
  await setProductPrice(product.id, variantId, vehicle.price);
  await publishProduct(product.id, onlinePublicationId);
  return { id: product.id, handle: product.handle, variantId, hostedImages: [] };
}

async function updateReplacementProduct(product, vehicle, onlinePublicationId) {
  if (MODE === 'apply') {
    const data = await shopifyGraphql(`mutation UpdateReplacementProduct($product: ProductUpdateInput!) {
      productUpdate(product: $product) { userErrors { field message } }
    }`, {
      product: {
        id: product.id,
        title: vehicle.title,
        handle: vehicle.handle,
        descriptionHtml: vehicle.bodyHtml,
        vendor: 'Avtomol.com',
        productType: 'Автомобил',
        status: 'ACTIVE',
        tags: [],
        seo: {
          title: vehicle.seo.productTitle || vehicle.title,
          description: vehicle.seo.productDescription || vehicle.plainDescription.slice(0, 300),
        },
      },
    });
    if (data.productUpdate.userErrors.length) throw new Error(JSON.stringify(data.productUpdate.userErrors));
    const variantId = product.variants?.nodes?.[0]?.id;
    if (variantId) await setProductPrice(product.id, variantId, vehicle.price);
    await publishProduct(product.id, onlinePublicationId);
  }
  return {
    id: product.id,
    handle: vehicle.handle,
    variantId: product.variants?.nodes?.[0]?.id || '',
    hostedImages: (product.media?.nodes || []).map((item) => item.preview?.image?.url).filter(Boolean),
  };
}

async function hostedProductImages(productId, expected) {
  if (MODE !== 'apply' || String(productId).startsWith('dry-run:')) return [];
  let images = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const data = await shopifyGraphql(`query ReplacementMedia($id: ID!) {
      product(id: $id) { media(first: 250) { nodes { status preview { image { url } } } } }
    }`, { id: productId });
    images = data.product?.media?.nodes?.map((item) => item.preview?.image?.url).filter(Boolean) || [];
    if (images.length >= Math.min(expected, 1)) break;
    await sleep(5000);
  }
  return images;
}

async function listPages() {
  const pages = [];
  let sinceId = 0;
  for (let loop = 0; loop < 100; loop += 1) {
    const suffix = sinceId ? `&since_id=${sinceId}` : '';
    const { json } = await shopifyRest(`pages.json?limit=250${suffix}`);
    const batch = json?.pages || [];
    pages.push(...batch);
    if (batch.length < 250) break;
    sinceId = Math.max(...batch.map((page) => Number(page.id)));
  }
  return pages;
}

function hostedPageBody(vehicle, hostedImages) {
  let cursor = 0;
  let body = vehicle.seo.pageBodyHtml.replace(/https:\/\/[^"'<> ]+/gi, (url) => {
    if (!/img|image|photo|\.jpe?g|\.png|\.webp/i.test(url)) return url;
    const replacement = hostedImages[cursor] || hostedImages[0] || '';
    cursor += 1;
    return replacement;
  });
  if (!hostedImages.length) body = body.replace(/<img\b[^>]*>/gi, '');
  if (/auto1/i.test(body)) throw new Error(`Public page for ${vehicle.stock} still contains a source name.`);
  return body;
}

async function upsertPage(existing, vehicle, hostedImages) {
  const page = {
    title: vehicle.seo.pageTitle,
    handle: vehicle.seo.pageHandle,
    body_html: hostedPageBody(vehicle, hostedImages),
    published: true,
    metafields: [],
  };
  if (MODE !== 'apply') return existing ? 'updated' : 'created';
  if (existing) {
    await shopifyRest(`pages/${existing.id}.json`, { method: 'PUT', body: JSON.stringify({ page: { id: existing.id, ...page } }) });
    return 'updated';
  }
  await shopifyRest('pages.json', { method: 'POST', body: JSON.stringify({ page }) });
  return 'created';
}

async function synchronizeShopify(manifest, report) {
  const products = await listShopifyProducts();
  report.shopify.productsRead = products.length;
  const byStock = new Map();
  const byHandle = new Map();
  for (const product of products) {
    const stock = productStock(product);
    if (stock) {
      if (!byStock.has(stock)) byStock.set(stock, []);
      byStock.get(stock).push(product);
    }
    if (product.handle) byHandle.set(product.handle, product);
  }

  if (OFFSET === 0) {
    for (const inactive of manifest.inactiveVehicles) {
      const matches = byStock.get(inactive.stock) || [];
      report.shopify.inactiveMatched += matches.length;
      for (const product of matches) {
        try {
          await setProductDraftAndZero(product, report);
          report.shopify.results.push({ stock: inactive.stock, handle: product.handle, action: 'draft-inventory-zero' });
        } catch (error) {
          report.shopify.failures.push({ stock: inactive.stock, handle: product.handle, action: 'deactivate', error: error.message });
        }
      }
    }
  }

  let pages = [];
  let canManagePages = true;
  try {
    pages = await listPages();
  } catch (error) {
    if (error.status === 403 && /read_content|write_content|merchant approval/i.test(error.message)) {
      canManagePages = false;
    } else {
      throw error;
    }
  }
  const pagesByHandle = new Map(pages.map((page) => [page.handle, page]));
  const onlinePublicationId = await publicationId();
  for (const vehicle of manifest.vehicles) {
    try {
      const matches = byStock.get(vehicle.stock) || [];
      const existing = matches[0] || byHandle.get(vehicle.handle);
      let product;
      if (existing) {
        report.shopify.replacementsMatched += 1;
        product = await updateReplacementProduct(existing, vehicle, onlinePublicationId);
        report.shopify.updated += 1;
      } else {
        product = await createReplacementProduct(vehicle, onlinePublicationId);
        report.shopify.created += 1;
      }
      let hostedImages = [];
      let pageAction = 'skipped-no-content-scope';
      if (canManagePages) {
        hostedImages = product.hostedImages.length
          ? product.hostedImages
          : await hostedProductImages(product.id, vehicle.images.length);
        pageAction = await upsertPage(pagesByHandle.get(vehicle.seo.pageHandle), vehicle, hostedImages);
        if (pageAction === 'created') report.shopify.pagesCreated += 1;
        else report.shopify.pagesUpdated += 1;
      } else {
        report.shopify.pagesSkippedNoScope += 1;
      }
      report.shopify.results.push({
        stock: vehicle.stock,
        handle: vehicle.handle,
        action: existing ? 'update-replacement' : 'create-replacement',
        price: vehicle.price,
        hostedImages: hostedImages.length,
        pageAction,
      });
    } catch (error) {
      report.shopify.failures.push({ stock: vehicle.stock, action: 'replace', error: error.message });
    }
  }
}

let facebookToken = '';
function facebookUrl(path, token = facebookToken || required('FACEBOOK_PAGE_ACCESS_TOKEN')) {
  const url = new URL(`https://graph.facebook.com/${FACEBOOK_API_VERSION}/${path}`);
  url.searchParams.set('access_token', token);
  return url;
}

async function facebookIdentity() {
  const sourceToken = required('FACEBOOK_PAGE_ACCESS_TOKEN');
  const { json } = await request(facebookUrl('me?fields=id,name', sourceToken).toString());
  if (!json?.id || !json?.name) {
    throw new Error('Facebook token did not return an identity.');
  }
  if (/avtomol(?:\.com)?/i.test(String(json.name).replace(/\s+/g, ''))) {
    facebookToken = sourceToken;
    return { id: String(json.id), name: String(json.name), derivedFromManagedPages: false };
  }
  const { json: accounts } = await request(facebookUrl(
    'me/accounts?fields=id,name,access_token&limit=100',
    sourceToken,
  ).toString());
  const page = (accounts?.data || []).find((item) => (
    item?.id
    && item?.access_token
    && /avtomol(?:\.com)?/i.test(String(item.name || '').replace(/\s+/g, ''))
  ));
  if (!page) {
    throw new Error(`Safety stop: Facebook token belongs to "${json.name}" and does not expose the managed Page Avtomol.com.`);
  }
  facebookToken = String(page.access_token);
  console.log(`::add-mask::${facebookToken}`);
  return {
    id: String(page.id),
    name: String(page.name),
    derivedFromManagedPages: true,
  };
}

async function facebookPosts(pageId) {
  const endpoints = ['published_posts', 'posts', 'feed'];
  const diagnostics = [];
  let emptyResult = null;
  let lastError = null;
  for (const endpoint of endpoints) {
    const posts = [];
    let next = facebookUrl(`${pageId}/${endpoint}?fields=id,message,created_time&limit=100`).toString();
    try {
      for (let page = 0; next && page < 100; page += 1) {
        const { json } = await request(next);
        posts.push(...(json.data || []));
        next = json.paging?.next || '';
      }
      diagnostics.push({ endpoint, ok: true, posts: posts.length });
      if (posts.length) {
        return { posts, source: `facebook-${endpoint}`, diagnostics };
      }
      if (!emptyResult) emptyResult = { posts, source: `facebook-${endpoint}`, diagnostics };
    } catch (error) {
      lastError = error;
      diagnostics.push({ endpoint, ok: false, error: error.message });
    }
  }
  if (emptyResult) return { ...emptyResult, diagnostics };
  if (lastError) {
    lastError.facebookReadDiagnostics = diagnostics;
    throw lastError;
  }
  return { posts: [], source: 'facebook-published_posts', diagnostics };
}

function facebookMessage(vehicle) {
  return [
    `🚗 ${vehicle.title}`,
    `💶 КРАЙНА ЦЕНА: ${Number(vehicle.price).toFixed(2)} EUR`,
    `🔴 ВХОДЯЩ НОМЕР: ${vehicle.stock}`,
    '',
    vehicle.plainDescription.slice(0, 7000),
    '',
    `Разгледайте автомобила: https://avtomol.com/products/${vehicle.handle}`,
  ].join('\n').slice(0, 9000);
}

async function deleteFacebookPost(postId) {
  if (MODE !== 'apply') return;
  await request(`https://graph.facebook.com/${FACEBOOK_API_VERSION}/${postId}`, {
    method: 'DELETE',
    body: new URLSearchParams({ access_token: facebookToken || required('FACEBOOK_PAGE_ACCESS_TOKEN') }),
  });
}

async function publishFacebookVehicle(vehicle, pageId) {
  if (MODE !== 'apply') return { id: `dry-run:${vehicle.stock}` };
  const body = new URLSearchParams({
    url: vehicle.images[0].url,
    caption: facebookMessage(vehicle),
    published: 'true',
    access_token: facebookToken || required('FACEBOOK_PAGE_ACCESS_TOKEN'),
  });
  const { json } = await request(`https://graph.facebook.com/${FACEBOOK_API_VERSION}/${pageId}/photos`, { method: 'POST', body });
  return json;
}

async function updateFacebookVehicle(postId, vehicle) {
  if (MODE !== 'apply') return;
  await request(`https://graph.facebook.com/${FACEBOOK_API_VERSION}/${postId}`, {
    method: 'POST',
    body: new URLSearchParams({
      message: facebookMessage(vehicle),
      access_token: facebookToken || required('FACEBOOK_PAGE_ACCESS_TOKEN'),
    }),
  });
}

function isFacebookRateLimitError(error) {
  return Number(error?.body?.error?.code) === 368
    || Number(error?.body?.error?.error_subcode) === 1390008;
}

async function saveFacebookPostId(productId, postId) {
  if (!productId || !postId || MODE !== 'apply') return;
  const data = await shopifyGraphql(`mutation SaveReplacementFacebookPost($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { userErrors { field message } }
  }`, {
    metafields: [{
      ownerId: productId,
      namespace: 'custom',
      key: 'facebook_post_id',
      type: 'single_line_text_field',
      value: String(postId),
    }],
  });
  if (data.metafieldsSet.userErrors.length) {
    throw new Error(`Shopify Facebook post metafield rejected: ${JSON.stringify(data.metafieldsSet.userErrors)}`);
  }
}

async function synchronizeFacebook(manifest, report) {
  const configuredPageId = required('FACEBOOK_PAGE_ID');
  const tokenPage = await facebookIdentity();
  report.facebook.configuredPageId = configuredPageId;
  report.facebook.tokenPageId = tokenPage.id;
  report.facebook.tokenPageName = tokenPage.name;
  report.facebook.pageIdentityMatches = tokenPage.id === configuredPageId;
  report.facebook.tokenDerivedFromManagedPages = tokenPage.derivedFromManagedPages;
  const pageId = tokenPage.id;
  let posts = [];
  let shopifyProducts = [];
  try {
    const facebookRead = await facebookPosts(pageId);
    posts = facebookRead.posts;
    report.facebook.readSource = facebookRead.source;
    report.facebook.readDiagnostics = facebookRead.diagnostics;
  } catch (error) {
    report.facebook.readDiagnostics = error.facebookReadDiagnostics || [{ error: error.message }];
    const missingReadPermission = error.status === 400
      && /pages_read_engagement|Page Public Content Access/i.test(error.message);
    if (!missingReadPermission) throw error;
    report.facebook.readSource = 'shopify-facebook-post-metafields';
    shopifyProducts = await listShopifyProducts();
    const seen = new Set();
    for (const product of shopifyProducts) {
      const postId = clean(product.facebookPost?.value);
      const stock = productStock(product);
      if (!postId || !stock || seen.has(postId)) continue;
      seen.add(postId);
      posts.push({ id: postId, message: `ВХОДЯЩ НОМЕР: ${stock}` });
    }
  }
  report.facebook.postsRead = posts.length;
  const postsByStock = new Map();
  for (const post of posts) {
    const stock = stockFrom(post.message);
    if (!stock) continue;
    if (!postsByStock.has(stock)) postsByStock.set(stock, []);
    postsByStock.get(stock).push(post);
  }
  const shopifyByStock = new Map();
  for (const product of shopifyProducts) {
    const stock = productStock(product);
    if (stock && !shopifyByStock.has(stock)) shopifyByStock.set(stock, product);
  }
  if (OFFSET === 0) {
    for (const inactive of manifest.inactiveVehicles) {
      const matches = postsByStock.get(inactive.stock) || [];
      report.facebook.inactiveMatched += matches.length;
      for (const post of matches) {
        try {
          await deleteFacebookPost(post.id);
          report.facebook.removed += 1;
          report.facebook.results.push({ stock: inactive.stock, postId: post.id, action: 'remove-inactive' });
        } catch (error) {
          report.facebook.failures.push({ stock: inactive.stock, postId: post.id, action: 'remove-inactive', error: error.message });
        }
      }
    }
  }
  let createdThisRun = 0;
  for (let index = 0; index < manifest.vehicles.length; index += 1) {
    const vehicle = manifest.vehicles[index];
    const matches = postsByStock.get(vehicle.stock) || [];
    try {
      if (matches.length) {
        report.facebook.replacementsMatched += 1;
        if (FACEBOOK_UPDATE_EXISTING) {
          await updateFacebookVehicle(matches[0].id, vehicle);
          report.facebook.updated += 1;
        } else {
          report.facebook.existingSkipped += 1;
        }
        for (const duplicate of matches.slice(1)) await deleteFacebookPost(duplicate.id);
        report.facebook.results.push({
          stock: vehicle.stock,
          postId: matches[0].id,
          action: FACEBOOK_UPDATE_EXISTING ? 'update-replacement' : 'retain-existing',
        });
      } else {
        if (FACEBOOK_CREATE_LIMIT && createdThisRun >= FACEBOOK_CREATE_LIMIT) {
          report.facebook.deferred += 1;
          continue;
        }
        const result = await publishFacebookVehicle(vehicle, pageId);
        await saveFacebookPostId(shopifyByStock.get(vehicle.stock)?.id, result.post_id || result.id);
        report.facebook.created += 1;
        createdThisRun += 1;
        report.facebook.results.push({ stock: vehicle.stock, postId: result.post_id || result.id, action: 'create-replacement' });
        if (createdThisRun % 10 === 0) {
          console.log(`Facebook replacement progress: ${createdThisRun} created in this run.`);
        }
      }
    } catch (error) {
      if (isFacebookRateLimitError(error)) {
        report.facebook.rateLimited = true;
        report.facebook.rateLimitError = 'Meta publishing cooldown (OAuth code 368, subcode 1390008).';
        report.facebook.deferred += 1;
        for (const remaining of manifest.vehicles.slice(index + 1)) {
          if (!(postsByStock.get(remaining.stock) || []).length) report.facebook.deferred += 1;
        }
        console.warn(`::warning title=Facebook publishing cooldown::${report.facebook.deferred} missing replacement(s) deferred to the next scheduled batch.`);
        break;
      }
      report.facebook.failures.push({ stock: vehicle.stock, action: 'replace', error: error.message });
    }
  }
}

let olxToken = '';
let olxTokenRefreshed = false;
async function testOlxToken(token) {
  try {
    await request('https://www.olx.bg/api/partner/adverts?limit=1', {
      headers: { Authorization: `Bearer ${token}`, Version: '2.0', Accept: 'application/json' },
    }, 1);
    return true;
  } catch (error) {
    if (error.status === 401 || error.status === 403) return false;
    throw error;
  }
}

async function getOlxToken() {
  if (olxToken) return olxToken;
  const current = process.env.OLX_ACCESS_TOKEN || '';
  if (current && await testOlxToken(current)) {
    olxToken = current;
    return olxToken;
  }
  if (MODE === 'dry-run' && !ALLOW_OLX_REFRESH) {
    throw new Error('OLX access token is expired or invalid. Dry-run deliberately did not rotate the refresh token; update OLX_ACCESS_TOKEN before applying changes.');
  }
  const { json } = await request('https://www.olx.bg/api/open/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: required('OLX_CLIENT_ID'),
      client_secret: required('OLX_CLIENT_SECRET'),
      refresh_token: required('OLX_REFRESH_TOKEN'),
      scope: 'v2 read write',
    }),
  });
  if (!json?.access_token) throw new Error('OLX refresh did not return an access token.');
  if (!json?.refresh_token) throw new Error('OLX refresh did not return a replacement refresh token.');
  console.log(`::add-mask::${json.access_token}`);
  console.log(`::add-mask::${json.refresh_token}`);
  if (OLX_TOKEN_HANDOFF_PATH) {
    await fs.writeFile(OLX_TOKEN_HANDOFF_PATH, `${JSON.stringify({
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_in: json.expires_in,
      token_type: json.token_type,
      scope: json.scope,
      generated_at: new Date().toISOString(),
    })}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  olxTokenRefreshed = true;
  olxToken = json.access_token;
  return olxToken;
}

async function olxRequest(path, options = {}) {
  return request(`https://www.olx.bg/api/partner/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${await getOlxToken()}`,
      Version: '2.0',
      Accept: 'application/json',
      'User-Agent': 'Avtomol-OlxSync/1.0 (+https://avtomol.com)',
      ...(options.headers || {}),
    },
  });
}

async function listOlxAdverts() {
  const adverts = [];
  for (let offset = 0; offset < 10000; offset += 100) {
    const { json } = await olxRequest(`adverts?limit=100&offset=${offset}`);
    const batch = json?.data || [];
    adverts.push(...batch);
    if (batch.length < 100) break;
  }
  return adverts;
}

async function readOlxAdvert(id) {
  const { json } = await olxRequest(`adverts/${id}`);
  return json?.data || json;
}

async function deactivateAndDeleteOlx(advert) {
  const status = clean(advert.status).toLowerCase();
  if (MODE !== 'apply') return { deactivated: status === 'active', deleted: true };
  let deactivated = false;
  if (status === 'active') {
    await olxRequest(`adverts/${advert.id}/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'deactivate', is_success: true }),
    });
    deactivated = true;
  }
  try {
    await olxRequest(`adverts/${advert.id}`, { method: 'DELETE' });
    return { deactivated, deleted: true, alreadyInactive: false };
  } catch (error) {
    const invalidAdvertState = error.status === 400
      && /"field":"ad"/i.test(JSON.stringify(error.body || {}))
      && /invalid request|invalid state|невалидн/i.test(`${error.message} ${JSON.stringify(error.body || {})}`);
    if (invalidAdvertState) {
      return { deactivated, deleted: false, alreadyInactive: true };
    }
    throw error;
  }
}

async function categoryAttributes(categoryId) {
  const { json } = await olxRequest(`categories/${categoryId}/attributes`);
  return json?.data || json || [];
}

function allValues(definition) {
  const values = definition?.validation?.values || definition?.values || definition?.options || [];
  const flattened = [];
  const visit = (value, parent = '') => {
    if (!value || typeof value !== 'object') return;
    const code = value.code ?? value.value ?? value.id;
    const label = value.label ?? value.name ?? value.value ?? '';
    if (code !== undefined) flattened.push({ code: String(code), label: String(label), parent });
    for (const child of value.values || value.children || []) visit(child, String(code ?? parent));
  };
  for (const value of values) visit(value);
  return flattened;
}

function attributeKind(definition) {
  const code = normalized(definition.code);
  const label = normalized(definition.label || definition.name);
  const text = `${code} ${label}`;
  if (code === 'auto make year' || code === 'year') return 'year';
  if (code === 'model') return 'model';
  if (code === 'state') return 'condition';
  if (/\b(model|model)\b/.test(text)) return 'model';
  if (/\b(brand|make|marka|марка)\b/u.test(text)) return 'brand';
  if (/\b(year|make year|godina|година)\b/u.test(text)) return 'year';
  if (/\b(mileage|kilomet|пробег)\b/u.test(text)) return 'mileage';
  if (/\b(engine type|fuel|gorivo|гориво)\b/u.test(text)) return 'fuel';
  if (/\b(transmission|gear|скорост)\b/u.test(text)) return 'transmission';
  if (/\b(coupe|body|kupa|купе)\b/u.test(text)) return 'body';
  if (/\b(condition|sustoyanie|състояние)\b/u.test(text)) return 'condition';
  if (/\b(power|horse|мощност)\b/u.test(text)) return 'power';
  return '';
}

function candidateLabels(kind, vehicle) {
  if (kind === 'brand') return [vehicle.brand];
  if (kind === 'model') {
    const words = clean(vehicle.model).split(/\s+/).filter(Boolean);
    const first = words[0] || '';
    const aliases = [];
    const series = first.match(/^(\d)er$/i);
    if (series) aliases.push(`${series[1]} series`, `series ${series[1]}`);
    if (/^ds\d$/i.test(first)) aliases.push(first.replace(/^ds/i, 'DS '));
    return [vehicle.model, words.slice(0, 3).join(' '), first, ...aliases];
  }
  if (kind === 'fuel') {
    const map = {
      diesel: ['diesel', 'дизел'],
      petrol: ['petrol', 'gasoline', 'бензин'],
      gasoline: ['petrol', 'gasoline', 'бензин'],
      lpg: ['lpg', 'gas', 'газ', 'бензин газ'],
      'liquified petroleum gas': ['lpg', 'gas', 'газ', 'бензин газ'],
      'liquefied petroleum gas': ['lpg', 'gas', 'газ', 'бензин газ'],
      electric: ['electric', 'electricity', 'ev', 'електрически'],
      hybrid: ['hybrid', 'хибрид'],
    };
    return map[normalized(vehicle.fuel)] || [vehicle.fuel];
  }
  if (kind === 'transmission') {
    return normalized(vehicle.transmission).includes('auto')
      ? ['automatic', 'автоматична']
      : ['manual', 'ръчна'];
  }
  if (kind === 'body') {
    const map = {
      van: ['van', 'minivan', 'миниван', 'ван'],
      'panel van': ['van', 'panel van', 'cargo van', 'миниван', 'ван'],
      'panel van high': ['van', 'panel van', 'cargo van', 'миниван', 'ван'],
      bus: ['bus', 'minibus', 'van', 'автобус', 'микробус', 'ван'],
      'chassis cab': ['chassis cab', 'truck', 'van', 'шаси кабина', 'камион', 'ван'],
      limousine: ['sedan', 'лимузина', 'седан'],
      sedan: ['sedan', 'лимузина', 'седан'],
      estate: ['estate', 'station wagon', 'wagon', 'combi', 'комби'],
      'station wagon': ['estate', 'station wagon', 'wagon', 'combi', 'комби'],
      suv: ['suv', 'jeep', 'джип'],
      hatchback: ['hatchback', 'хечбек'],
      coupe: ['coupe', 'купе'],
      convertible: ['convertible', 'cabrio', 'кабрио'],
    };
    return map[normalized(vehicle.bodyType)] || [vehicle.bodyType];
  }
  if (kind === 'condition') return ['used', 'употребяван', 'втора употреба'];
  return [];
}

function resolveEnum(definition, kind, vehicle) {
  const values = allValues(definition);
  const candidates = candidateLabels(kind, vehicle).map(normalized).filter(Boolean);
  const looseCandidates = candidates.map(normalizedLoose);
  if (!candidates.length) return '';
  const exact = values.find((value) => candidates.includes(normalized(value.label)) || candidates.includes(normalized(value.code)));
  if (exact) return exact.code;
  const looseExact = values.find((value) => {
    const label = normalizedLoose(value.label);
    const code = normalizedLoose(value.code);
    return looseCandidates.includes(label) || looseCandidates.includes(code);
  });
  if (looseExact) return looseExact.code;
  const contains = values.find((value) => {
    const label = normalized(value.label);
    return candidates.some((candidate) => label.includes(candidate) || candidate.includes(label));
  });
  if (contains) return contains.code;
  if (kind === 'model' || kind === 'body') {
    const generic = values.find((value) => {
      const text = normalized(`${value.code} ${value.label}`);
      return /\b(other|others|other model|all models|друг|друга|друго|други|останал|останалите|всички модели)\b/u.test(text);
    });
    if (generic) return generic.code;
  }
  return '';
}

function makeAttributes(definitions, vehicle, template) {
  const templateMap = new Map((template.attributes || []).map((item) => [item.code, item]));
  const attributes = [];
  const unresolved = [];
  for (const definition of definitions) {
    const code = definition.code;
    const kind = attributeKind(definition);
    const requiredAttribute = definition?.validation?.required === true
      || definition.required === true
      || definition.is_required === true;
    const allowMultipleValues = definition?.validation?.allow_multiple_values === true
      || definition.allow_multiple_values === true;
    let value = '';
    if (kind === 'year') value = String(vehicle.year || '');
    else if (kind === 'mileage') value = String(vehicle.mileage || '');
    else if (kind === 'power') value = String(vehicle.horsepower || vehicle.powerKw || '');
    else if (kind) value = resolveEnum(definition, kind, vehicle);
    else if (normalized(code) === 'type') {
      // This optional value is model-dependent in OLX. Reusing it from
      // another advert causes params.type validation failures.
      value = '';
    }
    else if (templateMap.has(code)) {
      const templateValue = templateMap.get(code);
      if (Array.isArray(templateValue.values) && templateValue.values.length) {
        const allowed = allValues(definition);
        const valid = !allowed.length
          || templateValue.values.every((item) => allowed.some((option) => option.code === clean(item)));
        if (valid) {
          attributes.push({ code, values: templateValue.values });
          continue;
        }
      }
      value = clean(templateValue.value);
      const allowed = allValues(definition);
      if (allowed.length && !allowed.some((option) => option.code === value)) value = '';
    }
    if (value) {
      if (allowMultipleValues) attributes.push({ code, values: [value] });
      else attributes.push({ code, value });
    }
    else if (requiredAttribute) {
      unresolved.push({
        code,
        label: definition.label || definition.name || '',
        kind,
        candidates: candidateLabels(kind, vehicle),
        availableValues: allValues(definition).slice(0, 250),
      });
    }
  }
  return { attributes, unresolved };
}

function olxPayload(vehicle, template, definitions) {
  const resolved = makeAttributes(definitions, vehicle, template);
  const payload = {
    title: vehicle.title.slice(0, 70),
    description: vehicle.plainDescription.slice(0, 9000),
    category_id: template.category_id,
    advertiser_type: template.advertiser_type || 'business',
    external_id: vehicle.handle,
    contact: template.contact,
    location: template.location,
    images: vehicle.images.slice(0, 12).map((image) => ({ url: image.url })),
    price: {
      value: Number(vehicle.price),
      currency: 'EUR',
      negotiable: false,
      trade: false,
      budget: false,
    },
    attributes: resolved.attributes,
    courier: false,
    auto_extend_enabled: true,
  };
  assertPublicOlxPayload(payload, vehicle);
  return { payload, unresolved: resolved.unresolved };
}

function assertPublicOlxPayload(payload, vehicle) {
  const publicText = `${payload.title || ''}\n${payload.description || ''}`;
  const forbidden = [
    /AUTO1/i, /VAT\s*deductible/i, /възстановяемо\s+ДДС/i,
    /нетна\s+цена/i, /покупна\s+цена/i, /размер\s+на\s+ДДС/i,
    /себестойност/i, /очаквана\s+печалба/i, /service\s*fee/i,
  ];
  const match = forbidden.find((pattern) => pattern.test(publicText));
  if (match) throw new Error(`Blocked internal data in public OLX payload: ${match}`);
  if (!Array.isArray(payload.images) || payload.images.length < 5) {
    throw new Error(`Blocked OLX payload for ${vehicle.stock}: fewer than 5 verified images.`);
  }
  if (!Number.isFinite(payload.price?.value) || payload.price.value <= 0) {
    throw new Error(`Blocked OLX payload for ${vehicle.stock}: missing public sale price.`);
  }
}

async function createOlxVehicle(payload) {
  if (MODE !== 'apply') return { data: { id: 'dry-run', status: 'new' } };
  const { json } = await olxRequest('adverts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return json;
}

async function updateOlxVehicle(advert, payload) {
  if (MODE !== 'apply') return;
  await olxRequest(`adverts/${advert.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function retainOlxForVerifiedReplacement(advert) {
  return { deactivated: false, deleted: false, retainedForReplacement: true,
    status: clean(advert.status).toLowerCase() };
}

async function ensureOlxAdvertIsPublic(advertId, expectedVehicle) {
  if (MODE !== 'apply') return { status: 'dry-run', publiclyVerified: false };
  const advert = await readOlxAdvert(advertId);
  if (advert.status !== 'active') throw new Error(`OLX advert ${advertId} is not active; activation is forbidden.`);
  const publicUrl = advert.url || advert.external_url || advert?.links?.public;
  if (!publicUrl) throw new Error(`OLX advert ${advertId} has no public URL for verification.`);
  const response = await fetch(publicUrl, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Public OLX verification failed for ${advertId}: HTTP ${response.status}.`);
  const html = normalized(await response.text());
  const expected = [expectedVehicle.brand, expectedVehicle.model, expectedVehicle.stock].filter(Boolean);
  if (!expected.slice(0, 2).every((part) => html.includes(normalized(part)))) {
    throw new Error(`Public OLX advert ${advertId} does not confirm the replacement vehicle.`);
  }
  return { status: advert.status, publiclyVerified: true, publicUrl };
}

async function synchronizeOlx(manifest, report) {
  const adverts = await listOlxAdverts();
  report.olx.tokenRefreshed = olxTokenRefreshed;
  report.olx.advertsRead = adverts.length;
  const advertById = new Map(adverts.map((advert) => [Number(advert.id), advert]));
  const advertByExternal = new Map(adverts.map((advert) => [clean(advert.external_id).toLowerCase(), advert]));

  if (OFFSET === 0) {
    for (const inactive of manifest.inactiveVehicles) {
      const ids = inactive.olxAdvertIds || [];
      for (const id of ids) {
        const summary = advertById.get(Number(id));
        if (!summary) continue;
        report.olx.inactiveMatched += 1;
        try {
          const advert = await readOlxAdvert(id);
          const result = await retainOlxForVerifiedReplacement(advert);
          if (result.deactivated) report.olx.deactivated += 1;
          if (result.deleted) report.olx.deleted += 1;
          report.olx.results.push({
            stock: inactive.stock,
            advertId: id,
            action: 'retain-existing-for-verified-replacement',
          });
        } catch (error) {
          report.olx.failures.push({ stock: inactive.stock, advertId: id, action: 'remove-inactive', error: error.message });
        }
      }
    }
  }

  const templateSummary = adverts.find((advert) => Number(advert.category_id) > 0);
  if (!templateSummary) throw new Error('OLX account has no advert that can be used for contact, location and category settings.');
  const fallbackTemplate = await readOlxAdvert(templateSummary.id);
  const categoryConfigCache = new Map();

  async function categoryConfigFor(vehicle) {
    const brand = normalized(vehicle.brand);
    const matchingSummary = adverts.find((advert) => {
      const title = normalized(advert.title);
      return title === brand || title.startsWith(`${brand} `);
    });
    let categoryId = Number(matchingSummary?.category_id || 0);
    if (!categoryId) {
      const { json } = await olxRequest(`categories/suggestion?q=${encodeURIComponent(vehicle.title)}`);
      const suggestions = json?.data || json || [];
      const suggestion = suggestions.find((item) => Number(item?.id) > 0);
      categoryId = Number(suggestion?.id || 0);
    }
    if (!categoryId) throw new Error(`No OLX vehicle category found for ${vehicle.brand}.`);
    if (!categoryConfigCache.has(categoryId)) {
      const template = matchingSummary
        ? await readOlxAdvert(matchingSummary.id)
        : { ...fallbackTemplate, category_id: categoryId };
      const definitions = await categoryAttributes(categoryId);
      categoryConfigCache.set(categoryId, { template: { ...template, category_id: categoryId }, definitions });
    }
    return categoryConfigCache.get(categoryId);
  }

  const olxVehicles = [
    ...manifest.vehicles,
    ...(LIMIT === 0 ? (manifest.olxFallbackVehicles || []) : []),
  ];
  const allowedTargets = new Map();
  for (const inactive of manifest.inactiveVehicles || []) {
    for (const id of inactive.olxAdvertIds || []) allowedTargets.set(Number(id), inactive.stock);
  }
  for (const [index, vehicle] of olxVehicles.entries()) {
    const targetAdvertId = Number(vehicle.targetOlxAdvertId || vehicle.olxAdvertId || 0);
    const oldStock = clean(vehicle.replacesStock || vehicle.oldStock || allowedTargets.get(targetAdvertId));
    const existing = targetAdvertId && oldStock && allowedTargets.get(targetAdvertId) === oldStock
      ? advertById.get(targetAdvertId) : null;
    try {
      if (!existing) {
        report.olx.skippedUnresolved += 1;
        report.olx.results.push({ oldStock, advertId: targetAdvertId || null, newStock: vehicle.stock,
          action: 'review-no-exact-old-stock-advert-link' });
        continue;
      }
      if (clean(existing.status).toLowerCase() !== 'active') {
        report.olx.skippedUnresolved += 1;
        report.olx.results.push({ oldStock, advertId: existing.id, newStock: vehicle.stock,
          action: 'review-target-advert-not-active' });
        continue;
      }
      if (!isAvailableFeedVehicle(vehicle)) {
        report.olx.skippedUnresolved += 1;
        report.olx.results.push({ stock: vehicle.stock, action: 'review-availability-unconfirmed' });
        continue;
      }
      const { template, definitions } = await categoryConfigFor(vehicle);
      const { payload, unresolved } = olxPayload(vehicle, template, definitions);
      if (unresolved.length) {
        report.olx.unresolvedAttributes.push({ stock: vehicle.stock, unresolved });
        report.olx.skippedUnresolved += 1;
        report.olx.results.push({
          stock: vehicle.stock,
          action: 'skip-unresolved-attributes',
          unresolved: unresolved.map((item) => item.code),
        });
        console.warn(`::warning title=OLX listing skipped::${vehicle.stock} has no exact OLX value for: ${unresolved.map((item) => item.code).join(', ')}.`);
        continue;
      }
      if (existing) {
        report.olx.replacementsMatched += 1;
        if (OLX_UPDATE_EXISTING) {
          const full = await readOlxAdvert(existing.id);
          await updateOlxVehicle(full, payload);
          const verification = await ensureOlxAdvertIsPublic(existing.id, vehicle);
          report.olx.updated += 1;
          if (verification.publiclyVerified) report.olx.publiclyVerified += 1;
          report.olx.results.push({ oldStock, advertId: existing.id, newStock: vehicle.stock,
            previousStatus: existing.status, status: verification.status, publiclyVerified: verification.publiclyVerified,
            publicUrl: verification.publicUrl, action: 'update-same-advert-verified' });
        } else {
          report.olx.existingSkipped += 1;
          report.olx.results.push({ stock: vehicle.stock, advertId: existing.id, status: existing.status, action: 'retain-existing' });
        }
      } else {
        // New adverts are forbidden in this workflow. A sold position must be
        // replaced by updating that same advert id after reliable matching.
        report.olx.skippedUnresolved += 1;
        report.olx.results.push({ stock: vehicle.stock, action: 'review-no-existing-advert-position' });
      }
    } catch (error) {
      const deferredCreate = !existing
        && error.status === 403
        && /cloudfront|request blocked|request could not be satisfied/i.test(error.message);
      if (deferredCreate) {
        report.olx.deferred += 1;
        report.olx.deferredItems.push({
          stock: vehicle.stock,
          title: vehicle.title,
          handle: vehicle.handle,
          price: Number(vehicle.price),
          imageCount: vehicle.images.length,
          reason: 'OLX CloudFront temporarily blocked the create request with HTTP 403.',
        });
        report.olx.results.push({ stock: vehicle.stock, action: 'defer-create-cloudfront-403' });
        console.warn(`::warning title=OLX create deferred::${vehicle.stock} will be retried on the next daily run after an OLX CloudFront HTTP 403.`);
      } else {
        report.olx.failures.push({ stock: vehicle.stock, action: 'replace', error: error.message });
      }
    }
    if ((index + 1) % 25 === 0 || index + 1 === olxVehicles.length) {
      console.log(`OLX progress ${index + 1}/${olxVehicles.length}: updated=${report.olx.updated}, retained=${report.olx.existingSkipped}, created=${report.olx.created}, deferred=${report.olx.deferred}, skipped=${report.olx.skippedUnresolved}, failures=${report.olx.failures.length}`);
    }
  }
}

async function main() {
  const fullManifest = validateManifest(await decryptManifest());
  const report = baseReport(fullManifest);
  if (LOCAL_VALIDATE_ONLY) {
    await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ validated: true, ...report.manifest }, null, 2));
    return;
  }
  if (CHANNEL === 'all' || CHANNEL === 'shopify') await synchronizeShopify(fullManifest, report);
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (CHANNEL === 'all' || CHANNEL === 'facebook') {
    await synchronizeFacebook(fullManifest, report);
    await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  if (CHANNEL === 'all' || CHANNEL === 'olx') {
    await synchronizeOlx(fullManifest, report);
    await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  console.log(JSON.stringify(report, null, 2));
  const failures = report.shopify.failures.length + report.facebook.failures.length + report.olx.failures.length;
  const olxAttempted = report.olx.updated + report.olx.created + report.olx.existingSkipped + report.olx.failures.length;
  const olxFailureRate = olxAttempted ? report.olx.failures.length / olxAttempted : 0;
  const olxPartialSuccess = CHANNEL === 'olx'
    && report.shopify.failures.length === 0
    && report.facebook.failures.length === 0
    && report.olx.failures.length > 0
    && (report.olx.updated + report.olx.created + report.olx.existingSkipped) > 0
    && olxFailureRate <= 0.01;
  if (olxPartialSuccess) {
    console.warn(`::warning title=OLX sync partially completed::${report.olx.updated + report.olx.created + report.olx.existingSkipped} operation(s) succeeded and ${report.olx.failures.length} isolated operation(s) require review.`);
  } else if (failures) {
    console.error(`::error title=Replacement sync completed with failures::${failures} operation(s) failed. Download the report artifact for details.`);
    process.exitCode = 1;
  }
  const olxNoRealChange = MODE === 'apply'
    && (CHANNEL === 'olx' || CHANNEL === 'all')
    && report.olx.updated === 0
    && report.olx.publiclyVerified === 0
    && report.olx.skippedUnresolved > 0;
  if (olxNoRealChange) {
    console.error(`::error title=OLX made no verified changes::${report.olx.skippedUnresolved} records need an exact oldStock -> advertId link; the run is not reported as successful.`);
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  console.error(error.stack || error.message);
  console.error(`::error title=Replacement sync stopped::${String(error.message).slice(0, 500)}`);
  process.exitCode = 1;
});
