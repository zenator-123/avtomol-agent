const crypto = require('node:crypto');
const fs = require('node:fs/promises');

const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
const FACEBOOK_API_VERSION = process.env.FACEBOOK_GRAPH_VERSION || 'v25.0';
const MODE = String(process.env.REPLACEMENT_MODE || 'dry-run').toLowerCase();
const CHANNEL = String(process.env.REPLACEMENT_CHANNEL || 'all').toLowerCase();
const OFFSET = Math.max(0, Number(process.env.REPLACEMENT_OFFSET || 0));
const LIMIT = Math.max(0, Number(process.env.REPLACEMENT_LIMIT || 0));
const LOCAL_VALIDATE_ONLY = String(process.env.REPLACEMENT_LOCAL_VALIDATE_ONLY || 'false').toLowerCase() === 'true';
const MANIFEST_PATH = process.env.REPLACEMENT_MANIFEST_PATH || 'data/replacement-vehicles-2026-07-27.enc.json';
const REPORT_PATH = process.env.REPLACEMENT_REPORT_PATH || 'replacement-vehicle-sync-report.json';

if (!['dry-run', 'apply'].includes(MODE)) throw new Error(`Invalid REPLACEMENT_MODE: ${MODE}`);
if (!['all', 'shopify', 'facebook', 'olx'].includes(CHANNEL)) throw new Error(`Invalid REPLACEMENT_CHANNEL: ${CHANNEL}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clean = (value) => String(value ?? '').trim();
const stockFrom = (value) => clean(value).toUpperCase().match(/\b[A-Z]{2}\d{5}\b/)?.[0] || '';
const normalized = (value) => clean(value)
  .normalize('NFKD')
  .replace(/\p{Diacritic}/gu, '')
  .toLowerCase()
  .replace(/[^a-zа-я0-9]+/gu, ' ')
  .trim();

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
    if ((response.status === 429 || response.status >= 500) && attempt < attempts) {
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
      inactiveVehicles: manifest.inactiveVehicles.length,
    },
    shopify: {
      productsRead: 0, inactiveMatched: 0, drafted: 0, inventoryZeroed: 0, inventoryZeroSkippedNoScope: 0,
      replacementsMatched: 0, created: 0, updated: 0, pagesCreated: 0, pagesUpdated: 0,
      failures: [], results: [],
    },
    facebook: {
      postsRead: 0, inactiveMatched: 0, removed: 0, replacementsMatched: 0,
      created: 0, updated: 0, failures: [], results: [],
    },
    olx: {
      advertsRead: 0, inactiveMatched: 0, deactivated: 0, deleted: 0,
      replacementsMatched: 0, created: 0, updated: 0, limited: 0,
      unresolvedAttributes: [], failures: [], results: [],
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
  const { json } = await request(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': await getShopifyToken(),
    },
    body: JSON.stringify({ query, variables }),
  });
  if (json?.errors) throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
  return json.data;
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
          media(first: 250) { nodes { id status preview { image { url } } } }
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

  const pages = await listPages();
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
      const hostedImages = product.hostedImages.length
        ? product.hostedImages
        : await hostedProductImages(product.id, vehicle.images.length);
      const pageAction = await upsertPage(pagesByHandle.get(vehicle.seo.pageHandle), vehicle, hostedImages);
      if (pageAction === 'created') report.shopify.pagesCreated += 1;
      else report.shopify.pagesUpdated += 1;
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

function facebookUrl(path) {
  const url = new URL(`https://graph.facebook.com/${FACEBOOK_API_VERSION}/${path}`);
  url.searchParams.set('access_token', required('FACEBOOK_PAGE_ACCESS_TOKEN'));
  return url;
}

