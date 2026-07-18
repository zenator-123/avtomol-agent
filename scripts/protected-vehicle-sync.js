const { getOlxAccessToken } = require('./olx-auth');
const {
  normalizeVehicle,
  listManagedProducts,
  createShopifyProduct,
  updateShopifyProductPrice,
  listFacebookPostsByIncomingNumber,
  updateFacebookPost,
  publishFacebookPost,
  saveFacebookPostId,
  facebookOrFallback,
} = require('./daily-vehicle-sync');

const OLX_AD_ID = 148564438;
const STOCK = 'OL56438';

function attribute(advert, code) {
  const item = (advert.attributes || []).find(value => value.code === code);
  if (!item) return '';
  return Array.isArray(item.values) ? item.values.join(', ') : String(item.value || '');
}

async function fetchProtectedAdvert() {
  const token = await getOlxAccessToken();
  const response = await fetch(`https://www.olx.bg/api/partner/adverts/${OLX_AD_ID}`, {
    headers: { Authorization: `Bearer ${token}`, Version: '2.0', Accept: 'application/json' },
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`OLX protected advert fetch failed: ${response.status} ${text.slice(0, 300)}`);
  const advert = json?.data;
  if (!advert || advert.id !== OLX_AD_ID) throw new Error('Protected Citroen advert was not found.');
  if (advert.status !== 'active') throw new Error(`Protected Citroen is not active in OLX: ${advert.status}`);
  return advert;
}

async function main() {
  const advert = await fetchProtectedAdvert();
  const vehicle = normalizeVehicle({
    incomingNumber: STOCK,
    title: advert.title,
    descriptionHtml: advert.description,
    price: advert.price?.value,
    images: (advert.images || []).map(image => image.url).filter(Boolean),
    brand: 'Citroen',
    model: attribute(advert, 'model'),
    year: attribute(advert, 'year') || attribute(advert, 'auto_make_year'),
    mileage: attribute(advert, 'mileage') || attribute(advert, 'auto_mileage'),
    fuel: attribute(advert, 'fuel_type') || attribute(advert, 'auto_engine_type'),
    transmission: attribute(advert, 'transmission') || attribute(advert, 'auto_transmission_type'),
    handle: 'citroen-c4-grand-picasso-ol56438',
    availability: 'available',
  });
  if (!vehicle.title || !vehicle.price || !vehicle.images.length) throw new Error('Protected Citroen data is incomplete; refusing to publish a partial listing.');

  const products = await listManagedProducts([vehicle]);
  let product = products.find(item => item.incomingNumber === STOCK || item.handle === vehicle.handle);
  let shopifyAction = 'existing';
  if (!product) {
    product = await createShopifyProduct(vehicle);
    shopifyAction = 'created';
  } else if (await updateShopifyProductPrice(product, vehicle)) {
    shopifyAction = 'price-updated';
  }

  const failures = [];
  const posts = await facebookOrFallback('list protected Citroen posts', listFacebookPostsByIncomingNumber, new Map(), failures);
  let postId = product.facebookPostId || posts.get(STOCK) || '';
  let facebookAction = 'existing';
  if (postId) {
    await facebookOrFallback('update protected Citroen', () => updateFacebookPost(postId, vehicle), false, failures);
    facebookAction = failures.length ? 'failed' : 'updated';
  } else {
    postId = await facebookOrFallback('publish protected Citroen', () => publishFacebookPost(vehicle, product.handle), '', failures);
    if (postId) await saveFacebookPostId(product.id, postId);
    facebookAction = postId ? 'created' : 'failed';
  }
  console.log(JSON.stringify({ olxAdId: OLX_AD_ID, stock: STOCK, shopifyAction, facebookAction, facebookFailures: failures }));
  if (failures.length) {
    console.error('::error title=Facebook protected Citroen sync::' + failures.map(item => item.error).join(' | '));
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  console.error('::error title=Protected Citroen sync::' + String(error.message));
  process.exitCode = 1;
});
