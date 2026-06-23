const { normalizeText, tokenize } = require("./catalog");

function normalizeArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function numericPrice(product) {
  const price = Number(product?.price);
  return Number.isFinite(price) ? price : 0;
}

function isVehicleSeoPage(product) {
  return product?.source === "avtomol" && numericPrice(product) <= 1;
}

function isTireProduct(product) {
  return product?.source === "avtomol-tyres" || normalizeArray(product?.partTypes).includes("tires");
}

function isPartProduct(product) {
  if (isTireProduct(product) || isVehicleSeoPage(product)) {
    return false;
  }

  return (
    product?.source === "avtomol-parts" ||
    normalizeText(product?.productType).includes("avtochasti") ||
    normalizeText(product?.category).includes("avtochasti")
  );
}

function productHaystack(product) {
  return normalizeText(
    [
      product.name,
      product.title,
      product.summary,
      product.description,
      product.vendor,
      product.category,
      product.productType,
      product.sku,
      product.articleNumber,
      product.handle,
      product.url,
      normalizeArray(product.tags).join(" "),
      normalizeArray(product.oemNumbers).join(" "),
      normalizeArray(product.makes).join(" "),
      normalizeArray(product.models).join(" "),
      normalizeArray(product.partTypes).join(" "),
      normalizeArray(product.tireSizes).join(" "),
      product.season,
    ].join(" ")
  );
}

const QUERY_STOP_WORDS = new Set([
  "za",
  "na",
  "ot",
  "s",
  "v",
  "i",
  "po",
  "for",
  "with",
  "the",
  "bmw",
  "vw",
  "vag",
]);

const SPECIFIC_PART_GROUPS = [
  {
    key: "timingBelt",
    terms: ["angrenazhen remak", "angrenazh", "remak", "remaci", "komplekti za smyana na angrenazh", "timing belt", "timing", "belt"],
    fallbackTerms: ["angrenazh", "komplekti za smyana na angrenazh", "remak", "remaci", "belt", "timing"],
  },
  {
    key: "brakePads",
    terms: ["nakladki", "nakladka", "spirachni nakladki", "brake pads", "pads"],
  },
  {
    key: "brakeDiscs",
    terms: ["spirachen disk", "spirachni diskove", "diskove", "disk", "brake disc", "brake discs"],
  },
  {
    key: "controlArm",
    terms: ["nosach", "nosachi", "control arm", "control arms"],
  },
  {
    key: "ballJoint",
    terms: ["sharnir", "sharniri", "ball joint", "ball joints"],
  },
  {
    key: "shockAbsorber",
    terms: ["amortisor", "amortis or", "amortis ori", "shock absorber", "shock absorbers"],
  },
  {
    key: "oilFilter",
    terms: ["maslen filtar", "oil filter"],
  },
  {
    key: "airFilter",
    terms: ["vazdushen filtar", "air filter"],
  },
  {
    key: "fuelFilter",
    terms: ["goriven filtar", "fuel filter"],
  },
  {
    key: "waterPump",
    terms: ["vodna pompa", "water pump", "pompa"],
  },
  {
    key: "sparkPlug",
    terms: ["svesht", "sveshti", "zapalitelna svesht", "spark plug", "spark plugs"],
  },
  {
    key: "bulb",
    terms: ["krushka", "krushki", "lamp", "bulb", "bulbs"],
  },
  {
    key: "battery",
    terms: ["akumulator", "akumulatori", "battery", "batteries"],
  },
  {
    key: "wheelBolt",
    terms: ["bolt dzhanta", "boltv dzhanta", "gaika dzhanta", "bolto ve dzhanti", "wheel bolt", "wheel nut"],
  },
  {
    key: "valve",
    terms: ["klapan", "klapani", "valve", "valves"],
  },
  {
    key: "gasket",
    terms: ["diftung", "garnitura", "uplatnenie", "seal", "gasket"],
  },
];

function hasPhrase(text, phrase) {
  const normalizedText = ` ${normalizeText(text)} `;
  const normalizedPhrase = normalizeText(phrase);
  if (!normalizedPhrase) {
    return false;
  }
  return normalizedText.includes(` ${normalizedPhrase} `) || normalizedText.includes(normalizedPhrase);
}

function extractSpecificPartGroups(query) {
  const normalizedQuery = normalizeText(query);
  return SPECIFIC_PART_GROUPS.filter((group) => group.terms.some((term) => hasPhrase(normalizedQuery, term)));
}