async function facebookPosts() {
  const posts = [];
  const pageId = required('FACEBOOK_PAGE_ID');
  let next = facebookUrl(`${pageId}/feed?fields=id,message,created_time&limit=100`).toString();
  for (let page = 0; next && page < 100; page += 1) {
    const { json } = await request(next);
    posts.push(...(json.data || []));
    next = json.paging?.next || '';
  }
  return posts;
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
    body: new URLSearchParams({ access_token: required('FACEBOOK_PAGE_ACCESS_TOKEN') }),
  });
}

async function publishFacebookVehicle(vehicle) {
  if (MODE !== 'apply') return { id: `dry-run:${vehicle.stock}` };
  const pageId = required('FACEBOOK_PAGE_ID');
  const body = new URLSearchParams({
    url: vehicle.images[0].url,
    caption: facebookMessage(vehicle),
    published: 'true',
    access_token: required('FACEBOOK_PAGE_ACCESS_TOKEN'),
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
      access_token: required('FACEBOOK_PAGE_ACCESS_TOKEN'),
    }),
  });
}

async function synchronizeFacebook(manifest, report) {
  const posts = await facebookPosts();
  report.facebook.postsRead = posts.length;
  const postsByStock = new Map();
  for (const post of posts) {
    const stock = stockFrom(post.message);
    if (!stock) continue;
    if (!postsByStock.has(stock)) postsByStock.set(stock, []);
    postsByStock.get(stock).push(post);
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
  for (const vehicle of manifest.vehicles) {
    const matches = postsByStock.get(vehicle.stock) || [];
    try {
      if (matches.length) {
        report.facebook.replacementsMatched += 1;
        await updateFacebookVehicle(matches[0].id, vehicle);
        report.facebook.updated += 1;
        for (const duplicate of matches.slice(1)) await deleteFacebookPost(duplicate.id);
        report.facebook.results.push({ stock: vehicle.stock, postId: matches[0].id, action: 'update-replacement' });
      } else {
        const result = await publishFacebookVehicle(vehicle);
        report.facebook.created += 1;
        report.facebook.results.push({ stock: vehicle.stock, postId: result.post_id || result.id, action: 'create-replacement' });
      }
    } catch (error) {
      report.facebook.failures.push({ stock: vehicle.stock, action: 'replace', error: error.message });
    }
  }
}

let olxToken = '';
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
  await olxRequest(`adverts/${advert.id}`, { method: 'DELETE' });
  return { deactivated, deleted: true };
}

async function categoryAttributes(categoryId) {
  const { json } = await olxRequest(`categories/${categoryId}/attributes`);
  return json?.data || json || [];
}

function allValues(definition) {
  const values = definition?.values || definition?.options || [];
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
  if (kind === 'model') return [vehicle.model, vehicle.model.split(/\s+/).slice(0, 3).join(' '), vehicle.model.split(/\s+/)[0]];
  if (kind === 'fuel') {
    const map = {
      diesel: ['diesel', 'дизел'],
      petrol: ['petrol', 'gasoline', 'бензин'],
      gasoline: ['petrol', 'gasoline', 'бензин'],
      lpg: ['lpg', 'gas', 'газ'],
      electric: ['electric', 'електрически'],
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
      van: ['van', 'миниван', 'ван'],
      limousine: ['sedan', 'седан'],
      estate: ['estate', 'комби'],
      suv: ['suv', 'джип'],
      hatchback: ['hatchback', 'хечбек'],
      coupe: ['coupe', 'купе'],
      convertible: ['convertible', 'кабрио'],
    };
    return map[normalized(vehicle.bodyType)] || [vehicle.bodyType];
  }
  if (kind === 'condition') return ['used', 'употребяван'];
  return [];
}

function resolveEnum(definition, kind, vehicle) {
  const values = allValues(definition);
  const candidates = candidateLabels(kind, vehicle).map(normalized).filter(Boolean);
  if (!candidates.length) return '';
  const exact = values.find((value) => candidates.includes(normalized(value.label)) || candidates.includes(normalized(value.code)));
  if (exact) return exact.code;
  const contains = values.find((value) => {
    const label = normalized(value.label);
    return candidates.some((candidate) => label.includes(candidate) || candidate.includes(label));
  });
  return contains?.code || '';
}

