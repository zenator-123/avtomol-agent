const fs = require('node:fs/promises');

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
const DRY_RUN = String(process.env.SYNC_DRY_RUN ?? 'true').toLowerCase() !== 'false';
const MAX_DELETIONS = Number(process.env.MAX_DELETIONS_PER_RUN || 20);
const MIN_INVENTORY = Number(process.env.MIN_INVENTORY_COUNT || 10);
const ALLOW_DELETIONS = String(process.env.ALLOW_DELETIONS || 'false').toLowerCase() === 'true';
const ALLOW_ADDITIONS = String(process.env.ALLOW_ADDITIONS || 'false').toLowerCase() === 'true';

function pick(object, names) {
  for (const name of names) {
    const value = object?.[name];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
}

function normalizeVehicle(raw) {
  const incomingNumber = String(pick(raw, ['incomingNumber', 'incoming_number', 'externalId', 'external_id', 'stockNumber', 'stock_number', 'id']) || '').trim();
  const availability = String(pick(raw, ['availability', 'status']) || 'available').toLowerCase();
  const sold = raw?.sold === true || ['sold', 'unavailable', 'deleted', 'removed'].includes(availability);
  const images = pick(raw, ['images', 'imageUrls', 'image_urls']) || [];
  return {
    incomingNumber,
    available: !sold,
    title: String(pick(raw, ['title', 'name']) || '').trim(),
    descriptionHtml: String(pick(raw, ['descriptionHtml', 'description_html', 'description']) || '').trim(),
    price: Number(pick(raw, ['price', 'priceValue', 'price_value']) || 0),
    images: (Array.isArray(images) ? images : String(images).split(',')).map(String).map((x) => x.trim()).filter((x) => /^https:\/\//i.test(x)),
    brand: String(pick(raw, ['brand', 'make']) || '').trim(),
    model: String(pick(raw, ['model']) || '').trim(),
    year: String(pick(raw, ['year', 'makeYear', 'auto_make_year']) || '').trim(),
    mileage: String(pick(raw, ['mileage', 'auto_mileage']) || '').trim(),
    fuel: String(pick(raw, ['fuel', 'engineType', 'auto_engine_type']) || '').trim(),
    transmission: String(pick(raw, ['transmission', 'auto_transmission_type']) || '').trim(),
    handle: String(pick(raw, ['handle', 'productHandle', 'product_handle']) || '').trim(),
  };
}

async function loadInventory() {
  let payload;
  if (process.env.INVENTORY_FEED_URL) {
    const response = await fetch(process.env.INVENTORY_FEED_URL, {
      headers: process.env.INVENTORY_FEED_TOKEN ? { Authorization: `Bearer ${process.env.INVENTORY_FEED_TOKEN}` } : {},
    });
    if (!response.ok) throw new Error(`Inventory feed failed: HTTP ${response.status}`);
    payload = await response.json();
  } else {
    payload = JSON.parse(await fs.readFile(process.env.INVENTORY_FEED_PATH || 'data/vehicle-inventory.json', 'utf8'));
  }
  const rows = Array.isArray(payload) ? payload : payload.vehicles;
  if (!Array.isArray(rows)) throw new Error('Inventory feed must be an array or {"vehicles": [...]}');
  const vehicles = rows.map(normalizeVehicle).filter((vehicle) => vehicle.incomingNumber);
  if (vehicles.length < MIN_INVENTORY) throw new Error(`Safety stop: inventory has ${vehicles.length} vehicles; minimum is ${MIN_INVENTORY}`);
  return vehicles;
}

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required setting: ${name}`);
  return value;
}

async function shopifyGraphql(query, variables = {}) {
  const shop = env('SHOPIFY_SHOP_DOMAIN').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const token = await getShopifyAccessToken(shop);
  const response = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  const json = await response.json();
  if (!response.ok || json.errors) throw new Error(`Shopify request failed: ${response.status} ${JSON.stringify(json.errors || json)}`);
  return json.data;
}

let cachedShopifyToken = '';
async function getShopifyAccessToken(shop) {
  if (process.env.SHOPIFY_ACCESS_TOKEN) return process.env.SHOPIFY_ACCESS_TOKEN;
  if (cachedShopifyToken) return cachedShopifyToken;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env('SHOPIFY_CLIENT_ID'),
    client_secret: env('SHOPIFY_CLIENT_SECRET'),
  });
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body,
    redirect: 'manual',
  });
  const responseText = await response.text();
  let json;
  try { json = JSON.parse(responseText); }
  catch { throw new Error(`Shopify authentication returned ${response.status} ${response.headers.get('content-type') || 'unknown content type'}${response.headers.get('location') ? ` redirect=${response.headers.get('location')}` : ''}`); }
  if (!response.ok || !json.access_token) throw new Error(`Shopify authentication failed: ${json.error_description || json.error || response.status}`);
  cachedShopifyToken = json.access_token;
  return cachedShopifyToken;
}

function mapManagedProduct(product) {
  return {
    ...product,
    incomingNumber: product.metafield?.value || '',
    facebookPostId: product.facebookPost?.value || '',
    variantId: product.variants?.nodes?.[0]?.id || '',
    price: Number(product.variants?.nodes?.[0]?.price || 0),
  };
}

async function listManagedProducts(vehicles = []) {
  const query = process.env.SHOPIFY_MANAGED_QUERY || 'tag:vehicle-sync';
  const products = [];
  let cursor = null;
  do {
    const data = await shopifyGraphql(`query ManagedVehicles($cursor: String, $query: String!) {
      products(first: 100, after: $cursor, query: $query) {
        nodes { id title handle variants(first: 1) { nodes { id price } }
          metafield(namespace: "custom", key: "incoming_number") { value }
          facebookPost: metafield(namespace: "custom", key: "facebook_post_id") { value } }
        pageInfo { hasNextPage endCursor }
      }
    }`, { cursor, query });
    products.push(...data.products.nodes.map(mapManagedProduct));
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);
  const knownHandles = new Set(products.map((product) => product.handle));
  for (const vehicle of vehicles) {
    if (!vehicle.handle || knownHandles.has(vehicle.handle)) continue;
    const data = await shopifyGraphql(`query VehicleByHandle($query: String!) {
      products(first: 1, query: $query) { nodes { id title handle variants(first: 1) { nodes { id price } }
        metafield(namespace: "custom", key: "incoming_number") { value }
        facebookPost: metafield(namespace: "custom", key: "facebook_post_id") { value } } }
    }`, { query: `handle:${vehicle.handle}` });
    const product = data.products.nodes[0];
    if (product) {
      const mapped = mapManagedProduct(product);
      mapped.incomingNumber = mapped.incomingNumber || vehicle.incomingNumber;
      products.push(mapped);
      knownHandles.add(mapped.handle);
    }
  }
  return products.filter((product) => product.incomingNumber);
}

function slug(value) {
  return String(value).normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 180);
}

function vehicleDescription(vehicle) {
  if (vehicle.descriptionHtml) return vehicle.descriptionHtml;
  const facts = [
    ['Марка', vehicle.brand], ['Модел', vehicle.model], ['Година', vehicle.year],
    ['Пробег', vehicle.mileage], ['Гориво', vehicle.fuel], ['Скоростна кутия', vehicle.transmission],
  ].filter(([, value]) => value);
  return `<div style="border:2px solid #d40000;padding:14px;color:#d40000;font-size:24px;font-weight:700">ВХОДЯЩ НОМЕР: ${vehicle.incomingNumber}</div>`
    + `<h2>${vehicle.title}</h2><ul>${facts.map(([key, value]) => `<li><strong>${key}:</strong> ${value}</li>`).join('')}</ul>`
    + '<p>Предлагаме проверени автомобили от Европа и авточасти за всички видове автомобили. Телефон: 0876 778 357.</p>';
}

async function createShopifyProduct(vehicle) {
  if (DRY_RUN) return { id: `dry-run:${vehicle.incomingNumber}`, handle: vehicle.handle || slug(`${vehicle.title}-${vehicle.incomingNumber}`) };
  const product = {
    title: vehicle.title,
    handle: vehicle.handle || slug(`${vehicle.title}-${vehicle.incomingNumber}`),
    descriptionHtml: vehicleDescription(vehicle),
    vendor: 'AvtoMol.com',
    productType: 'Автомобили',
    status: 'ACTIVE',
    tags: ['vehicle-sync', `incoming-${vehicle.incomingNumber}`],
    metafields: [{ namespace: 'custom', key: 'incoming_number', type: 'single_line_text_field', value: vehicle.incomingNumber }],
  };
  const media = vehicle.images.map((originalSource, index) => ({ originalSource, mediaContentType: 'IMAGE', alt: `${vehicle.title} снимка ${index + 1}` }));
  const data = await shopifyGraphql(`mutation CreateVehicle($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
    productCreate(product: $product, media: $media) { product { id handle variants(first: 1) { nodes { id } } } userErrors { field message } }
  }`, { product, media });
  const errors = data.productCreate.userErrors;
  if (errors.length) throw new Error(`Shopify create rejected: ${JSON.stringify(errors)}`);
  const created = data.productCreate.product;
  if (vehicle.price > 0) {
    const variantId = created.variants.nodes[0]?.id;
    const update = await shopifyGraphql(`mutation PriceVehicle($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } }
    }`, { productId: created.id, variants: [{ id: variantId, price: vehicle.price.toFixed(2) }] });
    if (update.productVariantsBulkUpdate.userErrors.length) throw new Error(`Shopify price rejected: ${JSON.stringify(update.productVariantsBulkUpdate.userErrors)}`);
  }
  return created;
}

async function updateShopifyProductPrice(product, vehicle) {
  if (!vehicle.price || !product.variantId || Math.abs(Number(product.price) - vehicle.price) < 0.01) return false;
  if (DRY_RUN) return true;
  const update = await shopifyGraphql(`mutation PriceVehicle($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } }
  }`, { productId: product.id, variants: [{ id: product.variantId, price: vehicle.price.toFixed(2) }] });
  if (update.productVariantsBulkUpdate.userErrors.length) {
    throw new Error(`Shopify price rejected: ${JSON.stringify(update.productVariantsBulkUpdate.userErrors)}`);
  }
  return true;
}

async function deleteShopifyProduct(product) {
  if (DRY_RUN) return;
  const data = await shopifyGraphql(`mutation DeleteVehicle($input: ProductDeleteInput!) {
    productDelete(input: $input) { deletedProductId userErrors { field message } }
  }`, { input: { id: product.id } });
  if (data.productDelete.userErrors.length) throw new Error(`Shopify delete rejected: ${JSON.stringify(data.productDelete.userErrors)}`);
}

async function facebookRequest(path, options = {}) {
  const token = env('FACEBOOK_PAGE_ACCESS_TOKEN');
  const url = new URL(`https://graph.facebook.com/${process.env.FACEBOOK_GRAPH_VERSION || 'v24.0'}/${path}`);
  url.searchParams.set('access_token', token);
  const response = await fetch(url, options);
  const json = await response.json();
  if (!response.ok || json.error) throw new Error(`Facebook request failed: ${json.error?.message || response.status}`);
  return json;
}

