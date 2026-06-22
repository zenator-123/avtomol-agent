const INDEX_CACHE = new WeakMap();

const CYRILLIC_MAP = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sht",
  ъ: "a",
  ь: "",
  ю: "yu",
  я: "ya",
};

const CAR_MAKES = {
  "alfa romeo": ["alfa romeo", "alfa", "алфа ромео", "алфа"],
  audi: ["audi", "ауди"],
  bmw: ["bmw", "бмв"],
  chevrolet: ["chevrolet", "chevy", "шевролет"],
  chrysler: ["chrysler", "крайслер"],
  citroen: ["citroen", "citroën", "ситроен"],
  dacia: ["dacia", "дачия"],
  daewoo: ["daewoo", "деу"],
  daihatsu: ["daihatsu", "дайхатсу"],
  fiat: ["fiat", "фиат"],
  ford: ["ford", "форд"],
  honda: ["honda", "хонда"],
  hyundai: ["hyundai", "хюндай", "хундай"],
  isuzu: ["isuzu", "исузу"],
  iveco: ["iveco", "ивеко"],
  jaguar: ["jaguar", "ягуар"],
  jeep: ["jeep", "джип"],
  kia: ["kia", "киа"],
  lancia: ["lancia", "ланча"],
  "land rover": ["land rover", "ленд ровър", "ланд ровър"],
  lexus: ["lexus", "лексус"],
  mazda: ["mazda", "мазда"],
  "mercedes-benz": ["mercedes benz", "mercedes-benz", "mercedes", "benz", "мерцедес", "мерцедес бенц"],
  mini: ["mini", "мини"],
  mitsubishi: ["mitsubishi", "мицубиши"],
  nissan: ["nissan", "нисан"],
  opel: ["opel", "опел"],
  peugeot: ["peugeot", "пежо"],
  pontiac: ["pontiac", "понтиак"],
  renault: ["renault", "рено"],
  rover: ["rover", "ровър"],
  saab: ["saab", "сааб"],
  seat: ["seat", "сеат"],
  skoda: ["skoda", "škoda", "шкода"],
  subaru: ["subaru", "субару"],
  suzuki: ["suzuki", "сузуки"],
  toyota: ["toyota", "тойота"],
  volkswagen: ["volkswagen", "vw", "vag", "фолксваген", "голф", "пасат"],
  volvo: ["volvo", "волво"],
};

const MODEL_ALIASES = [
  "1 series",
  "3 series",
  "5 series",
  "7 series",
  "a1",
  "a3",
  "a4",
  "a5",
  "a6",
  "a7",
  "a8",
  "astra",
  "auris",
  "berlingo",
  "caddy",
  "civic",
  "corolla",
  "doblo",
  "ducato",
  "e class",
  "e90",
  "e91",
  "e92",
  "e93",
  "fabia",
  "fiesta",
  "focus",
  "golf",
  "insignia",
  "megane",
  "octavia",
  "passat",
  "polo",
  "qashqai",
  "rav4",
  "sprinter",
  "transit",
  "а3",
  "а4",
  "а6",
  "астра",
  "аурис",
  "берлинго",
  "голф",
  "добло",
  "дукато",
  "корола",
  "меган",
  "октавия",
  "пасат",
  "поло",
  "рав4",
  "спринтер",
  "транзит",
  "фабия",
  "фиеста",
  "фокус",
  "цивик",
];

