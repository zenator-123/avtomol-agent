const fs = require("node:fs/promises");
const path = require("node:path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(PROJECT_ROOT, "data");
const WORK_DIR = path.join(PROJECT_ROOT, "work");
const AVTOMOL_BASE_URL = "https://avtomol.com";
const DIANA_BASE_URL = "https://diana-ltd.com";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED || "0";

const AVTOMOL_MAX_PAGES = Number(process.env.AVTOMOL_MAX_PAGES || 24);
const DIANA_MAX_PAGES = Number(process.env.DIANA_MAX_PAGES || 3);

const CAR_MAKES = [
  "Alfa Romeo",
  "Audi",
  "BMW",
  "Chevrolet",
  "Chrysler",
  "Citroen",
  "Dacia",
  "Daewoo",
  "Daihatsu",
  "Fiat",
  "Ford",
  "Honda",
  "Hyundai",
  "Iveco",
  "Isuzu",
  "Jaguar",
  "Jeep",
  "Kia",
  "Land Rover",
  "Lancia",
  "Lexus",
  "Mazda",
  "Mercedes-Benz",
  "Mini",
  "Mitsubishi",
  "Nissan",
  "Opel",
  "Peugeot",
  "Pontiac",
  "Renault",
  "Rover",
  "Saab",
  "Seat",
  "Skoda",
  "Subaru",
  "Suzuki",
  "Toyota",
  "Volkswagen",
  "Volvo",
];

const PART_RULES = [
  { key: "tires", label: "Гуми", words: ["гуми", "гума", "tire", "tyre", "reifen"] },
  { key: "oils", label: "Масла и консумативи", words: ["масла", "масло", "консумативи", "антифриз", "чистачки", "крушки"] },
  { key: "filters", label: "Филтри", words: ["филтри", "филтър", "маслен филтър", "въздушен филтър"] },
  { key: "brakes", label: "Спирачки", words: ["спирачки", "накладки", "дискове", "спирачен"] },
  { key: "belts", label: "Ремъци и водна помпа", words: ["ремъци", "ремък", "ангренаж", "водна помпа", "пистов"] },
  { key: "suspension", label: "Окачване", words: ["окачване", "амортисьор", "носач", "биалетка", "шарнир"] },
  { key: "battery", label: "Акумулатори", words: ["акумулатор", "акумулатори", "battery"] },
  { key: "accessories", label: "Аксесоари", words: ["аксесоар", "аксесоари", "accessory"] },
  { key: "parts", label: "Авточасти", words: ["авточасти", "авто части", "части", "част"] },
];

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " ")
    .replace(/[^a-zA-Z0-9А-Яа-яЁё]+/g, " ")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripHtml(value) {
  return decodeHtml(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function firstSentence(value, maxLength = 240) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trim()}…`;
}

function detectPartTypes(text) {
  const normalized = normalizeText(text);
  const found = [];
  for (const rule of PART_RULES) {
    if (rule.words.some((word) => normalized.includes(normalizeText(word)))) {
      found.push(rule.key);
    }
  }
  return found.length ? [...new Set(found)] : ["parts"];
}

function categoryFromPartTypes(partTypes) {
  const first = partTypes[0] || "parts";
  return PART_RULES.find((rule) => rule.key === first)?.label || "Авточасти";
}

function detectMakes(text) {
  const normalized = normalizeText(text);
  return CAR_MAKES.filter((make) => normalized.includes(normalizeText(make))).map((make) => normalizeMake(make));
}

function normalizeMake(make) {
  const normalized = normalizeText(make);
  if (normalized === "mercedes benz") {
    return "mercedes-benz";
  }
  if (normalized === "vw") {
    return "volkswagen";
  }
  return normalized;
}

function extractYearRanges(text) {
  const ranges = [];
  const patterns = [
    /(?:0?[1-9]|1[0-2])\s*[.\/-]\s*((?:19|20)\d{2})\s*[-–]\s*(?:(?:0?[1-9]|1[0-2])\s*[.\/-]\s*)?((?:19|20)\d{2})?/g,
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

function extractTireSizes(text) {
  const sizes = new Set();
  const source = String(text || "");
  const patterns = [
    /\b(\d{3})\s*\/\s*(\d{2})\s*r?\s*(\d{2})\b/gi,
    /\b(\d{3})\s+(\d{2})\s*R\s*(\d{2})\b/gi,
    /\b(\d{3})\s+(\d{2})\s+(\d{2})\b/gi,
    /\b(\d{3})(\d{2})R(\d{2})\b/gi,
  ];

  for (const pattern of patterns) {
    let match = pattern.exec(source);
    while (match) {
      sizes.add(`${match[1]}/${match[2]}R${match[3]}`);
      match = pattern.exec(source);
    }
  }

  return [...sizes];
}

function detectSeason(text) {
  const normalized = normalizeText(text);
  if (normalized.includes("зимни") || normalized.includes("winter")) {
    return "winter";
  }
  if (normalized.includes("летни") || normalized.includes("summer")) {
    return "summer";
  }
  if (normalized.includes("всесезон") || normalized.includes("all season") || normalized.includes("allseason")) {
    return "all-season";
  }
  return "";
}

function minVariantPrice(variants) {
  const prices = (Array.isArray(variants) ? variants : [])
    .map((variant) => Number(variant.price))
    .filter((price) => Number.isFinite(price));
  return prices.length ? Math.min(...prices) : null;
}

function extractModelHint(title) {
  const clean = String(title || "").replace(/\s*\|\s*AvtoMol\.com\s*$/i, "");
  const afterFor = clean.split(/\s+за\s+/i)[1] || clean;
  const withoutDates = afterFor.replace(/\b(?:0?[1-9]|1[0-2])\.\d{4}\s*[-–].*$/g, "").trim();
  const make = CAR_MAKES.find((item) => normalizeText(withoutDates).includes(normalizeText(item)));
  if (!make) {
    return "";
  }
  return withoutDates.replace(new RegExp(normalizeText(make).replace(/\s+/g, "\\s+"), "i"), "").trim();
}

function mapShopifyProduct(product) {
  const title = String(product.title || "").replace(/\s*\|\s*AvtoMol\.com\s*$/i, "").trim();
  const description = stripHtml(product.body_html || "");
  const haystack = [title, description, product.handle, product.product_type, product.vendor, (product.tags || []).join(" ")].join(" ");
  const partTypes = detectPartTypes(haystack);
  const price = minVariantPrice(product.variants);

  return {
    id: `avtomol-${product.id}`,
    source: "avtomol",
    name: title,
    category: categoryFromPartTypes(partTypes),
    productType: product.product_type || categoryFromPartTypes(partTypes),
    vendor: product.vendor || "AvtoMol.com",
    summary: firstSentence(description || title),
    description: firstSentence(description, 700),
    price,
    compareAtPrice: null,
    currency: "EUR",
    featured: false,
    inStock: Array.isArray(product.variants) ? product.variants.some((variant) => variant.available) : true,
    url: `${AVTOMOL_BASE_URL}/products/${product.handle}`,
    handle: product.handle,
    images: (product.images || []).map((image) => image.src).filter(Boolean),
    tags: product.tags || [],
    optionNames: (product.options || []).map((option) => option.name).filter(Boolean),
    makes: detectMakes(`${title} ${product.handle}`),
    models: [extractModelHint(title)].filter(Boolean),
    partTypes,
    tireSizes: extractTireSizes(haystack),
    tireBrand: "",
    season: detectSeason(haystack),
    yearRanges: extractYearRanges(haystack),
  };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 AvtoMolCatalogImporter/1.0",
      Accept: "application/json,text/html;q=0.9,*/*;q=0.8",
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 AvtoMolCatalogImporter/1.0",
      Accept: "text/html,*/*;q=0.8",
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.text();
}

async function importAvtomolProducts() {
  const products = [];
  const rawPages = [];

  for (let page = 1; page <= AVTOMOL_MAX_PAGES; page += 1) {
    const url = `${AVTOMOL_BASE_URL}/products.json?limit=250&page=${page}`;
    const payload = await fetchJson(url);
    const pageProducts = Array.isArray(payload.products) ? payload.products : [];
    rawPages.push({ page, count: pageProducts.length });
    console.log(`Avtomol page ${page}: ${pageProducts.length}`);

    if (!pageProducts.length) {
      break;
    }

    products.push(...pageProducts.map(mapShopifyProduct));
  }

  await fs.writeFile(path.join(WORK_DIR, "avtomol-products-pages.json"), JSON.stringify(rawPages, null, 2), "utf8");
  return products;
}

function readObjectProperty(block, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stringMatch = block.match(new RegExp(`${escaped}\\s*:\\s*"([^"]*)"`, "i"));
  if (stringMatch) {
    return decodeHtml(stringMatch[1]).trim();
  }
  const numberMatch = block.match(new RegExp(`${escaped}\\s*:\\s*([0-9]+(?:[.,][0-9]+)?)`, "i"));
  return numberMatch ? numberMatch[1].replace(",", ".") : "";
}