function matchesSpecificPartGroups(product, groups) {
  if (!groups.length) {
    return true;
  }

  const haystack = productHaystack(product);
  return groups.some((group) => {
    const terms = group.fallbackTerms || group.terms;
    return terms.some((term) => hasPhrase(haystack, term));
  });
}

function parseTireSize(size) {
  const match = String(size || "").match(/(\d{3})\/(\d{2})R(\d{2})/i);
  if (!match) {
    return null;
  }

  return {
    width: match[1],
    height: match[2],
    rim: match[3],
  };
}

function extractTireSizeFromText(text) {
  const match = String(text || "").match(/(\d{3})\s*\/\s*(\d{2})\s*r\s*(\d{2})/i);
  if (!match) {
    return null;
  }

  return {
    width: match[1],
    height: match[2],
    rim: match[3],
  };
}

function extractSeasonFromText(text) {
  const normalized = normalizeText(text);
  if (hasPhrase(normalized, "zimni") || hasPhrase(normalized, "winter")) {
    return "winter";
  }
  if (hasPhrase(normalized, "letni") || hasPhrase(normalized, "summer")) {
    return "summer";
  }
  if (
    hasPhrase(normalized, "vsesezonni") ||
    hasPhrase(normalized, "vsesezonni gumi") ||
    hasPhrase(normalized, "all season") ||
    hasPhrase(normalized, "all-season")
  ) {
    return "all-season";
  }
  return "";
}

function addOption(map, value) {
  const key = String(value || "").trim();
  if (!key) {
    return;
  }
  map.set(key, (map.get(key) || 0) + 1);
}

function mapToOptions(map, numeric = false) {
  const items = [...map.entries()].map(([value, count]) => ({ value, count }));
  items.sort((left, right) => {
    if (numeric) {
      return Number(left.value) - Number(right.value);
    }
    return left.value.localeCompare(right.value);
  });
  return items;
}

function buildCatalogOptions(products) {
  const tireBrands = new Map();
  const tireWidths = new Map();
  const tireHeights = new Map();
  const tireRims = new Map();
  const tireSeasons = new Map();
  const partCategories = new Map();
  const partVendors = new Map();

  let tireCount = 0;
  let partCount = 0;

  for (const product of products) {
    if (isTireProduct(product)) {
      tireCount += 1;
      addOption(tireBrands, product.vendor || product.tireBrand);
      addOption(tireSeasons, product.season);
      for (const size of normalizeArray(product.tireSizes)) {
        const parsed = parseTireSize(size);
        if (parsed) {
          addOption(tireWidths, parsed.width);
          addOption(tireHeights, parsed.height);
          addOption(tireRims, parsed.rim);
        }
      }
      continue;
    }

    if (isPartProduct(product)) {
      partCount += 1;
      addOption(partCategories, product.category || product.productType);
      addOption(partVendors, product.vendor);
    }
  }

  return {
    parts: {
      count: partCount,
      categories: mapToOptions(partCategories).slice(0, 300),
      vendors: mapToOptions(partVendors).slice(0, 300),
    },
    tires: {
      count: tireCount,
      brands: mapToOptions(tireBrands),
      widths: mapToOptions(tireWidths, true),
      heights: mapToOptions(tireHeights, true),
      rims: mapToOptions(tireRims, true),
      seasons: mapToOptions(tireSeasons),
    },
  };
}

const MAKE_LABELS = {
  "alfa romeo": "Alfa Romeo",
  audi: "Audi",
  bmw: "BMW",
  chevrolet: "Chevrolet",
  chrysler: "Chrysler",
  citroen: "Citroen",
  dacia: "Dacia",
  daewoo: "Daewoo",
  daihatsu: "Daihatsu",
  fiat: "Fiat",
  ford: "Ford",
  honda: "Honda",
  hyundai: "Hyundai",
  isuzu: "Isuzu",
  iveco: "Iveco",
  jaguar: "Jaguar",
  jeep: "Jeep",
  kia: "Kia",
  lancia: "Lancia",
  "land rover": "Land Rover",
  lexus: "Lexus",
  mazda: "Mazda",
  "mercedes-benz": "Mercedes-Benz",
  mini: "Mini",
  mitsubishi: "Mitsubishi",
  nissan: "Nissan",
  opel: "Opel",
  peugeot: "Peugeot",
  pontiac: "Pontiac",
  renault: "Renault",
  rover: "Rover",
  saab: "Saab",
  seat: "Seat",
  skoda: "Skoda",
  smart: "Smart",
  subaru: "Subaru",
  suzuki: "Suzuki",
  toyota: "Toyota",
  volkswagen: "Volkswagen",
  volvo: "Volvo",
};

