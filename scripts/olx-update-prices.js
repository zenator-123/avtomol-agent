const fs = require('node:fs');
const path = require('node:path');
const { getOlxAccessToken } = require('./olx-auth');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required setting: ${name}`);
  return value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const euro = (value) => Number(Number(value).toFixed(2));

async function request(url, options = {}, attempts = 5) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const response = await fetch(url, options);
    const text = await response.text();
    let json = null;
    if (text) {
      try { json = JSON.parse(text); }
      catch { json = { raw: text.slice(0, 1000) }; }
    }
    if (response.ok) return { response, json };
    if ((response.status === 429 || response.status >= 500) && attempt < attempts) {
      await sleep(Math.min(10000, 750 * (2 ** (attempt - 1))));
      continue;
    }
    throw new Error(`${options.method || 'GET'} ${url} failed: ${response.status} ${JSON.stringify(json)}`);
  }
  throw new Error(`Request failed after ${attempts} attempts: ${url}`);
}

function cleanDescription(description, newPrice) {
  let value = String(description || '');
  value = value.replace(/Крайна цена:\s*[\d\s.,]+\s*EUR\.?/iu, `Крайна цена: ${newPrice.toFixed(2)} EUR.`);
  value = value.replace(/AUTO1 не е предоставил отделен текстов резултат от тест-драйв\.?/giu, 'Не е предоставен отделен текстов резултат от тест-драйв.');
  value = value.replace(/AUTO1/giu, 'доставчикът');
  return value;
}

function fullUpdatePayload(advert, update) {
  const payload = {
    title: advert.title,
    description: cleanDescription(advert.description, update.new_price_eur),
    category_id: advert.category_id,
    advertiser_type: advert.advertiser_type,
    external_id: advert.external_id,
    contact: advert.contact,
    location: advert.location,
    images: (advert.images || []).map(({ url }) => ({ url })),
    price: {
      value: update.new_price_eur,
      currency: advert.price.currency,
      negotiable: Boolean(advert.price.negotiable),
      budget: Boolean(advert.price.budget),
      trade: Boolean(advert.price.trade),
    },
    attributes: (advert.attributes || []).map(({ code, value, values }) =>
      Array.isArray(values) && values.length ? { code, values } : { code, value: String(value) }
    ),
    courier: Boolean(advert.courier),
    auto_extend_enabled: Boolean(advert.auto_extend_enabled),
  };
  if (advert.external_url) payload.external_url = advert.external_url;
  return payload;
}

async function main() {
  const token = await getOlxAccessToken();
  const minimumProfitEur = euro(Number(process.env.MINIMUM_PROFIT_EUR || 350));
  if (!(minimumProfitEur >= 350)) throw new Error('MINIMUM_PROFIT_EUR cannot be below 350');
  const scope = process.env.UPDATE_SCOPE || 'dry-run';
  if (!['dry-run', 'pilot', 'batch'].includes(scope)) throw new Error(`Invalid UPDATE_SCOPE: ${scope}`);
  const planPath = path.join(process.cwd(), 'data', 'olx-price-updates-2026-07-17.json');
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  let updates = plan.updates;
  const requestedLimit = Number(process.env.BATCH_LIMIT || 0);
  if (requestedLimit > 0) updates = updates.slice(0, requestedLimit);

  const report = { started_at: new Date().toISOString(), scope, planned: updates.length, updated: 0, already_updated: 0, dry_run: 0, failed: 0, results: [] };
  const headers = { Authorization: `Bearer ${token}`, Version: '2.0', Accept: 'application/json' };

  for (let index = 0; index < updates.length; index++) {
    const update = updates[index];
    const url = `https://www.olx.bg/api/partner/adverts/${update.olx_ad_id}`;
    try {
      const { json } = await request(url, { headers });
      const current = json?.data || json;
      if (!current || current.id !== update.olx_ad_id) throw new Error('OLX returned a different advert');
      if (current.status !== 'active') throw new Error(`Advert is not active: ${current.status}`);
      if (current.external_id !== update.external_id) throw new Error(`External ID mismatch: ${current.external_id}`);
      if (current.price?.currency !== 'EUR') throw new Error(`Unexpected currency: ${current.price?.currency}`);
      const currentPrice = euro(current.price?.value);
      const expected = euro(update.expected_old_price_eur);
      const next = euro(update.new_price_eur);
      const landedCost = euro(update.landed_cost_eur);
      if (!(landedCost > 0)) throw new Error(`Missing or invalid landed cost: ${update.landed_cost_eur}`);
      const floor = euro(Math.max(Number(update.protected_minimum_eur || 0), landedCost + minimumProfitEur));
      if (Math.abs(currentPrice - next) <= 0.01) {
        report.already_updated++;
        report.results.push({ id: update.olx_ad_id, stock: update.stock_number, result: 'already-updated', price: currentPrice });
        continue;
      }
      if (Math.abs(currentPrice - expected) > 0.02) throw new Error(`Current price ${currentPrice} differs from expected ${expected}`);
      if (!(next > 0 && next < currentPrice)) throw new Error(`Unsafe price direction: ${currentPrice} -> ${next}`);
      if (next + 0.01 < floor) throw new Error(`New price ${next} is below protected floor ${floor}`);
      const projectedProfit = euro(next - landedCost);
      if (projectedProfit + 0.01 < minimumProfitEur) {
        throw new Error(`Projected profit ${projectedProfit} is below required ${minimumProfitEur}`);
      }
      if (String(update.cost_status) === 'missing') throw new Error('Missing cost is not allowed');

      if (scope === 'dry-run') {
        report.dry_run++;
        report.results.push({ id: update.olx_ad_id, stock: update.stock_number, result: 'validated', old_price: currentPrice, new_price: next });
      } else {
        const payload = fullUpdatePayload(current, update);
        await request(url, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        report.updated++;
        report.results.push({ id: update.olx_ad_id, stock: update.stock_number, result: 'updated', old_price: currentPrice, new_price: next });
        await sleep(scope === 'pilot' ? 2500 : 350);
        if (scope === 'pilot' && report.updated >= 1) break;
      }
      if ((index + 1) % 25 === 0 || index === updates.length - 1) {
        console.log(`Progress ${index + 1}/${updates.length}; updated=${report.updated}; validated=${report.dry_run}; failed=${report.failed}`);
      }
    } catch (error) {
      report.failed++;
      report.results.push({ id: update.olx_ad_id, stock: update.stock_number, result: 'failed', error: error.message });
      console.error(`FAILED ${update.olx_ad_id} ${update.stock_number}: ${error.message}`);
      if (/doesn't belong to current partner/i.test(error.message)) {
        report.terminal_error = 'OLX credential belongs to a different partner account; no further writes attempted.';
        break;
      }
      // Preserve the failure report for diagnosis.
    }
  }

  report.finished_at = new Date().toISOString();
  const output = path.join(process.env.RUNNER_TEMP || process.cwd(), `olx-price-update-${scope}.json`);
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ scope, planned: report.planned, updated: report.updated, already_updated: report.already_updated, dry_run: report.dry_run, failed: report.failed }));
  if (report.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
