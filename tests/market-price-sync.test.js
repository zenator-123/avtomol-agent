const test = require('node:test');
const assert = require('node:assert/strict');
const data = require('../data/market-price-updates-800.json');
const { stockFromText, replaceEurPrice, buildVehiclePlans, matchPlanForProduct } = require('../scripts/update-market-prices');

test('validates exactly 800 unique advert reductions', () => {
  const built = buildVehiclePlans(data);
  assert.equal(built.advertCount, 800);
  assert.equal(built.vehicles.length, 698);
  assert.ok(built.vehicles.every((row) => row.newPrice < row.oldPrice));
  assert.ok(built.vehicles.every((row) => row.newPrice >= row.protectedMinimum));
  assert.ok(built.vehicles.every((row) => row.forecastProfit > 0));
});

test('finds stock numbers and replaces EUR price', () => {
  assert.equal(stockFromText('\u0412\u0425\u041e\u0414\u042f\u0429 \u041d\u041e\u041c\u0415\u0420: CX64402'), 'CX64402');
  assert.equal(replaceEurPrice('FINAL PRICE: 74 124.85 EUR', 64000), 'FINAL PRICE: 64000.00 EUR');
});

test('matches Shopify products by external handle or stock number', () => {
  const plan = { stock: 'CX64402', externalId: 'avtomol-cx64402' };
  const byStock = new Map([[plan.stock, plan]]);
  const byExternal = new Map([[plan.externalId, plan]]);
  assert.equal(matchPlanForProduct({ handle: 'avtomol-cx64402' }, byStock, byExternal), plan);
  assert.equal(matchPlanForProduct({ handle: 'other', title: 'Vehicle CX64402' }, byStock, byExternal), plan);
});