const PART_TYPES = {
  tires: [
    "гума",
    "гуми",
    "летни гуми",
    "зимни гуми",
    "всесезонни гуми",
    "tire",
    "tires",
    "tyre",
    "tyres",
    "reifen",
    "gumi",
  ],
  oils: [
    "масло",
    "масла",
    "моторно масло",
    "консумативи",
    "антифриз",
    "чистачки",
    "крушки",
    "oil",
    "oils",
    "motor oil",
    "antifreeze",
    "konsumativi",
  ],
  filters: [
    "филтър",
    "филтри",
    "маслен филтър",
    "въздушен филтър",
    "горивен филтър",
    "филтър купе",
    "filter",
    "filters",
    "filtri",
  ],
  brakes: [
    "спирачки",
    "накладки",
    "накладка",
    "спирачни накладки",
    "дискове",
    "диск",
    "спирачен диск",
    "спирачни дискове",
    "апарат",
    "спирачен апарат",
    "brake",
    "brakes",
    "pads",
    "brake pads",
    "disc",
    "discs",
    "spirachki",
    "nakladki",
    "nakladka",
  ],
  belts: [
    "ремък",
    "ремъци",
    "ангренаж",
    "ангренажен ремък",
    "пистов ремък",
    "водна помпа",
    "belt",
    "belts",
    "timing belt",
    "water pump",
    "remak",
    "remaci",
  ],
  suspension: [
    "окачване",
    "амортисьор",
    "амортисьори",
    "носач",
    "носачи",
    "шарнир",
    "шарнири",
    "биалетка",
    "биалетки",
    "тампон",
    "тампони",
    "suspension",
    "shock absorber",
    "absorber",
    "control arm",
    "ball joint",
    "stabilizer link",
    "okachvane",
    "nosach",
    "nosachi",
    "sharnir",
    "bialetka",
    "bialetki",
  ],
  battery: ["акумулатор", "акумулатори", "battery", "batteries", "batterie", "akumulator"],
  accessories: ["аксесоар", "аксесоари", "accessory", "accessories", "aksesoari"],
  parts: ["авточасти", "авто части", "част", "части", "part", "parts", "rezervni chasti"],
};

const TIRE_BRANDS = [
  "michelin",
  "continental",
  "goodyear",
  "dunlop",
  "pirelli",
  "bfgoodrich",
  "kleber",
  "semperit",
  "fulda",
  "general tire",
  "barum",
  "debica",
  "tigar",
  "nokian",
  "bridgestone",
  "vredestein",
  "toyo",
  "uniroyal",
  "matador",
  "firestone",
  "kumho",
  "nexen",
  "apollo",
  "gislaved",
  "cooper",
  "dayton",
  "kormoran",
  "taurus",
  "riken",
  "voyager",
  "roadstone",
  "nankang",
  "onyx",
  "austone",
  "linglong",
  "triangle",
  "sonix",
  "milever",
  "viking",
  "yokohama",
  "radar",
  "kraiburg",
  "recamic",
  "remedina",
  "gtk",
  "ceat",
  "sava",
  "leao",
  "hankook",
];

const SPECIFIC_PART_TERMS = [
  {
    key: "brakePads",
    partType: "brakes",
    terms: ["nakladki", "nakladka", "spirachni nakladki", "brake pads", "pads"],
  },
  {
    key: "brakeDiscs",
    partType: "brakes",
    terms: ["diskove", "disk", "spirachen disk", "spirachni diskove", "brake disc", "brake discs", "disc", "discs"],
  },
  {
    key: "controlArm",
    partType: "suspension",
    terms: ["nosach", "nosachi", "control arm", "control arms"],
  },
  {
    key: "ballJoint",
    partType: "suspension",
    terms: ["sharnir", "sharniri", "ball joint", "ball joints"],
  },
  {
    key: "stabilizerLink",
    partType: "suspension",
    terms: ["bialetka", "bialetki", "stabilizer link", "stabilizer links", "drop link", "drop links"],
  },
  {
    key: "shockAbsorber",
    partType: "suspension",
    terms: ["amortisor", "amortis or", "amortis ori", "shock absorber", "shock absorbers", "absorber", "absorbers"],
  },
  {
    key: "oilFilter",
    partType: "filters",
    terms: ["maslen filtar", "oil filter"],
  },
  {
    key: "airFilter",
    partType: "filters",
    terms: ["vazdushen filtar", "air filter"],
  },
  {
    key: "fuelFilter",
    partType: "filters",
    terms: ["goriven filtar", "fuel filter"],
  },
];