const PART_LABELS = {
  belts: "Ремъци и водна помпа",
  brakes: "Спирачки",
  filters: "Филтри",
  oils: "Масла и консумативи",
  parts: "Всички части",
  suspension: "Окачване",
};

const FALLBACK_MODELS = {
  "alfa romeo": ["147", "156", "159", "Giulietta", "Mito"],
  audi: ["A3", "A4", "A5", "A6", "A8", "Q5", "Q7"],
  bmw: ["E36", "E39", "E46", "E60", "E90", "F10", "X3", "X5"],
  chevrolet: ["Aveo", "Captiva", "Cruze", "Lacetti", "Spark"],
  chrysler: ["300C", "PT Cruiser", "Voyager"],
  citroen: ["Berlingo", "C3", "C4", "C5", "Jumper"],
  dacia: ["Dokker", "Duster", "Logan", "Sandero"],
  daewoo: ["Kalos", "Lanos", "Matiz", "Nubira"],
  daihatsu: ["Cuore", "Feroza", "Sirion", "Terios"],
  fiat: ["Bravo", "Doblo", "Ducato", "Panda", "Punto", "Stilo"],
  ford: ["C-Max", "Fiesta", "Focus", "Galaxy", "Kuga", "Mondeo", "Transit"],
  honda: ["Accord", "Civic", "CR-V", "Jazz"],
  hyundai: ["Accent", "i20", "i30", "Santa Fe", "Tucson"],
  isuzu: ["D-Max", "Trooper"],
  iveco: ["Daily"],
  jaguar: ["S-Type", "X-Type", "XF", "XJ"],
  jeep: ["Cherokee", "Compass", "Grand Cherokee", "Renegade", "Wrangler"],
  kia: ["Ceed", "Rio", "Sorento", "Sportage"],
  lancia: ["Delta", "Musa", "Ypsilon"],
  "land rover": ["Discovery", "Freelander", "Range Rover"],
  lexus: ["IS", "GS", "RX"],
  mazda: ["2", "3", "5", "6", "CX-5", "MX-5"],
  "mercedes-benz": ["A-Class", "C-Class", "E-Class", "S-Class", "Sprinter", "Vito"],
  mini: ["Cooper", "Countryman", "One"],
  mitsubishi: ["Colt", "L200", "Lancer", "Outlander", "Pajero"],
  nissan: ["Almera", "Juke", "Micra", "Navara", "Primera", "Qashqai", "X-Trail"],
  opel: ["Astra", "Corsa", "Insignia", "Meriva", "Vectra", "Zafira"],
  peugeot: ["206", "207", "307", "308", "407", "Partner"],
  pontiac: ["Firebird", "Trans Sport", "Vibe"],
  renault: ["Clio", "Kangoo", "Laguna", "Megane", "Scenic", "Trafic"],
  rover: ["25", "45", "75"],
  saab: ["9-3", "9-5"],
  seat: ["Alhambra", "Ibiza", "Leon", "Toledo"],
  skoda: ["Fabia", "Octavia", "Rapid", "Roomster", "Superb", "Yeti"],
  smart: ["Forfour", "Fortwo"],
  subaru: ["Forester", "Impreza", "Legacy", "Outback"],
  suzuki: ["Grand Vitara", "Ignis", "Swift", "SX4", "Vitara"],
  toyota: ["Auris", "Avensis", "Corolla", "Land Cruiser", "RAV4", "Yaris"],
  volkswagen: ["Caddy", "Golf", "Passat", "Polo", "Sharan", "Tiguan", "Touran", "Transporter"],
  volvo: ["S40", "S60", "S80", "V40", "V50", "V70", "XC60", "XC90"],
};

const FALLBACK_YEARS = ["1995 - 2000", "2001 - 2005", "2006 - 2010", "2011 - 2015", "2016 -"];

function fallbackSearchUrl(makeLabel, modelLabel, yearLabel, partLabel) {
  return `/search?q=${encodeURIComponent([makeLabel, modelLabel, yearLabel, partLabel].filter(Boolean).join(" "))}`;
}

function buildFallbackModel(makeKey, modelLabel) {
  const makeLabel = MAKE_LABELS[makeKey] || makeKey;
  return {
    key: `${makeKey}-${modelLabel}`,
    label: modelLabel,
    years: FALLBACK_YEARS.map((year) => ({
      key: year,
      label: year,
      parts: Object.entries(PART_LABELS).map(([partKey, partLabel]) => ({
        key: partKey,
        label: partLabel,
        url: fallbackSearchUrl(makeLabel, modelLabel, year, partLabel),
      })),
    })),
  };
}

