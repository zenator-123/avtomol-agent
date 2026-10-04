#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const PROFILE_DIR = process.env.AUTO1_PROFILE_DIR
  ? path.resolve(process.env.AUTO1_PROFILE_DIR)
  : path.join(ROOT, '.auto1-profile');
const CONFIG_PATH = process.env.AUTO1_BROWSER_CONFIG
  ? path.resolve(process.env.AUTO1_BROWSER_CONFIG)
  : path.join(DATA_DIR, 'auto1-browser-config.json');
const OUTPUT_PATH = process.env.AUTO1_OUTPUT_PATH
  ? path.resolve(process.env.AUTO1_OUTPUT_PATH)
  : path.join(DATA_DIR, 'auto1-live-inventory.json');

const setupMode = process.argv.includes('--setup');
const headed = setupMode || String(process.env.AUTO1_HEADLESS || 'true').toLowerCase() === 'false';
const maxScrolls = Math.max(5, Number(process.env.AUTO1_MAX_SCROLLS || 80));
const maxPages = Math.max(1, Number(process.env.AUTO1_MAX_PAGES || 80));
const settleMs = Math.max(500, Number(process.env.AUTO1_SETTLE_MS || 1800));

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find(p => fssync.existsSync(p)) || '';
}

async function readJson(file, fallback = {}) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise(resolve => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

function normalizeKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function flatten(value, out = [], depth = 0) {
  if (depth > 6 || value == null) return out;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 500)) flatten(item, out, depth + 1);
    return out;
  }
  if (typeof value !== 'object') return out;
  for (const [key, child] of Object.entries(value)) {
    if (child == null) continue;
    if (['string', 'number', 'boolean'].includes(typeof child)) {
      out.push({ key, nk: normalizeKey(key), value: child });
    } else {
      flatten(child, out, depth + 1);
    }
  }
  return out;
}

function pick(flat, names) {
  const wanted = new Set(names.map(normalizeKey));
  for (const item of flat) {
    if (wanted.has(item.nk) && String(item.value).trim()) return item.value;
  }
}

function collectStrings(value, out = [], depth = 0) {
  if (depth > 6 || value == null || out.length > 4000) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) {
    for (const item of value.slice(0, 500)) collectStrings(item, out, depth + 1);
  } else if (typeof value === 'object') {
    for (const child of Object.values(value)) collectStrings(child, out, depth + 1);
  }
  return out;
}

function parseNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const cleaned = String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[^\d,.-]/g, '')
    .replace(/\.(?=,\d{2}(?:\D|$))/g, '')
    .replace(',', '.');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}


const DOCUMENT_FEE_BY_COUNTRY_EUR = Object.freeze({
  AT: 478,
  BE: 458,
  DE: 458,
  DK: 418,
  ES: 544,
  FI: 378,
  FR: 428,
  IT: 638,
  NL: 484,
  PL: 288,
  PT: 418,
  SE: 471,
});

const COUNTRY_CODE_ALIASES = Object.freeze({
  AT: 'AT', AUSTRIA: 'AT', OSTERREICH: 'AT', 'ÖSTERREICH': 'AT', АВСТРИЯ: 'AT',
  BE: 'BE', BELGIUM: 'BE', BELGIQUE: 'BE', BELGIE: 'BE', BELGIEN: 'BE', БЕЛГИЯ: 'BE',
  DE: 'DE', GERMANY: 'DE', DEUTSCHLAND: 'DE', ALLEMAGNE: 'DE', ГЕРМАНИЯ: 'DE',
  DK: 'DK', DENMARK: 'DK', DANMARK: 'DK', DANEMARK: 'DK', ДАНИЯ: 'DK',
  ES: 'ES', SPAIN: 'ES', ESPANA: 'ES', 'ESPAÑA': 'ES', SPANIEN: 'ES', ИСПАНИЯ: 'ES',
  FI: 'FI', FINLAND: 'FI', FINNLAND: 'FI', FINLANDE: 'FI', ФИНЛАНДИЯ: 'FI',
  FR: 'FR', FRANCE: 'FR', FRANKREICH: 'FR', ФРАНЦИЯ: 'FR',
  IT: 'IT', ITALY: 'IT', ITALIA: 'IT', ITALIEN: 'IT', ИТАЛИЯ: 'IT',
  NL: 'NL', NETHERLANDS: 'NL', HOLLAND: 'NL', NEDERLAND: 'NL', NIEDERLANDE: 'NL', НИДЕРЛАНДИЯ: 'NL', ХОЛАНДИЯ: 'NL',
  PL: 'PL', POLAND: 'PL', POLSKA: 'PL', POLEN: 'PL', ПОЛША: 'PL',
  PT: 'PT', PORTUGAL: 'PT', PORTUGALSKA: 'PT', ПОРТУГАЛИЯ: 'PT',
  SE: 'SE', SWEDEN: 'SE', SVERIGE: 'SE', SCHWEDEN: 'SE', ШВЕЦИЯ: 'SE',
});

