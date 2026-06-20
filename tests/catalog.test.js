const test = require("node:test");
const assert = require("node:assert/strict");
const { searchProducts } = require("../lib/catalog");

const products = [
  {
    id: "bmw-oil",
    source: "avtomol",
    name: "Масла и консумативи за BMW 3 седан (E90) 2005 - 2011",
    category: "Масла и консумативи",
    vendor: "AvtoMol.com",
    summary: "Моторно масло, антифриз, чистачки и консумативи за BMW 3 E90.",
    price: 1,
    currency: "EUR",
    inStock: true,
    url: "https://avtomol.com/products/bmw-e90-oils",
    makes: ["bmw"],
    models: ["3 E90"],
    partTypes: ["oils"],
    yearRanges: [{ from: 2005, to: 2011 }],
    tags: [],
  },
  {
    id: "vw-brakes",
    source: "avtomol",
    name: "Спирачки за Volkswagen GOLF V 2003 - 2009",
    category: "Спирачки",
    vendor: "AvtoMol.com",
    summary: "Накладки и спирачни дискове за Volkswagen Golf 5.",
    price: 1,
    currency: "EUR",
    inStock: true,
    url: "https://avtomol.com/products/vw-golf-v-brakes",
    makes: ["volkswagen"],
    models: ["Golf V"],
    partTypes: ["brakes"],
    yearRanges: [{ from: 2003, to: 2009 }],
    tags: [],
  },
  {
    id: "roadstone-165",
    source: "diana-ltd.com",
    name: "ROADSTONE 165/70R13 79T | Гуми Диана",
    category: "Гуми",
    vendor: "ROADSTONE",
    summary: "летни • 165/70 R13",
    price: 30.05,
    currency: "EUR",
    inStock: true,
    url: "https://diana-ltd.com/tire?1",
    partTypes: ["tires"],
    tireSizes: ["165/70R13"],
    tireBrand: "roadstone",
    season: "summer",
    tags: ["гуми"],
  },
  {
    id: "uniroyal-165",
    source: "diana-ltd.com",
    name: "UNIROYAL RainExpert 3 165/70R13 79T | Гуми Диана",
    category: "Гуми",
    vendor: "UNIROYAL",
    summary: "летни • 165/70 R13",
    price: 55.56,
    currency: "EUR",
    inStock: true,
    url: "https://diana-ltd.com/tire?2",
    partTypes: ["tires"],
    tireSizes: ["165/70R13"],
    tireBrand: "uniroyal",
    season: "summer",
    tags: ["гуми"],
  },
  {
    id: "michelin-205",
    source: "diana-ltd.com",
    name: "MICHELIN Alpin 205/55R16 | Гуми Диана",
    category: "Гуми",
    vendor: "MICHELIN",
    summary: "зимни • 205/55 R16",
    price: 120,
    currency: "EUR",
    inStock: true,
    url: "https://diana-ltd.com/tire?3",
    partTypes: ["tires"],
    tireSizes: ["205/55R16"],
    tireBrand: "michelin",
    season: "winter",
    tags: ["гуми"],
  },
];

test("finds brake pages by car model and year", () => {
  const results = searchProducts(products, "накладки за Golf 5 2006", 3);
  assert.equal(results[0].id, "vw-brakes");
});

test("finds oil pages by make, model hint, and year", () => {
  const results = searchProducts(products, "масло за BMW E90 2008", 3);
  assert.equal(results[0].id, "bmw-oil");
});

test("returns cheapest tyre first when no brand is requested", () => {
  const results = searchProducts(products, "най-евтини гуми 165/70R13", 3);
  assert.equal(results[0].id, "roadstone-165");
});

test("respects requested tyre brand", () => {
  const results = searchProducts(products, "гуми 165/70R13 uniroyal", 3);
  assert.equal(results[0].id, "uniroyal-165");
});

test("does not return catalog results for pure VIN/contact question", () => {
  const results = searchProducts(products, "как да изпратя рама или талон", 3);
  assert.equal(results.length, 0);
});

test("does not swap requested car make when exact match is missing", () => {
  const results = searchProducts(products, "спирачки за BMW E90 2008", 3);
  assert.equal(results.length, 0);
});