function facebookMessage(vehicle) {
  return [
    `ВХОДЯЩ НОМЕР: ${vehicle.incomingNumber}`,
    vehicle.title,
    `КРАЙНА ЦЕНА: ${vehicle.price.toFixed(2)} EUR`,
    vehicle.year && `Година: ${vehicle.year}`,
    vehicle.mileage && `Пробег: ${vehicle.mileage} км`,
    'Доставката до България е включена в цената.',
    'При поръчка се издава проформа фактура. След плащането автомобилът се доставя в указания срок.',
    'Телефон: 0876 778 357',
  ].filter(Boolean).join('\n');
}

async function publishFacebookPost(vehicle, productHandle) {
  if (!process.env.FACEBOOK_PAGE_ACCESS_TOKEN || !process.env.FACEBOOK_PAGE_ID) return '';
  if (DRY_RUN) return `dry-run:${vehicle.incomingNumber}`;
  const message = facebookMessage(vehicle);
  const body = new URLSearchParams({ message, link: `https://avtomol.com/products/${productHandle}` });
  const result = await facebookRequest(`${env('FACEBOOK_PAGE_ID')}/feed`, { method: 'POST', body });
  return result.id;
}

async function listFacebookPostsByIncomingNumber() {
  const posts = new Map();
  if (!process.env.FACEBOOK_PAGE_ACCESS_TOKEN || !process.env.FACEBOOK_PAGE_ID) return posts;
  const result = await facebookRequest(`${env('FACEBOOK_PAGE_ID')}/feed?fields=id,message&limit=100`);
  for (const post of result.data || []) {
    const stock = String(post.message || '').match(/ВХОДЯЩ НОМЕР:\s*([A-Z]{2}\d{5})/i)?.[1]?.toUpperCase();
    if (stock) posts.set(stock, post.id);
  }
  return posts;
}