function mapDianaItem(block, html) {
  const id = readObjectProperty(block, "item_id");
  if (!id) {
    return null;
  }

  const brand = readObjectProperty(block, "item_brand") || "Diana";
  const itemName = readObjectProperty(block, "item_name");
  const category = readObjectProperty(block, "item_category") || "Гуми";
  const seasonText = readObjectProperty(block, "item_category2");
  const sizeText = readObjectProperty(block, "item_category3");
  const price = Number(readObjectProperty(block, "price"));
  const quantityMatch = html.match(new RegExp(`data-id=["']${id}["'][\\s\\S]{0,180}?data-quantity=["'](\\d+)["']`, "i"));
  const quantity = quantityMatch ? Number(quantityMatch[1]) : null;
  const nameFromContent = block.match(/content_name:\s*'([^']+)'/i)?.[1] || "";
  const modelTitle = nameFromContent || `${brand} ${itemName}`.trim();
  const tireSizes = extractTireSizes(`${itemName} ${sizeText} ${modelTitle}`);
  const season = detectSeason(seasonText || modelTitle);

  return {
    id: `diana-${id}`,
    source: "diana-ltd.com",
    name: `${modelTitle} | Гуми Диана`.replace(/\s+/g, " ").trim(),
    category: "Гуми",
    productType: category,
    vendor: brand,
    summary: [`${brand}`, seasonText, sizeText, quantity !== null ? `налични: ${quantity}` : ""].filter(Boolean).join(" • "),
    description: `Гума от публичния каталог на Гуми Диана. За поръчка през AvtoMol изпратете запитване във Viber/WhatsApp 0876 778 357 с желания размер и модел.`,
    price: Number.isFinite(price) ? price : null,
    compareAtPrice: null,
    currency: "EUR",
    featured: false,
    inStock: quantity === null ? true : quantity > 0,
    url: `${DIANA_BASE_URL}/tire?${id}`,
    handle: `diana-tire-${id}`,
    images: [],
    tags: ["гуми", "Гуми Диана", brand, seasonText, sizeText].filter(Boolean),
    optionNames: ["Размер", "Сезон"],
    makes: [],
    models: [],
    partTypes: ["tires"],
    tireSizes,
    tireBrand: normalizeText(brand),
    season,
    yearRanges: [],
  };
}