function normalizeCountryCode(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const compact = text.trim();
  if (compact.length <= 12) {
    const direct = compact.toUpperCase().match(/\b(AT|BE|DE|DK|ES|FI|FR|IT|NL|PL|PT|SE)\b/)?.[1];
    if (direct) return direct;
  }
  const normalized = text
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toUpperCase()
    .replace(/[^\p{L}]+/gu, ' ')
    .trim();
  for (const [name, code] of Object.entries(COUNTRY_CODE_ALIASES)) {
    const n = String(name)
      .normalize('NFKD')
      .replace(/\p{Diacritic}/gu, '')
      .toUpperCase();
    if (normalized.includes(n)) return code;
  }
  return '';
}


function findTransportEur(flat, strings) {
  const direct = parseNumber(pick(flat, [
    'transportPrice', 'transport_price', 'transportCost', 'transport_cost',
    'deliveryPrice', 'delivery_price', 'deliveryCost', 'delivery_cost',
    'logisticsPrice', 'logistics_price', 'logisticsCost', 'logistics_cost',
    'shippingPrice', 'shipping_price', 'shippingCost', 'shipping_cost',
    'transportFee', 'transport_fee', 'deliveryFee', 'delivery_fee',
    'logisticsFee', 'logistics_fee', 'shippingFee', 'shipping_fee',
    'transportAmount', 'transport_amount', 'deliveryAmount', 'delivery_amount',
    'transportationPrice', 'transportation_price', 'transportationCost', 'transportation_cost',
    'transportationFee', 'transportation_fee'
  ]));
  if (direct > 0) return direct;

  const candidates = [];
  for (const item of flat) {
    if (!/(transport|delivery|logistic|shipping|freight)/i.test(item.nk)) continue;
    const n = parseNumber(item.value);
    if (n >= 50 && n <= 5000) candidates.push(n);
  }
  if (candidates.length) return Math.max(...candidates);

  for (const text of strings) {
    const m = String(text).match(/(?:transport|delivery|logistics?|shipping|freight)[^€\d]{0,40}(?:€|EUR)?\s*([\d .,'’]+)|(?:€|EUR)\s*([\d .,'’]+)[^\n]{0,40}(?:transport|delivery|logistics?|shipping|freight)/i);
    const n = parseNumber(m?.[1] || m?.[2] || 0);
    if (n >= 50 && n <= 5000) return n;
  }
  return 0;
}

function findCountryCode(flat, strings) {
  const direct = normalizeCountryCode(pick(flat, [
    'purchaseCountry', 'purchase_country', 'countryOfPurchase', 'country_of_purchase',
    'countryCode', 'country_code', 'vehicleCountry', 'vehicle_country',
    'locationCountry', 'location_country', 'carCountry', 'car_country',
    'carLocationCountry', 'car_location_country', 'vehicleLocationCountry', 'vehicle_location_country'
  ]));
  if (direct) return direct;

  for (const item of flat) {
    if (!/(country|location|site|branch)/i.test(item.nk)) continue;
    const code = normalizeCountryCode(item.value);
    if (code) return code;
  }

  for (const text of strings) {
    const source = String(text || '');
    const labeled = source.match(/(?:country|car\s*location|vehicle\s*location|location)[^A-Z]{0,30}\b(AT|BE|DE|DK|ES|FI|FR|IT|NL|PL|PT|SE)\b/i)?.[1];
    if (labeled) return labeled.toUpperCase();
    for (const [name, code] of Object.entries(COUNTRY_CODE_ALIASES)) {
      if (String(name).length <= 2) continue;
      const normalizedName = String(name).normalize('NFKD').replace(/\p{Diacritic}/gu, '').toUpperCase();
      const normalizedText = source.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toUpperCase();
      if (normalizedText.includes(normalizedName)) return code;
    }
  }
  return '';
}