async function updateFacebookPost(postId, vehicle) {
  if (!postId || !process.env.FACEBOOK_PAGE_ACCESS_TOKEN) return false;
  if (DRY_RUN) return true;
  await facebookRequest(postId, { method: 'POST', body: new URLSearchParams({ message: facebookMessage(vehicle) }) });
  return true;
}

async function saveFacebookPostId(productId, postId) {
  if (!postId || DRY_RUN || String(productId).startsWith('dry-run:')) return;
  const data = await shopifyGraphql(`mutation SaveFacebookPost($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { userErrors { field message } }
  }`, { metafields: [{ ownerId: productId, namespace: 'custom', key: 'facebook_post_id', type: 'single_line_text_field', value: postId }] });
  if (data.metafieldsSet.userErrors.length) throw new Error(`Shopify metafield rejected: ${JSON.stringify(data.metafieldsSet.userErrors)}`);
}

async function deleteFacebookPost(postId) {
  if (!postId || !process.env.FACEBOOK_PAGE_ACCESS_TOKEN || DRY_RUN) return;
  await facebookRequest(postId, { method: 'DELETE' });
}

async function main() {
  const inventory = await loadInventory();
  const available = new Map(inventory.filter((vehicle) => vehicle.available).map((vehicle) => [vehicle.incomingNumber, vehicle]));
  const products = await listManagedProducts([...available.values()]);
  const existing = new Map(products.map((product) => [product.incomingNumber, product]));
  const sold = products.filter((product) => !available.has(product.incomingNumber));
  const additions = [...available.values()].filter((vehicle) => !existing.has(vehicle.incomingNumber));
  const updates = [...available.values()].filter((vehicle) => existing.has(vehicle.incomingNumber));
  const facebookPosts = await listFacebookPostsByIncomingNumber();
  if (ALLOW_DELETIONS && sold.length > MAX_DELETIONS) throw new Error(`Safety stop: ${sold.length} deletions exceed maximum ${MAX_DELETIONS}`);
  console.log(JSON.stringify({ dryRun: DRY_RUN, allowDeletions: ALLOW_DELETIONS, allowAdditions: ALLOW_ADDITIONS, inventory: inventory.length, existing: products.length, sold: sold.length, additions: additions.length, updates: updates.length }));

  if (ALLOW_DELETIONS) {
    for (const product of sold) {
      console.log(`${DRY_RUN ? 'WOULD DELETE' : 'DELETE'} ${product.incomingNumber} ${product.title}`);
      await deleteFacebookPost(product.facebookPostId);
      await deleteShopifyProduct(product);
    }
  } else if (sold.length) {
    console.log(`SKIP ${sold.length} deletions because ALLOW_DELETIONS is false`);
  }
  for (const vehicle of updates) {
    const product = existing.get(vehicle.incomingNumber);
    const priceChanged = await updateShopifyProductPrice(product, vehicle);
    const postId = product.facebookPostId || facebookPosts.get(vehicle.incomingNumber) || '';
    const facebookChanged = await updateFacebookPost(postId, vehicle);
    if (postId && !product.facebookPostId) await saveFacebookPostId(product.id, postId);
    console.log(`${DRY_RUN ? 'WOULD UPDATE' : 'UPDATE'} ${vehicle.incomingNumber} ShopifyPrice=${priceChanged} Facebook=${facebookChanged}`);
  }
  if (ALLOW_ADDITIONS) {
    for (const vehicle of additions) {
      console.log(`${DRY_RUN ? 'WOULD ADD' : 'ADD'} ${vehicle.incomingNumber} ${vehicle.title}`);
      const product = await createShopifyProduct(vehicle);
      const postId = await publishFacebookPost(vehicle, product.handle);
      await saveFacebookPostId(product.id, postId);
    }
  } else if (additions.length) {
    console.log(`SKIP ${additions.length} additions because ALLOW_ADDITIONS is false`);
  }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { normalizeVehicle, vehicleDescription };
