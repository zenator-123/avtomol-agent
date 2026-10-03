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

  const price = parseNumber(pick(flat, [
    'buyNowPrice', 'instantBuyPrice', 'purchasePrice', 'salesPrice',
    'grossPrice', 'price', 'amount'
  ]));

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
    price,
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
  for (const [key, value] of Object.entries(b)) {
    if (Array.isArray(value)) {
      if (value.length > (merged[key]?.length || 0)) merged[key] = value;
    } else if (typeof value === 'string') {
      if (value && (!merged[key] || value.length > String(merged[key]).length)) merged[key] = value;
    } else if (typeof value === 'number') {
      if (value > 0) merged[key] = value;
    } else if (typeof value === 'boolean') {
      merged[key] = value;
    }
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
      price: parseNumber(priceText?.[1] || priceText?.[2] || 0),
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

  const page = context.pages()[0] || await context.newPage();
  const collected = new Map();
  let jsonResponses = 0;

  page.on('response', async response => {
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

  await page.goto(inventoryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1800);

  if (setupMode) {
    console.log('\nAUTO1 SETUP');
    console.log('1) Влез в твоя AUTO1 профил в отворения Chrome.');
    console.log('2) Отвори страницата с автомобилите за НЕЗАБАВНА/ДИРЕКТНА ПОКУПКА.');
    console.log('3) Настрой филтрите, които искаш да се следят.');
    await ask('\nКогато страницата е готова, натисни ENTER тук...');
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