function makeAttributes(definitions, vehicle, template) {
  const templateMap = new Map((template.attributes || []).map((item) => [item.code, item]));
  const attributes = [];
  const unresolved = [];
  for (const definition of definitions) {
    const code = definition.code;
    const kind = attributeKind(definition);
    const requiredAttribute = definition.required === true || definition.is_required === true;
    let value = '';
    if (kind === 'year') value = String(vehicle.year || '');
    else if (kind === 'mileage') value = String(vehicle.mileage || '');
    else if (kind === 'power') value = String(vehicle.horsepower || vehicle.powerKw || '');
    else if (kind) value = resolveEnum(definition, kind, vehicle);
    else if (templateMap.has(code)) {
      const templateValue = templateMap.get(code);
      if (Array.isArray(templateValue.values) && templateValue.values.length) {
        attributes.push({ code, values: templateValue.values });
        continue;
      }
      value = clean(templateValue.value);
    }
    if (value) attributes.push({ code, value });
    else if (requiredAttribute) unresolved.push({ code, label: definition.label || definition.name || '', kind });
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
    external_url: `https://avtomol.com/products/${vehicle.handle}`,
    external_id: vehicle.handle,
    contact: template.contact,
    location: template.location,
    images: vehicle.images.slice(0, 20).map((image) => ({ url: image.url })),
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
  return { payload, unresolved: resolved.unresolved };
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

async function synchronizeOlx(manifest, report) {
  const adverts = await listOlxAdverts();
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
          const result = await deactivateAndDeleteOlx(advert);
          if (result.deactivated) report.olx.deactivated += 1;
          if (result.deleted) report.olx.deleted += 1;
          report.olx.results.push({ stock: inactive.stock, advertId: id, action: 'remove-inactive' });
        } catch (error) {
          report.olx.failures.push({ stock: inactive.stock, advertId: id, action: 'remove-inactive', error: error.message });
        }
      }
    }
  }

  const templateSummary = adverts.find((advert) => Number(advert.category_id) > 0);
  if (!templateSummary) throw new Error('OLX account has no advert that can be used for contact, location and category settings.');
  const template = await readOlxAdvert(templateSummary.id);
  const definitions = await categoryAttributes(template.category_id);
  for (const vehicle of manifest.vehicles) {
    const existing = advertByExternal.get(vehicle.handle.toLowerCase());
    try {
      const { payload, unresolved } = olxPayload(vehicle, template, definitions);
      if (unresolved.length) {
        report.olx.unresolvedAttributes.push({ stock: vehicle.stock, unresolved });
        report.olx.failures.push({ stock: vehicle.stock, action: 'replace', error: `Unresolved required OLX attributes: ${unresolved.map((item) => item.code).join(', ')}` });
        continue;
      }
      if (existing) {
        report.olx.replacementsMatched += 1;
        const full = await readOlxAdvert(existing.id);
        await updateOlxVehicle(full, payload);
        report.olx.updated += 1;
        report.olx.results.push({ stock: vehicle.stock, advertId: existing.id, status: existing.status, action: 'update-replacement' });
      } else {
        const result = await createOlxVehicle(payload);
        const advert = result?.data || result;
        report.olx.created += 1;
        if (advert?.status === 'limited') report.olx.limited += 1;
        report.olx.results.push({ stock: vehicle.stock, advertId: advert?.id, status: advert?.status, action: 'create-replacement' });
      }
    } catch (error) {
      report.olx.failures.push({ stock: vehicle.stock, action: 'replace', error: error.message });
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
  if (failures) {
    console.error(`::error title=Replacement sync completed with failures::${failures} operation(s) failed. Download the report artifact for details.`);
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  console.error(error.stack || error.message);
  console.error(`::error title=Replacement sync stopped::${String(error.message).slice(0, 500)}`);
  process.exitCode = 1;
});
