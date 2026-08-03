const clean = (value) => String(value ?? '').trim();
const normalized = (value) => clean(value)
  .normalize('NFKD')
  .replace(/\p{Diacritic}/gu, '')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim();

const number = (value) => {
  const parsed = Number(String(value ?? '').replace(/[^0-9.,-]/g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
};

function attributeMap(advert) {
  const result = new Map();
  for (const attribute of advert?.attributes || []) {
    const key = normalized(attribute.code || attribute.key || attribute.name || attribute.label);
    const raw = attribute.value ?? attribute.values?.[0] ?? attribute.label;
    const value = typeof raw === 'object' ? raw.label ?? raw.value ?? raw.code : raw;
    if (key && value != null) result.set(key, clean(value));
  }
  return result;
}

function first(source, keys) {
  for (const key of keys) {
    const value = source instanceof Map ? source.get(normalized(key)) : source?.[key];
    if (clean(value)) return clean(value);
  }
  return '';
}

function splitVehicleName(title) {
  const words = normalized(title).split(' ').filter(Boolean);
  return { brand: words[0] || '', model: words.slice(1, 4).join(' ') };
}

function specsFromOlxAdvert(advert) {
  const attrs = attributeMap(advert);
  const titleParts = splitVehicleName(advert?.title);
  return {
    brand: first(attrs, ['brand', 'make', 'марка']) || titleParts.brand,
    model: first(attrs, ['model', 'модел']) || titleParts.model,
    year: number(first(attrs, ['year', 'година', 'production_year'])),
    fuel: first(attrs, ['fuel', 'гориво', 'fuel_type']),
    engine: first(attrs, ['engine', 'двигател', 'engine_capacity']),
    horsepower: number(first(attrs, ['power', 'мощност', 'horsepower', 'power_hp'])),
    gearbox: first(attrs, ['gearbox', 'скоростна кутия', 'transmission']),
    bodyType: first(attrs, ['body', 'купе', 'body_type']),
    price: number(advert?.price?.value ?? advert?.price),
    title: clean(advert?.title),
  };
}

function specsFromVehicle(vehicle) {
  return {
    brand: clean(vehicle.brand || vehicle.make),
    model: clean(vehicle.model),
    year: number(vehicle.year),
    fuel: clean(vehicle.fuel || vehicle.fuelType),
    engine: clean(vehicle.engine || vehicle.engineCapacity || vehicle.displacement),
    horsepower: number(vehicle.horsepower || vehicle.powerHp || vehicle.powerKw),
    gearbox: clean(vehicle.gearbox || vehicle.transmission),
    bodyType: clean(vehicle.bodyType || vehicle.body),
    price: number(vehicle.price),
    title: clean(vehicle.title),
  };
}

function sameText(left, right) {
  const a = normalized(left), b = normalized(right);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function modelRoot(value) {
  return normalized(value).split(' ').filter(word => !/^\d+(?:\.\d+)?$/.test(word) && !/^(tdi|tsi|hdi|dci|crdi|turbo|diesel|benzine?)$/.test(word)).slice(0, 2).join(' ');
}

function scoreReplacement(oldAdvert, candidate) {
  const old = specsFromOlxAdvert(oldAdvert);
  const next = specsFromVehicle(candidate);
  const sameBrand = sameText(old.brand, next.brand);
  const sameModel = Boolean(modelRoot(old.model) && modelRoot(old.model) === modelRoot(next.model));
  if (!sameBrand || !sameModel) return { reliable: false, score: -Infinity, reasons: ['different-brand-or-model'], old, next };

  let score = 1000;
  const reasons = ['same-brand-model'];
  if (old.year != null && next.year != null) {
    const delta = Math.abs(old.year - next.year);
    score += Math.max(0, 180 - delta * 35);
    reasons.push(`year-delta:${delta}`);
  }
  for (const [key, weight] of [['fuel', 130], ['engine', 110], ['gearbox', 90], ['bodyType', 80]]) {
    if (sameText(old[key], next[key])) { score += weight; reasons.push(`same-${key}`); }
  }
  if (old.horsepower != null && next.horsepower != null) {
    const delta = Math.abs(old.horsepower - next.horsepower);
    score += Math.max(0, 90 - delta * 2);
    reasons.push(`power-delta:${delta}`);
  }
  if (old.price != null && next.price != null && old.price > 0) {
    const ratio = Math.abs(old.price - next.price) / old.price;
    score += Math.max(0, 100 - ratio * 200);
    reasons.push(`price-delta:${Math.round(ratio * 100)}%`);
  }
  const reliable = (!old.year || !next.year || Math.abs(old.year - next.year) <= 5)
    && (!old.fuel || !next.fuel || sameText(old.fuel, next.fuel));
  return { reliable, score, reasons, old, next };
}

function selectReplacement(oldAdvert, candidates, usedStocks = new Set()) {
  const ranked = candidates
    .filter(vehicle => !usedStocks.has(clean(vehicle.stock)))
    .map(vehicle => ({ vehicle, ...scoreReplacement(oldAdvert, vehicle) }))
    .filter(item => item.reliable)
    .sort((a, b) => {
      const av = a.vehicle.vatReclaimable === true && a.vehicle.vatConfirmed === true ? 1 : 0;
      const bv = b.vehicle.vatReclaimable === true && b.vehicle.vatConfirmed === true ? 1 : 0;
      return bv - av || b.score - a.score || clean(a.vehicle.stock).localeCompare(clean(b.vehicle.stock));
    });
  if (!ranked.length) return { match: null, reason: 'no-reliable-similar-auto1-vehicle', ranked: [] };
  return { match: ranked[0].vehicle, score: ranked[0].score, reasons: ranked[0].reasons, ranked: ranked.slice(0, 5) };
}

function isAvailableFeedVehicle(raw) {
  const status = normalized(raw?.availability || raw?.status || '');
  if (raw?.sold === true || raw?.available === false || raw?.isAvailable === false) return false;
  if (['sold', 'unavailable', 'deleted', 'removed', 'reserved'].includes(status)) return false;
  return raw?.available === true || raw?.isAvailable === true || ['available', 'in stock', 'instock', 'active'].includes(status);
}

module.exports = { specsFromOlxAdvert, specsFromVehicle, scoreReplacement, selectReplacement, isAvailableFeedVehicle };