function yearRangeLabel(range) {
  if (!range?.from) {
    return "Всички години";
  }
  return range.to && range.to < 2035 ? `${range.from} - ${range.to}` : `${range.from} -`;
}

function isVehiclePage(product) {
  const name = normalizeText(product?.name);
  const handle = normalizeText(product?.handle);
  const model = normalizeText(normalizeArray(product?.models)[0]);

  if (handle.includes("obshtina") || handle.includes("unique avtochasti") || name.includes("avtochasti po vin")) {
    return false;
  }

  if (model.includes("avtochasti po vin") || model.includes("obshtina")) {
    return false;
  }

  return (
    product?.source === "avtomol" &&
    numericPrice(product) <= 1 &&
    normalizeArray(product.makes).length &&
    normalizeArray(product.models).length &&
    normalizeArray(product.yearRanges).length
  );
}

function buildVehicleTree(products) {
  const makes = new Map();

  for (const product of products) {
    if (!isVehiclePage(product)) {
      continue;
    }

    const make = normalizeArray(product.makes)[0];
    const model = normalizeArray(product.models)[0];
    if (!make || !model) {
      continue;
    }

    const range = normalizeArray(product.yearRanges)[0] || {};
    const yearKey = yearRangeLabel(range);
    const partTypes = normalizeArray(product.partTypes).filter((partType) => PART_LABELS[partType]);

    if (!makes.has(make)) {
      makes.set(make, {
        key: make,
        label: MAKE_LABELS[make] || make,
        models: new Map(),
      });
    }

    const makeItem = makes.get(make);
    if (!makeItem.models.has(model)) {
      makeItem.models.set(model, {
        key: model,
        label: model.replace(new RegExp(`^${MAKE_LABELS[make] || make}\\s+`, "i"), ""),
        years: new Map(),
      });
    }

    const modelItem = makeItem.models.get(model);
    if (!modelItem.years.has(yearKey)) {
      modelItem.years.set(yearKey, {
        key: yearKey,
        label: yearKey,
        parts: new Map(),
      });
    }

    const yearItem = modelItem.years.get(yearKey);
    for (const partType of partTypes.length ? partTypes : ["parts"]) {
      if (!yearItem.parts.has(partType)) {
        yearItem.parts.set(partType, {
          key: partType,
          label: PART_LABELS[partType] || partType,
          url: product.url,
        });
      }
    }
  }

  for (const [makeKey, modelLabels] of Object.entries(FALLBACK_MODELS)) {
    if (!makes.has(makeKey)) {
      makes.set(makeKey, {
        key: makeKey,
        label: MAKE_LABELS[makeKey] || makeKey,
        models: new Map(),
      });
    }

    const makeItem = makes.get(makeKey);
    for (const modelLabel of modelLabels) {
      const existing = [...makeItem.models.values()].some((model) => normalizeText(model.label).includes(normalizeText(modelLabel)));
      if (!existing) {
        const fallbackModel = buildFallbackModel(makeKey, modelLabel);
        makeItem.models.set(fallbackModel.key, fallbackModel);
      }
    }
  }

  return {
    makes: [...makes.values()]
      .sort((left, right) => left.label.localeCompare(right.label))
      .map((make) => ({
        key: make.key,
        label: make.label,
        count: make.models.size,
        models: [...make.models.values()]
          .sort((left, right) => left.label.localeCompare(right.label))
          .map((model) => ({
            key: model.key,
            label: model.label,
            years: [...model.years.values()]
              .sort((left, right) => left.label.localeCompare(right.label))
              .map((year) => ({
                key: year.key,
                label: year.label,
                parts: [...year.parts.values()].sort((left, right) => left.label.localeCompare(right.label)),
              })),
          })),
      })),
  };
}

function compactProduct(product, score) {
  return {
    id: product.id,
    name: product.name,
    vendor: product.vendor || "",
    category: product.category || product.productType || "",
    price: product.price,
    currency: product.currency || "BGN",
    inStock: product.inStock !== false,
    stockText: product.stockText || "",
    url: product.source === "avtomol-tyres" ? tireSearchUrl(product) : product.url,
    image: product.image || product.imageSrc || "",
    sku: product.sku || product.articleNumber || "",
    articleNumber: product.articleNumber || product.sku || "",
    oemNumbers: normalizeArray(product.oemNumbers).slice(0, 8),
    tireSizes: normalizeArray(product.tireSizes),
    tireBrand: product.tireBrand || "",
    season: product.season || "",
    summary: product.summary || "",
    score,
  };
}

