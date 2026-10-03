#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadDotEnv(path.join(ROOT, '.env'));
const inventoryPath = process.env.AUTO1_OUTPUT_PATH
  ? path.resolve(process.env.AUTO1_OUTPUT_PATH)
  : path.join(ROOT, 'data', 'auto1-live-inventory.json');

function run(script, env = process.env) {
  const result = spawnSync(process.execPath, [script], {
    cwd: ROOT,
    env,
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

const mappedEnv = {
  ...process.env,
  SHOPIFY_SHOP_DOMAIN: process.env.SHOPIFY_SHOP_DOMAIN || process.env.SHOPIFY_AVTOMOL_DOMAIN || '',
  SHOPIFY_ACCESS_TOKEN: process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_AVTOMOL_ACCESS_TOKEN || '',
  SHOPIFY_CLIENT_ID: process.env.SHOPIFY_CLIENT_ID || process.env.SHOPIFY_AVTOMOL_CLIENT_ID || '',
  SHOPIFY_CLIENT_SECRET: process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_AVTOMOL_CLIENT_SECRET || '',
  FACEBOOK_PAGE_ID: process.env.FACEBOOK_PAGE_ID || process.env.FACEBOOK_AVTOMOL_PAGE_ID || '',
  FACEBOOK_PAGE_ACCESS_TOKEN:
    process.env.FACEBOOK_PAGE_ACCESS_TOKEN ||
    process.env.META_SYSTEM_USER_ACCESS_TOKEN ||
    process.env.FACEBOOK_AVTOMOL_PAGE_TOKEN ||
    '',
  INVENTORY_FEED_PATH: inventoryPath,
  INVENTORY_SOURCE: 'AUTO1_BROWSER',
  MIN_INVENTORY_COUNT: process.env.MIN_INVENTORY_COUNT || '1',
  AUTO1_REQUIRED_CATALOG_SIZE: process.env.AUTO1_REQUIRED_CATALOG_SIZE || '25000',
  SYNC_DRY_RUN: process.env.SYNC_DRY_RUN || 'false',

  // Никога не трие автомобили, които вече ги няма в AUTO1.
  ALLOW_DELETIONS: 'false',

  // Добавя новите и обновява съществуващите.
  ALLOW_ADDITIONS: 'true',
  ALLOW_UPDATES: 'true'
};

run(path.join(__dirname, 'auto1-profile-feed.js'), mappedEnv);

const payload = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
if (!Array.isArray(payload.vehicles) || payload.vehicles.length < 1) {
  throw new Error('AUTO1 върна 0 автомобила. Shopify няма да бъде променян.');
}

run(path.join(__dirname, 'daily-vehicle-sync.js'), mappedEnv);
