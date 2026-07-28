const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const zlib = require('node:zlib');

const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
const MODE = String(process.env.FULL_REPLACEMENT_MODE || 'dry-run').toLowerCase();
const LIMIT = Math.max(1, Number(process.env.FULL_REPLACEMENT_LIMIT || 50));
const GENERATION = process.env.FULL_REPLACEMENT_GENERATION || '2026-07-28';
const MANIFEST_PATH = process.env.FULL_REPLACEMENT_MANIFEST_PATH
  || 'data/full-replacement-catalog-2026-07-28.enc.json';
const REPORT_PATH = process.env.FULL_REPLACEMENT_REPORT_PATH
  || 'full-replacement-catalog-import-report.json';
const LOCAL_VALIDATE_ONLY = process.env.FULL_REPLACEMENT_LOCAL_VALIDATE_ONLY === 'true';

if (!['dry-run', 'apply'].includes(MODE)) throw new Error(`Invalid FULL_REPLACEMENT_MODE: ${MODE}`);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clean = value => String(value ?? '').trim();
const stockFrom = value => clean(value).toUpperCase().match(/\b[A-Z]{2}\d{5}\b/)?.[0] || '';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required setting: ${name}`);
  return value;
}

async function request(url, options = {}, attempts = 6) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url, options);
    const text = await response.text();
    let json = null;
    if (text) {
      try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 1000) }; }
    }
    if (response.ok) return { response, json, text };
    if ((response.status === 429 || response.status >= 500) && attempt < attempts) {
      await sleep(Math.min(20000, 1000 * (2 ** (attempt - 1))));
      continue;
    }
    throw new Error(`${options.method || 'GET'} ${url} failed: HTTP ${response.status} ${JSON.stringify(json)}`);
  }
  throw new Error(`Request failed after ${attempts} attempts: ${url}`);
}

async function decryptManifest() {
  const document = JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8'));
  if (document.algorithm !== 'aes-256-gcm+gzip') {
    throw new Error(`Unsupported manifest algorithm: ${document.algorithm}`);
  }
  const key = Buffer.from(required('FULL_REPLACEMENT_MANIFEST_KEY'), 'base64');
  if (key.length !== 32) throw new Error('FULL_REPLACEMENT_MANIFEST_KEY must decode to 32 bytes.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(document.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(document.authTag, 'base64'));
  const compressed = Buffer.concat([
    decipher.update(Buffer.from(document.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(zlib.gunzipSync(compressed).toString('utf8'));
}

function validateManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.vehicles) || !manifest.vehicles.length) {
    throw new Error('Replacement manifest has no vehicles.');
  }
  const stocks = new Set();
  const handles = new Set();
  for (const vehicle of manifest.vehicles) {
    if (!/^[A-Z]{2}\d{5}$/.test(vehicle.stock) || stocks.has(vehicle.stock)) {
      throw new Error(`Invalid or duplicate stock: ${vehicle.stock}`);
    }
    if (!vehicle.handle || handles.has(vehicle.handle)) {
      throw new Error(`Invalid or duplicate handle: ${vehicle.handle}`);
    }
    if (vehicle.directPurchase !== true || vehicle.isUnroadworthy !== false) {
      throw new Error(`Safety stop: ${vehicle.stock} is not a roadworthy direct purchase.`);
    }
    if (!(Number(vehicle.price) > Number(vehicle.landedCost)) || !(Number(vehicle.expectedNetProfit) > 0)) {
      throw new Error(`Safety stop: ${vehicle.stock} has no positive protected profit.`);
    }
    if (!vehicle.title || !vehicle.bodyHtml || !vehicle.plainDescription || !vehicle.images?.length) {
      throw new Error(`Safety stop: ${vehicle.stock} has incomplete listing content.`);
    }
    if (
      vehicle.bodyHtml.includes('???')
      || vehicle.plainDescription.includes('???')
      || /\bAUTO\s*1\b|auto1\.com/i.test(`${vehicle.bodyHtml}\n${vehicle.plainDescription}`)
    ) {
      throw new Error(`Safety stop: ${vehicle.stock} failed public-content validation.`);
    }
    stocks.add(vehicle.stock);
    handles.add(vehicle.handle);
  }
  return manifest;
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
  for (let attempt = 1; attempt <= 15; attempt += 1) {
    const { json } = await request(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': await getShopifyToken(),
      },
      body: JSON.stringify({ query, variables }),
    });
    const errors = json?.errors || [];
    const throttled = errors.some(error => error?.extensions?.code === 'THROTTLED');
    if (throttled && attempt < 15) {
      const throttle = json?.extensions?.cost?.throttleStatus || {};
      const restoreRate = Math.max(1, Number(throttle.restoreRate || 50));
      const requested = Math.max(1, Number(json?.extensions?.cost?.requestedQueryCost || 100));
      const available = Math.max(0, Number(throttle.currentlyAvailable || 0));
      await sleep(Math.min(30000, Math.max(1000, Math.ceil(((requested - available) / restoreRate) * 1000) + 750)));
      continue;
    }
    if (errors.length) throw new Error(`Shopify GraphQL error: ${JSON.stringify(errors)}`);
    return json.data;
  }
  throw new Error('Shopify GraphQL remained throttled.');
}

const productFields = `
  id handle title status descriptionHtml
  variants(first: 1) { nodes { id sku price } }
  incoming: metafield(namespace: "custom", key: "incoming_number") { value }
  generation: metafield(namespace: "custom", key: "replacement_generation") { value }