function calculatePublicPrice(auto1Price, transportEur, countryCode) {
  const documentFeeEur = DOCUMENT_FEE_BY_COUNTRY_EUR[countryCode] || 0;
  const vatPercent = Number(process.env.AUTO1_FEE_VAT_PERCENT || 22);
  const minimumProfitEur = Math.max(500, Number(process.env.AUTO1_MIN_PROFIT_EUR || 500));
  const extraProfitEur = Math.max(0, Number(process.env.AUTO1_EXTRA_PROFIT_EUR || 0));

  const pricingComplete = auto1Price > 0
    && transportEur > 0
    && documentFeeEur > 0
    && Number.isFinite(vatPercent);

  if (!pricingComplete) {
    return {
      pricingComplete: false,
      price: 0,
      auto1Price,
      transportEur,
      countryCode,
      documentFeeEur,
      feeVatEur: 0,
      profitEur: minimumProfitEur + extraProfitEur,
    };
  }

  const feeVatEur = (transportEur + documentFeeEur) * vatPercent / 100;
  const profitEur = minimumProfitEur + extraProfitEur;
  const price = Math.round((auto1Price + transportEur + documentFeeEur + feeVatEur + profitEur) * 100) / 100;

  return {
    pricingComplete: true,
    price,
    auto1Price,
    transportEur,
    countryCode,
    documentFeeEur,
    feeVatEur: Math.round(feeVatEur * 100) / 100,
    profitEur,
  };
}

function extractStock(flat, strings) {
  const direct = pick(flat, [
    'incomingNumber', 'incoming_number', 'stockNumber', 'stock_number',
    'stockId', 'stock_id', 'externalId', 'external_id', 'reference',
    'referenceNumber', 'vehicleReference'
  ]);
  const directMatch = String(direct || '').toUpperCase().match(/\b[A-Z]{2}\d{5}\b/);
  if (directMatch) return directMatch[0];

  for (const text of strings) {
    const match = String(text).toUpperCase().match(/\b[A-Z]{2}\d{5}\b/);
    if (match) return match[0];
  }
  return '';
}