function parseDianaProducts(html) {
  const products = [];
  const itemRegex = /var\s+item\s*=\s*\{([\s\S]*?)\}\s*;/g;
  const seen = new Set();
  let match = itemRegex.exec(html);

  while (match) {
    const product = mapDianaItem(match[1], html);
    if (product && !seen.has(product.id)) {
      seen.add(product.id);
      products.push(product);
    }
    match = itemRegex.exec(html);
  }

  return products;
}

async function importDianaTires() {
  const products = [];
  const rawPages = [];

  for (let page = 1; page <= DIANA_MAX_PAGES; page += 1) {
    const url =
      `${DIANA_BASE_URL}/tires?mv_type=1&minSum=23&maxSum=936&tire_type[]=1&tire_type[]=3&points=0&countPerPage=60&ssort=0&currentPage=${page}&view=table&currency=EUR&scrollTop=0`;
    const html = await fetchText(url);
    const pageProducts = parseDianaProducts(html);
    rawPages.push({ page, count: pageProducts.length });
    console.log(`Diana page ${page}: ${pageProducts.length}`);

    if (!pageProducts.length) {
      break;
    }

    products.push(...pageProducts);
  }

  await fs.writeFile(path.join(WORK_DIR, "diana-products-pages.json"), JSON.stringify(rawPages, null, 2), "utf8");
  return products;
}

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(WORK_DIR, { recursive: true });

  const avtomolProducts = await importAvtomolProducts();
  const dianaProducts = await importDianaTires();
  const allProducts = [...avtomolProducts, ...dianaProducts];

  await fs.writeFile(path.join(DATA_DIR, "products.json"), JSON.stringify(allProducts, null, 2), "utf8");
  await fs.writeFile(
    path.join(WORK_DIR, "catalog-import-summary.json"),
    JSON.stringify(
      {
        importedAt: new Date().toISOString(),
        avtomolProducts: avtomolProducts.length,
        dianaProducts: dianaProducts.length,
        totalProducts: allProducts.length,
      },
      null,
      2
    ),
    "utf8"
  );

  console.log(`Imported ${allProducts.length} products/pages (${avtomolProducts.length} Avtomol, ${dianaProducts.length} Diana).`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