function tireSearchUrl(product) {
  const query = [product.vendor, ...normalizeArray(product.tireSizes), seasonLabel(product.season), "гуми"]
    .filter(Boolean)
    .join(" ");
  return `https://avtomol.com/search?q=${encodeURIComponent(query || "гуми")}`;
}

function seasonLabel(season) {
  return {
    "all-season": "всесезонни",
    summer: "летни",
    winter: "зимни",
  }[season] || "";
}

function scoreByQuery(product, query) {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) {
    return 1;
  }

  const haystack = productHaystack(product);
  const queryTokens = tokenize(normalizedQuery).filter((token) => {
    if (token.length < 3 || QUERY_STOP_WORDS.has(token)) {
      return false;
    }
    if (/^\d{1,2}$/.test(token) || /^(?:19|20)\d{2}g?$/.test(token)) {
      return false;
    }
    return true;
  });
  let score = 0;

  if (haystack.includes(normalizedQuery)) {
    score += 100;
  }

  const identifiers = [product.sku, product.articleNumber, ...normalizeArray(product.oemNumbers)]
    .map((value) => normalizeText(value))
    .filter((value) => value.length >= 3);
  if (identifiers.some((identifier) => identifier && (identifier.includes(normalizedQuery) || normalizedQuery.includes(identifier)))) {
    score += 160;
  }

  for (const token of queryTokens) {
    if (haystack.includes(token)) {
      score += 10;
    }
  }

  return score;
}

function matchesTireFilters(product, filters) {
  const sizes = normalizeArray(product.tireSizes).map(parseTireSize).filter(Boolean);
  if (filters.width && !sizes.some((size) => size.width === filters.width)) {
    return false;
  }
  if (filters.height && !sizes.some((size) => size.height === filters.height)) {
    return false;
  }
  if (filters.rim && !sizes.some((size) => size.rim === filters.rim)) {
    return false;
  }
  if (filters.brand && normalizeText(product.vendor) !== normalizeText(filters.brand)) {
    return false;
  }
  if (filters.season && product.season !== filters.season) {
    return false;
  }
  return true;
}

function buildQueryFromParams(params) {
  return [
    params.get("q"),
    params.get("make"),
    params.get("model"),
    params.get("year"),
    params.get("engine"),
    params.get("vin"),
    params.get("part"),
  ]
    .filter(Boolean)
    .join(" ");
}

function searchCatalog(products, params) {
  const type = params.get("type") === "tires" ? "tires" : "parts";
  const limit = Math.max(1, Math.min(100, Number(params.get("limit") || 24)));
  const query = buildQueryFromParams(params);
  const specificPartGroups = type === "parts" ? extractSpecificPartGroups(query) : [];
  const queryTireSize = extractTireSizeFromText(query);
  const tireFilters = {
    brand: params.get("brand") || "",
    height: params.get("height") || queryTireSize?.height || "",
    rim: params.get("rim") || queryTireSize?.rim || "",
    season: params.get("season") || extractSeasonFromText(query),
    width: params.get("width") || queryTireSize?.width || "",
  };

  const scored = [];
  for (const product of products) {
    if (type === "tires") {
      if (!isTireProduct(product) || !matchesTireFilters(product, tireFilters)) {
        continue;
      }
    } else if (!isPartProduct(product)) {
      continue;
    }

    if (type === "parts" && !matchesSpecificPartGroups(product, specificPartGroups)) {
      continue;
    }

    const score = scoreByQuery(product, query);
    if (query && score <= 0) {
      continue;
    }
    scored.push({ product, score });
  }

  const relaxedSpecific = type === "parts" && specificPartGroups.length && !scored.length;
  if (relaxedSpecific) {
    for (const product of products) {
      if (!isPartProduct(product) || !matchesSpecificPartGroups(product, specificPartGroups)) {
        continue;
      }

      scored.push({ product, score: scoreByQuery(product, query) + 5 });
    }
  }

  scored.sort((left, right) => {
    return (
      right.score - left.score ||
      Number(right.product.inStock === true) - Number(left.product.inStock === true) ||
      numericPrice(left.product) - numericPrice(right.product) ||
      String(left.product.name || "").localeCompare(String(right.product.name || ""))
    );
  });

  return {
    count: scored.length,
    items: scored.slice(0, limit).map(({ product, score }) => compactProduct(product, score)),
    needsVin: type === "parts" && Boolean(query) && scored.length === 0,
    relaxedSpecific,
    type,
  };
}

module.exports = {
  buildCatalogOptions,
  buildVehicleTree,
  searchCatalog,
};