function collectImages(strings) {
  const images = [];
  for (const text of strings) {
    for (const token of String(text).split(/[\s,]+/)) {
      if (!/^https:\/\//i.test(token)) continue;
      if (!/(img-pa\.auto1\.com|m2-b2b-img\.auto1\.com|auto1\.(?:com|cloud).*\.(?:jpe?g|png|webp))/i.test(token)) continue;
      const cleaned = token.replace(/[)"'>]+$/g, '');
      if (!images.includes(cleaned)) images.push(cleaned);
      if (images.length >= 40) return images;
    }
  }
  return images;
}

function normalizeVehicle(raw, sourceUrl = '') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const flat = flatten(raw);
  const strings = collectStrings(raw);
  const incomingNumber = extractStock(flat, strings);
  if (!incomingNumber) return null;

  const brand = String(pick(flat, ['brand', 'make', 'manufacturer', 'vehicleMake']) || '').trim();
  const model = String(pick(flat, ['model', 'modelName', 'vehicleModel']) || '').trim();
  const yearRaw = pick(flat, ['year', 'makeYear', 'registrationYear', 'firstRegistrationYear', 'modelYear']);
  const year = String(yearRaw || '').match(/\b(19|20)\d{2}\b/)?.[0] || '';

  let title = String(pick(flat, ['title', 'name', 'displayName', 'vehicleName', 'headline']) || '').trim();
  if (!title && (brand || model)) title = [brand, model, year].filter(Boolean).join(' ');
  if (!title) title = incomingNumber;

  const auto1Price = parseNumber(pick(flat, [
    'buyNowPrice', 'instantBuyPrice', 'purchasePrice', 'purchase_price',
    'salesPrice', 'grossPrice', 'price', 'amount'
  ]));
  const transportEur = findTransportEur(flat, strings);
  const countryCode = findCountryCode(flat, strings);
  const pricing = calculatePublicPrice(auto1Price, transportEur, countryCode);

  const mileage = String(pick(flat, ['mileage', 'odometer', 'mileageKm', 'mileage_km']) || '')
    .replace(/[^\d]/g, '');
  const fuel = String(pick(flat, ['fuel', 'fuelType', 'engineType']) || '').trim();
  const transmission = String(pick(flat, ['transmission', 'transmissionType', 'gearbox', 'gearboxType']) || '').trim();
  const statusText = String(pick(flat, ['availability', 'status', 'vehicleStatus', 'salesStatus']) || '').toLowerCase();
  const sold = /sold|unavailable|removed|deleted|reserved|not.?available/.test(statusText);

  const directFlag = pick(flat, ['directPurchase', 'buyNow', 'instantBuy']);
  const purchaseType = String(pick(flat, ['purchaseType', 'salesChannel', 'channel', 'auctionType']) || '').toLowerCase();
  const directPurchase = typeof directFlag === 'boolean'
    ? directFlag
    : true;

  const unroadworthy = Boolean(pick(flat, ['isUnroadworthy', 'unroadworthy', 'notRoadworthy']));
  const images = collectImages(strings);
  const detailsUrl = strings.find(v => /^https:\/\//i.test(v) && /auto1\./i.test(v) && /vehicle|car|offer|auction/i.test(v)) || sourceUrl;

  const extraText = [];
  const condition = pick(flat, ['conditionDescription', 'damageDescription', 'damages', 'condition']);
  const equipment = pick(flat, ['equipmentText', 'featuresText', 'equipment', 'features']);
  if (condition) extraText.push(String(condition));
  if (equipment) extraText.push(String(equipment));
  if (detailsUrl) extraText.push('AUTO1: ' + detailsUrl);

  return {
    incomingNumber,
    status: sold ? 'unavailable' : 'available',
    title,
    description: extraText.join('\n\n'),
    price: pricing.price,
    pricingComplete: pricing.pricingComplete,
    auto1Price: pricing.auto1Price,
    transportEur: pricing.transportEur,
    purchaseCountry: pricing.countryCode,
    documentFeeEur: pricing.documentFeeEur,
    feeVatEur: pricing.feeVatEur,
    profitEur: pricing.profitEur,
    images,
    brand,
    model,
    year,
    mileage,
    fuel,
    transmission,
    purchaseType: purchaseType || 'instant purchase',
    directPurchase,
    isUnroadworthy: unroadworthy,
    retailReady: !unroadworthy,
    sourceUrl: detailsUrl || ''
  };
}

function walkCandidates(value, sourceUrl, out, depth = 0) {
  if (value == null || depth > 10) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 15000)) walkCandidates(item, sourceUrl, out, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;

  const candidate = normalizeVehicle(value, sourceUrl);
  if (candidate) out.push(candidate);

  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') walkCandidates(child, sourceUrl, out, depth + 1);
  }
}

function mergeVehicle(a, b) {
  if (!a) return b;
  const merged = { ...a };

  const aPricing = a.pricingComplete === true;
  const bPricing = b.pricingComplete === true;

  for (const [key, value] of Object.entries(b)) {
    if (key === 'pricingComplete') {
      merged.pricingComplete = aPricing || bPricing;
      continue;
    }
    if (
      ['price', 'auto1Price', 'transportEur', 'purchaseCountry', 'documentFeeEur', 'feeVatEur', 'profitEur'].includes(key)
      && aPricing && !bPricing
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length > (merged[key]?.length || 0)) merged[key] = value;
    } else if (typeof value === 'string') {
      if (value && (!merged[key] || value.length > String(merged[key]).length)) merged[key] = value;
    } else if (typeof value === 'number') {
      if (value > 0 || (key === 'price' && bPricing)) merged[key] = value;
    } else if (typeof value === 'boolean') {
      merged[key] = value;
    }
  }

  if (bPricing) {
    merged.price = b.price;
    merged.auto1Price = b.auto1Price;
    merged.transportEur = b.transportEur;
    merged.purchaseCountry = b.purchaseCountry;
    merged.documentFeeEur = b.documentFeeEur;
    merged.feeVatEur = b.feeVatEur;
    merged.profitEur = b.profitEur;
  }

  if (b.status === 'unavailable') merged.status = 'unavailable';
  return merged;
}

