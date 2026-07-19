function text(value) {
  return String(value ?? "").trim();
}

function number(value) {
  const parsed = Number(String(value ?? "").replace(/[^0-9.,-]/g, "").replace(/,/g, "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function extractEngine(vehicle) {
  // Engine labels are learned only from the structured title. Descriptions often
  // contain decimal prices, paint measurements or damage sizes that are not engines.
  const source = text(vehicle.title);
  const match = source.match(/\b(\d[.,]\d)\s*(TDI|TDCI|D|CDI|DCI|HDI|CRDI|JTD|DTEC|D-4D|TSI|TFSI|ECOBOOST|HYBRID)?\b/i);
  if (!match) return "неуточнен";
  return `${match[1].replace(",", ".")}${match[2] ? ` ${match[2].toUpperCase()}` : ""}`;
}

function mileage(value) {
  const parsed = number(value);
  return parsed > 0 ? Math.round(parsed) : 0;
}

function isAvailable(vehicle) {
  const status = text(vehicle.status || vehicle.availability).toLowerCase();
  return vehicle.available !== false && vehicle.sold !== true && !["sold", "unavailable", "deleted", "removed"].includes(status);
}

function scoreVehicle(vehicle) {
  let score = 0;
  const km = mileage(vehicle.mileage);
  const fuel = text(vehicle.fuel || vehicle.engineType).toLowerCase();
  const condition = `${text(vehicle.condition)} ${text(vehicle.damageSummary)} ${text(vehicle.description)}`.toLowerCase();
  if (isAvailable(vehicle)) score += 40;
  if (km >= 100000 && km <= 200000) score += 25;
  else if (km > 0 && km < 100000) score += 22;
  else if (km > 200000 && km <= 230000) score += 8;
  if (/diesel|дизел/.test(fuel)) score += 15;
  if (/ready|готов|retail/.test(condition)) score += 12;
  if (!/severe|тежк|major|сериоз/.test(condition)) score += 8;
  return score;
}

function learnVehicles(vehicles, generatedAt = new Date().toISOString(), options = {}) {
  const unique = new Map();
  for (const vehicle of Array.isArray(vehicles) ? vehicles : []) {
    const id = text(vehicle.incomingNumber || vehicle.external_id || vehicle.externalId || vehicle.id);
    if (id && !unique.has(id)) unique.set(id, vehicle);
  }
  const groups = new Map();
  for (const vehicle of unique.values()) {
    const brand = text(vehicle.brand || vehicle.make) || "Неуточнена марка";
    const model = text(vehicle.model) || "Неуточнен модел";
    const engine = extractEngine(vehicle);
    const key = `${brand}\u0000${model}\u0000${engine}`;
    const group = groups.get(key) || { brand, model, engine, count: 0, available: 0, years: [], mileages: [], prices: [] };
    group.count += 1;
    if (isAvailable(vehicle)) group.available += 1;
    const year = number(vehicle.year);
    const km = mileage(vehicle.mileage);
    const price = number(vehicle.price);
    if (year >= 1900 && year <= 2100) group.years.push(Math.round(year));
    if (km) group.mileages.push(km);
    if (price) group.prices.push(price);
    groups.set(key, group);
  }
  const models = [...groups.values()].map((group) => ({
    brand: group.brand, model: group.model, engine: group.engine, count: group.count, available: group.available,
    yearMin: group.years.length ? Math.min(...group.years) : null,
    yearMax: group.years.length ? Math.max(...group.years) : null,
    medianMileage: median(group.mileages) || null,
    medianPrice: median(group.prices) || null,
    priceMin: group.prices.length ? Math.min(...group.prices) : null,
    priceMax: group.prices.length ? Math.max(...group.prices) : null,
  })).sort((a, b) => b.available - a.available || a.brand.localeCompare(b.brand) || a.model.localeCompare(b.model));
  const recommendations = [...unique.values()].filter(isAvailable).map((vehicle) => ({
    incomingNumber: text(vehicle.incomingNumber || vehicle.external_id || vehicle.externalId || vehicle.id),
    title: text(vehicle.title || vehicle.name), brand: text(vehicle.brand || vehicle.make), model: text(vehicle.model),
    year: number(vehicle.year) || null, mileage: mileage(vehicle.mileage) || null, price: number(vehicle.price) || null,
    engine: extractEngine(vehicle), score: scoreVehicle(vehicle),
  })).sort((a, b) => b.score - a.score || (a.mileage || Infinity) - (b.mileage || Infinity)).slice(0, 30);
  return {
    generatedAt,
    catalogSource: options.catalogSource || "неуточнен",
    completeAuto1Catalog: unique.size >= Number(options.expectedCatalogSize || 25000),
    source: "Текущият реален автомобилен каталог на AvtoMol",
    rules: [
      "Обобщенията не заменят данните на конкретната обява.",
      "Препоръчват се само налични автомобили с реален входящ номер.",
      "Не се измислят оборудване, тест-драйв, щети, цена, пробег или срок за доставка.",
    ],
    totals: {
      uniqueVehicles: unique.size,
      availableVehicles: [...unique.values()].filter(isAvailable).length,
      brands: new Set([...unique.values()].map((vehicle) => text(vehicle.brand || vehicle.make)).filter(Boolean)).size,
      learnedModelEngineGroups: models.length,
    },
    models,
    recommendations,
  };
}

function buildVehicleKnowledgeContext(knowledge) {
  if (!knowledge?.totals) return "";
  const lines = (knowledge.models || []).slice(0, 40).map((item) =>
    `- ${item.brand} ${item.model} ${item.engine}: ${item.available} налични, ${item.yearMin || "?"}-${item.yearMax || "?"}, медианен пробег ${item.medianMileage || "?"} км, медианна цена ${item.medianPrice || "?"}`
  );
  return [`Научен автомобилен справочник (${knowledge.generatedAt}): ${knowledge.totals.availableVehicles} налични, ${knowledge.totals.brands} марки.`, "Използвай го само за сравнение; за конкретна кола използвай нейната текуща обява.", ...lines].join("\n");
}

module.exports = { buildVehicleKnowledgeContext, extractEngine, learnVehicles, scoreVehicle };