const CHEAPEST_ALIASES = [
  "най евтин",
  "най-евтин",
  "най евтини",
  "най-евтини",
  "евтин",
  "евтини",
  "nai evtin",
  "nai evtini",
  "nai-evtin",
  "nai-evtini",
  "evtin",
  "evtini",
  "cheap",
  "cheapest",
  "low price",
  "budget",
  "billig",
  "gunstig",
  "günstig",
];

const POLICY_ALIASES = [
  "контакт",
  "телефон",
  "вайбър",
  "viber",
  "whatsapp",
  "рамa",
  "рама",
  "vin",
  "талон",
  "доставка",
  "shipping",
  "delivery",
  "връщане",
  "return",
  "плащане",
  "payment",
];

const STOP_WORDS = new Set([
  "za",
  "na",
  "s",
  "i",
  "v",
  "ot",
  "do",
  "mi",
  "me",
  "da",
  "li",
  "molya",
  "tarsya",
  "namery",
  "namirete",
  "trqbva",
  "tryabva",
  "avtomobil",
  "kola",
  "car",
  "auto",
  "model",
  "godina",
  "year",
]);

function transliterateCyrillic(value) {
  return String(value || "").replace(/[А-Яа-яЁё]/g, (letter) => CYRILLIC_MAP[letter.toLowerCase()] || letter);
}