async function looksLoggedOut(page) {
  const body = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const passwordCount = await page.locator('input[type="password"]').count().catch(() => 0);
  const loginUrl = /login|sign-?in|auth|anmeld|connexion/i.test(page.url());
  return passwordCount > 0 || (loginUrl && /\b(log in|sign in|anmelden|connexion|вход|влез)\b/i.test(body.slice(0, 6000)));
}

async function collectDomCards(page, collected) {
  const rows = await page.evaluate(() => {
    const stockPattern = /\b[A-Z]{2}\d{5}\b/;
    const nodes = [...document.querySelectorAll(
      'article, [data-testid*="vehicle" i], [class*="vehicle" i], [class*="car-card" i], [class*="card" i]'
    )].slice(0, 4000);

    const out = [];
    for (const node of nodes) {
      const text = (node.innerText || '').trim();
      const stock = text.toUpperCase().match(stockPattern)?.[0];
      if (!stock) continue;
      const href = node.querySelector('a[href]')?.href || '';
      const images = [...node.querySelectorAll('img')]
        .map(img => img.currentSrc || img.src)
        .filter(src => /^https:\/\//i.test(src));
      out.push({ stock, text: text.slice(0, 7000), href, images });
    }
    return out;
  }).catch(() => []);

  for (const row of rows) {
    const priceText = row.text.match(/(?:€|EUR)\s*([\d .,'’]+)|([\d .,'’]+)\s*(?:€|EUR)/i);
    const title = row.text.split('\n').map(v => v.trim()).filter(Boolean).slice(0, 2).join(' ');
    const candidate = {
      incomingNumber: row.stock,
      status: 'available',
      title: title || row.stock,
      description: row.text,
      // DOM cards often expose only the raw AUTO1 price. Never publish that.
      price: 0,
      pricingComplete: false,
      auto1Price: parseNumber(priceText?.[1] || priceText?.[2] || 0),
      transportEur: 0,
      purchaseCountry: '',
      documentFeeEur: 0,
      feeVatEur: 0,
      profitEur: Math.max(500, Number(process.env.AUTO1_MIN_PROFIT_EUR || 500)),
      images: row.images.filter((v, i, arr) => arr.indexOf(v) === i).slice(0, 40),
      brand: '',
      model: '',
      year: row.text.match(/\b(19|20)\d{2}\b/)?.[0] || '',
      mileage: String(row.text.match(/([\d .]+)\s*км/i)?.[1] || '').replace(/[^\d]/g, ''),
      fuel: '',
      transmission: '',
      purchaseType: 'instant purchase',
      directPurchase: true,
      isUnroadworthy: false,
      retailReady: true,
      sourceUrl: row.href
    };
    collected.set(candidate.incomingNumber, mergeVehicle(collected.get(candidate.incomingNumber), candidate));
  }
}


function parseLabeledMoney(text, labels) {
  const source = String(text || '');
  for (const label of labels) {
    const re1 = new RegExp(label + "[^\\d€]{0,60}(?:€|EUR)?\\s*([\\d .,\\u2019']+)", "i");
    const re2 = new RegExp("(?:€|EUR)\\s*([\\d .,\\u2019']+)[^\\n]{0,60}" + label, "i");
    const m = source.match(re1) || source.match(re2);
    const n = parseNumber(m?.[1] || 0);
    if (n > 0) return n;
  }
  return 0;
}

function parseCountryFromPageText(text) {
  const source = String(text || '');
  const labeled = source.match(/(?:country|car\\s*location|vehicle\\s*location|location|държава|местоположение)[^A-ZА-Я]{0,50}\\b(AT|BE|DE|DK|ES|FI|FR|IT|NL|PL|PT|SE)\\b/i)?.[1];
  if (labeled) return labeled.toUpperCase();
  const names = [
    ['Austria','AT'],['Österreich','AT'],['Австрия','AT'],
    ['Belgium','BE'],['Belgien','BE'],['Белгия','BE'],
    ['Germany','DE'],['Deutschland','DE'],['Германия','DE'],
    ['Denmark','DK'],['Danmark','DK'],['Дания','DK'],
    ['Spain','ES'],['España','ES'],['Испания','ES'],
    ['Finland','FI'],['Finnland','FI'],['Финландия','FI'],
    ['France','FR'],['Frankreich','FR'],['Франция','FR'],
    ['Italy','IT'],['Italia','IT'],['Italien','IT'],['Италия','IT'],
    ['Netherlands','NL'],['Nederland','NL'],['Нидерландия','NL'],['Холандия','NL'],
    ['Poland','PL'],['Polska','PL'],['Polen','PL'],['Полша','PL'],
    ['Portugal','PT'],['Португалия','PT'],
    ['Sweden','SE'],['Sverige','SE'],['Schweden','SE'],['Швеция','SE'],
  ];
  const folded = source.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  for (const [name, code] of names) {
    const n = String(name).normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase();
    if (folded.includes(n.toLowerCase())) return code;
  }
  return '';
}

async function enrichIncompletePricing(context, collected, attachResponseListener) {
  const maxDetails = Math.max(0, Number(process.env.AUTO1_DETAIL_LIMIT || 60));
  const targets = [...collected.values()]
    .filter(v => !v.pricingComplete && /^https:\/\//i.test(String(v.sourceUrl || '')))
    .slice(0, maxDetails);
  if (!targets.length) return;

  const detailPage = await context.newPage();
  attachResponseListener(detailPage);

  for (let index = 0; index < targets.length; index += 1) {
    const vehicle = targets[index];
    const url = String(vehicle.sourceUrl || '');
    if (!url || !/auto1\./i.test(url)) continue;
    try {
      console.log(`DETAIL ${index + 1}/${targets.length} ${vehicle.incomingNumber}`);
      await detailPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(Math.max(900, settleMs));
      const body = await detailPage.locator('body').innerText({ timeout: 8000 }).catch(() => '');
      const stock = String(body).toUpperCase().match(/\b[A-Z]{2}\d{5}\b/)?.[0] || vehicle.incomingNumber;
      const auto1Price = Number(vehicle.auto1Price || 0) || parseLabeledMoney(body, [
        'buy\\s*now(?:\\s*price)?',
        'instant\\s*purchase(?:\\s*price)?',
        'purchase\\s*price',
        'fixed\\s*price',
        'незабавна\\s*покупка',
        'цена'
      ]);
      const transportEur = Number(vehicle.transportEur || 0) || parseLabeledMoney(body, [
        'transport(?:ation)?(?:\\s*(?:price|cost|fee))?',
        'delivery(?:\\s*(?:price|cost|fee))?',
        'logistics?(?:\\s*(?:price|cost|fee))?',
        'shipping(?:\\s*(?:price|cost|fee))?',
        'транспорт',
        'доставка'
      ]);
      const countryCode = vehicle.purchaseCountry || parseCountryFromPageText(body);
      const pricing = calculatePublicPrice(auto1Price, transportEur, countryCode);

      const candidate = {
        ...vehicle,
        incomingNumber: stock,
        auto1Price,
        transportEur,
        purchaseCountry: countryCode,
        documentFeeEur: pricing.documentFeeEur,
        feeVatEur: pricing.feeVatEur,
        profitEur: pricing.profitEur,
        price: pricing.price,
        pricingComplete: pricing.pricingComplete,
        sourceUrl: url,
      };

      const images = await detailPage.locator('img').evaluateAll((nodes) => nodes
        .map((img) => img.currentSrc || img.src)
        .filter((src, i, arr) => /^https:\/\//i.test(src) && arr.indexOf(src) === i)
        .slice(0, 40)).catch(() => []);
      if (images.length > (candidate.images?.length || 0)) candidate.images = images;

      collected.set(stock, mergeVehicle(collected.get(stock), candidate));
    } catch (error) {
      console.warn(`::warning::DETAIL ${vehicle.incomingNumber} failed: ${error.message}`);
    }
  }

  await detailPage.close().catch(() => {});
}

async function scrollAndPaginate(page, collected) {
  let stable = 0;
  let lastCount = -1;

  for (let i = 0; i < maxScrolls; i++) {
    await collectDomCards(page, collected);
    if (collected.size === lastCount) stable += 1;
    else stable = 0;
    lastCount = collected.size;

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await sleep(settleMs);
    if (stable >= 5) break;
  }

  for (let pageNo = 1; pageNo < maxPages; pageNo++) {
    const nextButton = page.getByRole('button', { name: /next|следващ|weiter|suivant|avanti|volgende|następ/i }).last();
    const nextLink = page.getByRole('link', { name: /next|следващ|weiter|suivant|avanti|volgende|następ/i }).last();
    let target = null;
    if (await nextButton.count().catch(() => 0)) target = nextButton;
    else if (await nextLink.count().catch(() => 0)) target = nextLink;
    if (!target) break;

    const disabled = await target.isDisabled().catch(() => false);
    if (disabled) break;

    try {
      await target.click({ timeout: 5000 });
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await sleep(settleMs);
      await collectDomCards(page, collected);
    } catch {
      break;
    }
  }
}

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(PROFILE_DIR, { recursive: true });

  const chromePath = findChrome();
  if (!chromePath) throw new Error('Chrome/Chromium не е намерен. Задай CHROME_PATH към chrome.exe.');

  const config = await readJson(CONFIG_PATH, {});
  const startUrl = process.env.AUTO1_START_URL || config.startUrl || 'https://www.auto1.com/bg/home/buy';
  const inventoryUrl = process.env.AUTO1_INVENTORY_URL || config.inventoryUrl || startUrl;

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath: chromePath,
    headless: !headed,
    viewport: { width: 1440, height: 1100 },
    locale: 'bg-BG',
    timezoneId: 'Europe/Sofia'
  });

  let page = context.pages()[0] || await context.newPage();
  const collected = new Map();
  let jsonResponses = 0;

  const attachResponseListener = (targetPage) => targetPage.on('response', async response => {
    try {
      const url = response.url();
      if (!/auto1\.(com|cloud)/i.test(url)) return;
      const type = String(response.headers()['content-type'] || '');
      if (!/json/i.test(type)) return;
      if (!/api|vehicle|car|search|stock|auction|offer|inventory|catalog/i.test(url)) return;

      const payload = await response.json();
      const candidates = [];
      walkCandidates(payload, url, candidates);
      for (const candidate of candidates) {
        collected.set(candidate.incomingNumber, mergeVehicle(collected.get(candidate.incomingNumber), candidate));
      }
      jsonResponses += 1;
    } catch {}
  });

  attachResponseListener(page);
  context.on('page', (newPage) => {
    page = newPage;
    attachResponseListener(newPage);
  });

  await page.goto(inventoryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1800);

  if (setupMode) {
    console.log('\nAUTO1 SETUP');
    console.log('1) Влез в твоя AUTO1 профил в отворения Chrome.');
    console.log('2) Отвори страницата с автомобилите за НЕЗАБАВНА/ДИРЕКТНА ПОКУПКА.');
    console.log('3) Настрой филтрите, които искаш да се следят.');
    await ask('\nКогато страницата е готова, натисни ENTER тук...');
    const livePages = context.pages().filter((candidate) => !candidate.isClosed());
    if (livePages.length) page = livePages[livePages.length - 1];
    if (!page || page.isClosed()) {
      page = await context.newPage();
      attachResponseListener(page);
      await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    }
    const saved = {
      startUrl,
      inventoryUrl: page.url(),
      savedAt: new Date().toISOString(),
      note: 'Паролата не се записва. Сесията остава само в .auto1-profile.'
    };
    await fs.writeFile(CONFIG_PATH, JSON.stringify(saved, null, 2) + '\n', 'utf8');
    console.log('Запазена AUTO1 страница: ' + saved.inventoryUrl);
  }

  if (await looksLoggedOut(page)) {
    await context.close();
    throw new Error('AUTO1 сесията не е активна. Стартирай: npm run auto1:setup');
  }

  await scrollAndPaginate(page, collected);
  await sleep(1000);
  await collectDomCards(page, collected);
  await enrichIncompletePricing(context, collected, attachResponseListener);

  const vehicles = [...collected.values()]
    .filter(v => v.incomingNumber)
    .sort((a, b) => a.incomingNumber.localeCompare(b.incomingNumber));

  const payload = {
    source: 'AUTO1_BROWSER',
    authenticatedProfile: true,
    inventoryUrl: page.url(),
    fetchedAt: new Date().toISOString(),
    jsonResponses,
    count: vehicles.length,
    vehicles
  };

  await fs.writeFile(OUTPUT_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  await context.close();

  console.log(JSON.stringify({
    source: payload.source,
    vehicles: vehicles.length,
    jsonResponses,
    output: OUTPUT_PATH,
    url: payload.inventoryUrl
  }));

  if (!vehicles.length) {
    throw new Error('Не бяха открити автомобили. Пусни auto1:setup и запази правилната страница с наличните коли.');
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