`;

async function productById(id) {
  if (!id) return null;
  const data = await shopifyGraphql(`query FullReplacementProductById($id: ID!) {
    product(id: $id) { ${productFields} }
  }`, { id });
  return data.product || null;
}

async function productByHandle(handle) {
  const data = await shopifyGraphql(`query FullReplacementProductByHandle($query: String!) {
    products(first: 10, query: $query) { nodes { ${productFields} } }
  }`, { query: `handle:${handle}` });
  return data.products.nodes.find(product => product.handle === handle) || null;
}

function productIsCurrent(product, vehicle) {
  if (!product || product.status !== 'ACTIVE') return false;
  if (stockFrom(product.incoming?.value || product.variants?.nodes?.[0]?.sku) !== vehicle.stock) return false;
  if (clean(product.generation?.value) !== GENERATION) return false;
  if (Math.abs(Number(product.variants?.nodes?.[0]?.price) - Number(vehicle.price)) > 0.01) return false;
  return true;
}

async function targetPublications() {
  const data = await shopifyGraphql(`query FullReplacementPublications {
    publications(first: 100) { nodes { id name } }
  }`);
  const all = data.publications.nodes || [];
  const targets = all.filter(publication => (
    /online store|facebook|instagram/i.test(publication.name)
  ));
  return { all, targets };
}

async function publishProduct(productId, publicationIds) {
  if (!publicationIds.length || MODE !== 'apply') return;
  const data = await shopifyGraphql(`mutation PublishFullReplacement($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) { userErrors { field message } }
  }`, {
    id: productId,
    input: publicationIds.map(publicationId => ({ publicationId })),
  });
  const errors = data.publishablePublish.userErrors.filter(error => !/already published/i.test(error.message));
  if (errors.length) throw new Error(`Publish failed: ${JSON.stringify(errors)}`);
}

async function setVariant(productId, variantId, vehicle) {
  const data = await shopifyGraphql(`mutation UpdateFullReplacementVariant(
    $productId: ID!,
    $variants: [ProductVariantsBulkInput!]!
  ) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      userErrors { field message }
    }
  }`, {
    productId,
    variants: [{
      id: variantId,
      price: Number(vehicle.price).toFixed(2),
      sku: vehicle.stock,
    }],
  });
  if (data.productVariantsBulkUpdate.userErrors.length) {
    throw new Error(`Variant update failed: ${JSON.stringify(data.productVariantsBulkUpdate.userErrors)}`);
  }
}

function productInput(vehicle, id = undefined) {
  const input = {
    title: vehicle.title,
    handle: vehicle.handle,
    descriptionHtml: vehicle.bodyHtml,
    vendor: 'Avtomol.com',
    productType: 'Автомобил',
    status: 'ACTIVE',
    tags: [],
    seo: {
      title: vehicle.seo?.productTitle || vehicle.title,
      description: vehicle.seo?.productDescription || vehicle.plainDescription.slice(0, 300),
    },
    metafields: [
      {
        namespace: 'custom',
        key: 'incoming_number',
        type: 'single_line_text_field',
        value: vehicle.stock,
      },
      {
        namespace: 'custom',
        key: 'replacement_generation',
        type: 'single_line_text_field',
        value: GENERATION,
      },
    ],
  };
  if (id) input.id = id;
  return input;
}

async function createProduct(vehicle, publicationIds) {
  const media = vehicle.images.slice(0, 30).map((image, index) => ({
    originalSource: image.url,
    mediaContentType: 'IMAGE',
    alt: image.alt || `${vehicle.title} – снимка ${index + 1}`,
  }));
  const data = await shopifyGraphql(`mutation CreateFullReplacement(
    $product: ProductCreateInput!,
    $media: [CreateMediaInput!]
  ) {
    productCreate(product: $product, media: $media) {
      product { id handle variants(first: 1) { nodes { id } } }
      userErrors { field message }
    }
  }`, { product: productInput(vehicle), media });
  if (data.productCreate.userErrors.length) {
    throw new Error(`Product create failed: ${JSON.stringify(data.productCreate.userErrors)}`);
  }
  const product = data.productCreate.product;
  const variantId = product.variants.nodes[0]?.id;
  if (!variantId) throw new Error('Created product has no default variant.');
  await setVariant(product.id, variantId, vehicle);
  await publishProduct(product.id, publicationIds);
  return product;
}

async function updateProduct(product, vehicle, publicationIds) {
  const data = await shopifyGraphql(`mutation UpdateFullReplacement($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id handle status variants(first: 1) { nodes { id } } }
      userErrors { field message }
    }
  }`, { product: productInput(vehicle, product.id) });
  if (data.productUpdate.userErrors.length) {
    throw new Error(`Product update failed: ${JSON.stringify(data.productUpdate.userErrors)}`);
  }
  const updated = data.productUpdate.product;
  const variantId = updated.variants.nodes[0]?.id || product.variants?.nodes?.[0]?.id;
  if (!variantId) throw new Error('Updated product has no variant.');
  await setVariant(updated.id, variantId, vehicle);
  await publishProduct(updated.id, publicationIds);
  return updated;
}

async function main() {
  const manifest = validateManifest(await decryptManifest());
  if (LOCAL_VALIDATE_ONLY) {
    const report = {
      generatedAt: new Date().toISOString(),
      mode: 'local-validation',
      generation: GENERATION,
      manifestVehicles: manifest.vehicles.length,
      validation: 'passed',
    };
    await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const publications = await targetPublications();
  const report = {
    generatedAt: new Date().toISOString(),
    mode: MODE,
    generation: GENERATION,
    manifestVehicles: manifest.vehicles.length,
    batchLimit: LIMIT,
    publications: {
      available: publications.all.map(publication => publication.name),
      targeted: publications.targets.map(publication => publication.name),
    },
    scanned: 0,
    alreadyCurrent: 0,
    selected: 0,
    created: 0,
    updated: 0,
    failures: [],
    results: [],
  };
  const pending = [];
  for (const vehicle of manifest.vehicles) {
    if (pending.length >= LIMIT) break;
    report.scanned += 1;
    let product = null;
    try {
      product = vehicle.existingProduct?.id
        ? await productById(vehicle.existingProduct.id)
        : await productByHandle(vehicle.handle);
      if (productIsCurrent(product, vehicle)) {
        report.alreadyCurrent += 1;
        continue;
      }
      pending.push({ vehicle, product });
    } catch (error) {
      report.failures.push({ stock: vehicle.stock, action: 'inspect', error: error.message });
    }
  }
  report.selected = pending.length;
  for (const { vehicle, product } of pending) {
    if (MODE !== 'apply') {
      report.results.push({
        stock: vehicle.stock,
        handle: vehicle.handle,
        action: product ? 'would-update' : 'would-create',
        price: vehicle.price,
        landedCost: vehicle.landedCost,
        expectedNetProfit: vehicle.expectedNetProfit,
      });
      continue;
    }
    try {
      if (product) {
        const updated = await updateProduct(
          product,
          vehicle,
          publications.targets.map(publication => publication.id),
        );
        report.updated += 1;
        report.results.push({
          stock: vehicle.stock,
          productId: updated.id,
          handle: vehicle.handle,
          action: 'updated',
          price: vehicle.price,
          expectedNetProfit: vehicle.expectedNetProfit,
        });
      } else {
        const created = await createProduct(
          vehicle,
          publications.targets.map(publication => publication.id),
        );
        report.created += 1;
        report.results.push({
          stock: vehicle.stock,
          productId: created.id,
          handle: created.handle,
          action: 'created',
          price: vehicle.price,
          expectedNetProfit: vehicle.expectedNetProfit,
        });
      }
    } catch (error) {
      report.failures.push({
        stock: vehicle.stock,
        handle: vehicle.handle,
        action: product ? 'update' : 'create',
        error: error.message,
      });
    }
    await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
  if (report.failures.length) {
    console.error(`::error title=Full replacement import has failures::${report.failures.length} operation(s) failed.`);
    process.exitCode = 1;
  }
}

main().catch(async error => {
  console.error(error.stack || error.message);
  console.error(`::error title=Full replacement import stopped::${String(error.message).slice(0, 500)}`);
  process.exitCode = 1;
});