function normalizeText(value) {
  const source = String(value || "");
  if (!source.trim()) {
    return "";
  }

  return transliterateCyrillic(source)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .replace(/&/g, " and ")
    .replace(/['’`"]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function tokenize(value) {
  return normalizeText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function normalizeArray(values) {
  return Array.isArray(values) ? values.filter(Boolean) : [];
}

function hasPhrase(text, phrase) {
  const normalizedPhrase = normalizeText(phrase);
  if (!text || !normalizedPhrase) {
    return false;
  }

  const paddedText = ` ${text} `;
  const paddedPhrase = ` ${normalizedPhrase} `;
  if (paddedText.includes(paddedPhrase)) {
    return true;
  }

  const compactText = text.replace(/\s+/g, "");
  const compactPhrase = normalizedPhrase.replace(/\s+/g, "");
  return compactPhrase.length > 4 && compactText.includes(compactPhrase);
}

function collectMatches(text, dictionary) {
  const found = [];
  for (const [key, aliases] of Object.entries(dictionary)) {
    if (aliases.some((alias) => hasPhrase(text, alias))) {
      found.push(key);
    }
  }
  return found;
}

function extractYears(text) {
  const years = [];
  const matches = text.match(/\b(?:19|20)\d{2}\b/g) || [];
  for (const item of matches) {
    const year = Number(item);
    if (year >= 1950 && year <= 2035) {
      years.push(year);
    }
  }
  return [...new Set(years)];
}

function extractYearRanges(text) {
  const ranges = [];
  const patterns = [
    /(?:0?[1-9]|1[0-2])\s*[.\/-]\s*((?:19|20)\d{2})\s*[-–]\s*(?:0?[1-9]|1[0-2])?\s*[.\/-]?\s*((?:19|20)\d{2})?/g,
    /\b((?:19|20)\d{2})\s*[-–]\s*((?:19|20)\d{2})\b/g,
  ];

  for (const pattern of patterns) {
    let match = pattern.exec(text);
    while (match) {
      const from = Number(match[1]);
      const to = match[2] ? Number(match[2]) : 2035;
      if (from >= 1950 && to >= from) {
        ranges.push({ from, to });
      }
      match = pattern.exec(text);
    }
  }

  return ranges;
}

function yearMatches(ranges, years) {
  if (!years.length) {
    return true;
  }
  if (!ranges.length) {
    return true;
  }
  return years.some((year) => ranges.some((range) => year >= range.from && year <= range.to));
}

function extractTireSizes(text) {
  const sizes = new Set();
  const source = String(text || "");
  const normalized = normalizeText(text);
  const compactPatterns = [
    /\b(\d{3})\s*\/\s*(\d{2})\s*r?\s*(\d{2})\b/gi,
    /\b(\d{3})\s+(\d{2})\s*r\s*(\d{2})\b/gi,
    /\b(\d{3})\s+(\d{2})\s+(\d{2})\b/gi,
    /\b(\d{3})(\d{2})r(\d{2})\b/gi,
  ];

  for (const candidate of [source, normalized]) {
    for (const pattern of compactPatterns) {
      let match = pattern.exec(candidate);
      while (match) {
        sizes.add(`${match[1]}/${match[2]}R${match[3]}`);
        match = pattern.exec(candidate);
      }
    }
  }

  return [...sizes];
}

function extractSeason(text) {
  const normalized = normalizeText(text);
  if (hasPhrase(normalized, "zimni") || hasPhrase(normalized, "winter")) {
    return "winter";
  }
  if (hasPhrase(normalized, "letni") || hasPhrase(normalized, "summer")) {
    return "summer";
  }
  if (hasPhrase(normalized, "vsesezonni") || hasPhrase(normalized, "all season") || hasPhrase(normalized, "allseason")) {
    return "all-season";
  }
  return "";
}

function extractModelTokens(normalizedMessage, makes, partTypes, tireSizes) {
  const blocked = new Set([
    ...Object.values(CAR_MAKES).flatMap((aliases) => aliases.flatMap((alias) => tokenize(alias))),
    ...Object.values(PART_TYPES).flatMap((aliases) => aliases.flatMap((alias) => tokenize(alias))),
    ...CHEAPEST_ALIASES.flatMap((alias) => tokenize(alias)),
  ]);

  for (const tireSize of tireSizes) {
    for (const token of tokenize(tireSize)) {
      blocked.add(token);
    }
  }

  const tokens = tokenize(normalizedMessage).filter((token) => {
    if (STOP_WORDS.has(token) || blocked.has(token)) {
      return false;
    }
    if (/^(?:19|20)\d{2}$/.test(token)) {
      return false;
    }
    if (/^\d{1,3}$/.test(token)) {
      return false;
    }
    return token.length >= 2;
  });

  const aliasTokens = MODEL_ALIASES.flatMap((alias) => tokenize(alias)).filter((token) => hasPhrase(normalizedMessage, token));
  const mergedTokens = [...new Set([...tokens, ...aliasTokens])];

  if (!makes.length && !partTypes.length && !tireSizes.length && !mergedTokens.length) {
    return [];
  }

  return mergedTokens.slice(0, 9);
}

function detectTireBrand(normalizedMessage) {
  return TIRE_BRANDS.find((brand) => hasPhrase(normalizedMessage, brand)) || "";
}

function getProductHaystack(product) {
  return normalizeText(
    [
      product.name,
      product.title,
      product.category,
      product.productType,
      product.vendor,
      product.summary,
      product.description,
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

function isVehicleSeoPage(product) {
  return product?.source === "avtomol" && Number(product?.price || 0) <= 1;
}

function extractSpecificPartTerms(normalizedMessage) {
  return SPECIFIC_PART_TERMS.filter((group) => group.terms.some((term) => hasPhrase(normalizedMessage, normalizeText(term))));
}

function hasSpecificPartTerm(item, specificPartTerms) {
  if (!specificPartTerms.length) {
    return true;
  }

  return specificPartTerms.some((group) => group.terms.some((term) => hasPhrase(item.haystack, normalizeText(term))));
}

function isExactIdentifierSearch(criteria, item) {
  if (!criteria.normalized) {
    return false;
  }

  const identifiers = [
    item.product.sku,
    item.product.articleNumber,
    ...(Array.isArray(item.product.oemNumbers) ? item.product.oemNumbers : []),
  ]
    .map((value) => normalizeText(value))
    .filter(Boolean);

  return identifiers.some((identifier) => hasPhrase(identifier, criteria.normalized) || hasPhrase(criteria.normalized, identifier));
}

function lacksVehicleFitmentData(item) {
  return !item.makes.size && !item.yearRanges.length && !normalizeArray(item.product.models).length;
}

function inferProductPartTypes(product, haystack) {
  if (product.source === "diana-ltd.com") {
    return ["tires"];
  }

  const focusedText = normalizeText([product.name, product.title, product.handle, product.productType].join(" "));
  const rules = [
    { key: "filters", terms: ["filtar", "filtri", "filter", "maslen filtar", "vazdushen filtar", "goriven filtar"] },
    { key: "brakes", terms: ["spirachki", "nakladki", "diskove", "brake", "pads", "disc"] },
    { key: "belts", terms: ["remaci", "remak", "angrenazh", "vodna pompa", "belt", "timing"] },
    { key: "suspension", terms: ["okachvane", "amortisor", "nosach", "sharnir", "bialetka", "suspension"] },
    { key: "oils", terms: ["konsumativi", "maslo", "oil", "antifriz", "chistachki"] },
    { key: "battery", terms: ["akumulator", "battery", "batterie"] },
    { key: "tires", terms: ["gumi", "guma", "tire", "tyre", "reifen"] },
  ];

  const focusedMatches = rules.filter((rule) => rule.terms.some((term) => hasPhrase(focusedText, term))).map((rule) => rule.key);
  if (focusedMatches.length) {
    return [...new Set([...focusedMatches, "parts"])];
  }

  const broadMatches = collectMatches(haystack, PART_TYPES).filter((partType) => partType !== "parts");
  if (broadMatches.length && product.source !== "avtomol") {
    return [...new Set([...broadMatches, "parts"])];
  }

  return ["parts"];
}

function buildProductMeta(product) {
  const haystack = getProductHaystack(product);
  const partTypes = inferProductPartTypes(product, haystack);
  return {
    haystack,
    partTypes: new Set(partTypes),
    makes: new Set(normalizeArray(product.makes).map((item) => normalizeText(item))),
    modelTokens: new Set(tokenize([product.name, product.summary, product.description, product.handle].join(" "))),
    price: Number.isFinite(Number(product.price)) ? Number(product.price) : Number.POSITIVE_INFINITY,
    product,
    season: product.season || extractSeason(haystack),
    tireBrand: normalizeText(product.tireBrand || detectTireBrand(haystack)),
    tireSizes: new Set(normalizeArray(product.tireSizes).length ? product.tireSizes : extractTireSizes(haystack)),
    tokenSet: new Set(tokenize(haystack)),
    yearRanges: normalizeArray(product.yearRanges).length ? product.yearRanges : extractYearRanges([product.name, product.summary, product.description].join(" ")),
  };
}

function buildIndex(products) {
  if (INDEX_CACHE.has(products)) {
    return INDEX_CACHE.get(products);
  }

  const index = {
    items: products.map((product) => buildProductMeta(product)),
  };
  INDEX_CACHE.set(products, index);
  return index;
}

function parseCriteria(message) {
  const normalized = normalizeText(message);
  const makes = collectMatches(normalized, CAR_MAKES);
  const partTypes = collectMatches(normalized, PART_TYPES);
  const tireSizes = extractTireSizes(message);
  const years = extractYears(normalized);
  const tireSeason = extractSeason(normalized);
  const tireBrand = detectTireBrand(normalized);
  const specificPartTerms = extractSpecificPartTerms(normalized);

  if (tireSizes.length && !partTypes.includes("tires")) {
    partTypes.push("tires");
  }
  for (const group of specificPartTerms) {
    if (!partTypes.includes(group.partType)) {
      partTypes.push(group.partType);
    }
  }

  return {
    cheapest: CHEAPEST_ALIASES.some((alias) => hasPhrase(normalized, alias)),
    makes,
    modelTokens: extractModelTokens(normalized, makes, partTypes, tireSizes),
    normalized,
    partTypes: [...new Set(partTypes)],
    policyLike: POLICY_ALIASES.some((alias) => hasPhrase(normalized, alias)),
    specificPartTerms,
    tireBrand,
    tireSeason,
    tireSizes,
    tokens: [...new Set(tokenize(normalized))],
    years,
  };
}

function scoreProduct(item, criteria, options = {}) {
  const hasVehicleOrSpecificPartSearch =
    criteria.makes.length ||
    criteria.modelTokens.length ||
    criteria.years.length ||
    criteria.partTypes.some((partType) => partType !== "parts");

  if (isVehicleSeoPage(item.product) && hasVehicleOrSpecificPartSearch) {
    return null;
  }

  if (item.product.inStock === false) {
    return null;
  }

  const exactIdentifierSearch = isExactIdentifierSearch(criteria, item);
  const vehicleFitmentSearch = criteria.makes.length || criteria.modelTokens.length || criteria.years.length;
  if (
    item.product.source === "avtomol-parts" &&
    vehicleFitmentSearch &&
    lacksVehicleFitmentData(item) &&
    !exactIdentifierSearch
  ) {
    return null;
  }

  if (
    item.product.source === "avtomol-parts" &&
    criteria.specificPartTerms.length &&
    !hasSpecificPartTerm(item, criteria.specificPartTerms) &&
    !exactIdentifierSearch
  ) {
    return null;
  }

  let score = item.product.featured ? 1 : 0;
  let hits = 0;
  const matched = [];

  if (criteria.partTypes.length) {
    const partHits = criteria.partTypes.filter((partType) => item.partTypes.has(partType));
    const requestedSpecificPart = criteria.partTypes.some((partType) => partType !== "parts");
    if (!partHits.length && (options.strict !== false || requestedSpecificPart)) {
      return null;
    }
    if (partHits.length) {
      score += 42 + partHits.length * 8;
      hits += partHits.length;
      matched.push(partLabel(partHits[0]));
    }
  }

  if (criteria.makes.length) {
    const makeHits = criteria.makes.filter((make) => {
      if (item.makes.size) {
        return item.makes.has(make);
      }
      return hasPhrase(item.haystack, make);
    });
    const tireOnlySearch = criteria.tireSizes.length || criteria.partTypes.includes("tires");
    if (!makeHits.length && (options.strict !== false || !tireOnlySearch)) {
      return null;
    }
    if (makeHits.length) {
      score += 34 + makeHits.length * 6;
      hits += makeHits.length;
      matched.push(makeLabel(makeHits[0]));
    }
  }

  if (criteria.years.length) {
    if (!yearMatches(item.yearRanges, criteria.years) && options.strict !== false) {
      return null;
    }
    if (yearMatches(item.yearRanges, criteria.years)) {
      score += 18;
      hits += 1;
      matched.push(String(criteria.years[0]));
    }
  }

  if (criteria.tireSizes.length) {
    const sizeHits = criteria.tireSizes.filter((size) => item.tireSizes.has(size));
    if (!sizeHits.length && options.strict !== false) {
      return null;
    }
    if (sizeHits.length) {
      score += 38 + sizeHits.length * 10;
      hits += sizeHits.length;
      matched.push(sizeHits[0]);
    }
  }

  if (criteria.tireSeason) {
    if (item.season && item.season !== criteria.tireSeason && options.strict !== false) {
      return null;
    }
    if (item.season === criteria.tireSeason || hasPhrase(item.haystack, seasonLabel(criteria.tireSeason))) {
      score += 16;
      hits += 1;
      matched.push(seasonLabel(criteria.tireSeason));
    }
  }

  if (criteria.tireBrand) {
    if (item.tireBrand !== normalizeText(criteria.tireBrand) && !hasPhrase(item.haystack, criteria.tireBrand) && options.strict !== false) {
      return null;
    }
    if (item.tireBrand === normalizeText(criteria.tireBrand) || hasPhrase(item.haystack, criteria.tireBrand)) {
      score += 22;
      hits += 1;
      matched.push(criteria.tireBrand.toUpperCase());
    }
  }

  const modelTokenHits = criteria.modelTokens.filter((token) => item.modelTokens.has(token) || item.tokenSet.has(token));
  if (criteria.modelTokens.length) {
    if (!modelTokenHits.length && options.strict !== false) {
      return null;
    }
    score += Math.min(modelTokenHits.length, 5) * 8;
    hits += modelTokenHits.length;
    matched.push(...modelTokenHits.slice(0, 2));
  }

  const looseTokenHits = criteria.tokens.reduce((total, token) => total + (item.tokenSet.has(token) ? 1 : 0), 0);
  score += Math.min(looseTokenHits, 10) * 2;
  if (looseTokenHits) {
    hits += Math.min(looseTokenHits, 3);
  }

  if (criteria.normalized && hasPhrase(item.haystack, criteria.normalized)) {
    score += 80;
    hits += 2;
    matched.push("точен артикул/номер");
  }

  if (criteria.cheapest) {
    score += priceSortValue(item.price) > 0 ? Math.max(0, 24 - priceSortValue(item.price) / 3) : 4;
    matched.push("евтина оферта");
  }

  if (!hits && criteria.partTypes.length + criteria.makes.length + criteria.tireSizes.length > 0 && options.strict !== false) {
    return null;
  }

  return {
    hits,
    item,
    matchReason: [...new Set(matched.filter(Boolean))].slice(0, 5).join(" • "),
    price: item.price,
    score,
  };
}

function priceSortValue(price) {
  if (!Number.isFinite(price) || price <= 1) {
    return Number.POSITIVE_INFINITY;
  }
  return price;
}

function partLabel(partType) {
  const labels = {
    accessories: "аксесоари",
    battery: "акумулатор",
    belts: "ремъци/водна помпа",
    brakes: "спирачки",
    filters: "филтри",
    oils: "масла/консумативи",
    parts: "авточасти",
    suspension: "окачване",
    tires: "гуми",
  };
  return labels[partType] || partType;
}

function makeLabel(make) {
  return make === "mercedes-benz" ? "Mercedes-Benz" : make === "volkswagen" ? "Volkswagen" : make.toUpperCase();
}

function seasonLabel(season) {
  return {
    "all-season": "всесезонни",
    summer: "летни",
    winter: "зимни",
  }[season] || season;
}

function toSuggestion(result) {
  const product = result.item.product;
  return {
    ...product,
    matchReason: result.matchReason,
    price: Number.isFinite(result.price) ? result.price : product.price,
  };
}

function compareResults(left, right, criteria) {
  if (criteria.cheapest) {
    return (
      right.hits - left.hits ||
      priceSortValue(left.price) - priceSortValue(right.price) ||
      right.score - left.score ||
      String(left.item.product.name || "").localeCompare(String(right.item.product.name || ""))
    );
  }

  return (
    right.score - left.score ||
    right.hits - left.hits ||
    priceSortValue(left.price) - priceSortValue(right.price) ||
    String(left.item.product.name || "").localeCompare(String(right.item.product.name || ""))
  );
}

function searchRanked(products, message, limit = 4, options = {}) {
  const index = buildIndex(products);
  const criteria = parseCriteria(message);

  if (criteria.policyLike && !criteria.partTypes.length && !criteria.makes.length && !criteria.tireSizes.length) {
    return { criteria, results: [] };
  }

  const ranked = [];
  for (const item of index.items) {
    const result = scoreProduct(item, criteria, options);
    if (result) {
      ranked.push(result);
    }
  }

  ranked.sort((left, right) => compareResults(left, right, criteria));
  return { criteria, results: ranked.slice(0, Math.max(1, limit)) };
}

function searchProducts(products, message, limit = 4) {
  const strict = searchRanked(products, message, limit, { strict: true });
  if (strict.results.length) {
    return strict.results.map(toSuggestion);
  }

  const relaxed = searchRanked(products, message, limit, { strict: false });
  return relaxed.results.filter((result) => result.hits > 0).map(toSuggestion);
}

function buildOutfitSuggestions() {
  return [];
}

function pickFocusSuggestion(message, suggestions) {
  if (!Array.isArray(suggestions) || !suggestions.length) {
    return null;
  }

  const criteria = parseCriteria(message);
  const specificity =
    criteria.makes.length +
    criteria.partTypes.length +
    criteria.tireSizes.length +
    criteria.years.length +
    (criteria.tireBrand ? 1 : 0);

  return specificity >= 2 || suggestions.length === 1 ? suggestions[0] : null;
}

module.exports = {
  buildOutfitSuggestions,
  normalizeText,
  pickFocusSuggestion,
  searchProducts,
  tokenize,
};
