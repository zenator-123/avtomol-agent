const test = require('node:test');
const assert = require('node:assert/strict');
const { selectReplacement, isAvailableFeedVehicle } = require('../lib/olx-replacement-matcher');

const old = {
  title: 'Volkswagen Golf 1.6 TDI 2018',
  price: { value: 10500 },
  attributes: [
    { code: 'brand', value: 'Volkswagen' }, { code: 'model', value: 'Golf' },
    { code: 'year', value: '2018' }, { code: 'fuel', value: 'Дизел' },
    { code: 'power', value: '115' }, { code: 'gearbox', value: 'Ръчна' },
    { code: 'body_type', value: 'Хечбек' },
  ],
};

test('selects the closest available same-brand/model vehicle', () => {
  const candidates = [
    { stock: 'AA00001', brand: 'Volkswagen', model: 'Golf', year: 2017, fuel: 'Дизел', horsepower: 110, gearbox: 'Ръчна', bodyType: 'Хечбек', price: 10000 },
    { stock: 'AA00002', brand: 'Volkswagen', model: 'Golf', year: 2022, fuel: 'Бензин', horsepower: 150, gearbox: 'Автоматик', bodyType: 'Хечбек', price: 18000 },
    { stock: 'AA00003', brand: 'Volkswagen', model: 'Passat', year: 2018, fuel: 'Дизел', horsepower: 115, gearbox: 'Ръчна', bodyType: 'Комби', price: 10500 },
  ];
  assert.equal(selectReplacement(old, candidates).match.stock, 'AA00001');
});

test('does not publish an unreliable different model', () => {
  const result = selectReplacement(old, [{ stock: 'AA00003', brand: 'Volkswagen', model: 'Passat', year: 2018, fuel: 'Дизел' }]);
  assert.equal(result.match, null);
});

test('does not reuse a candidate already assigned to another OLX advert', () => {
  const candidate = { stock: 'AA00001', brand: 'Volkswagen', model: 'Golf', year: 2018, fuel: 'Дизел' };
  assert.equal(selectReplacement(old, [candidate], new Set(['AA00001'])).match, null);
});

test('requires an explicit current availability signal', () => {
  assert.equal(isAvailableFeedVehicle({ status: 'available' }), true);
  assert.equal(isAvailableFeedVehicle({ available: true }), true);
  assert.equal(isAvailableFeedVehicle({ status: 'sold' }), false);
  assert.equal(isAvailableFeedVehicle({}), false);
});

test('prefers explicitly confirmed reclaimable VAT between reliable matches', () => {
  const candidates = [
    { stock: 'AA00001', brand: 'Volkswagen', model: 'Golf', year: 2018 },
    { stock: 'AA00002', brand: 'Volkswagen', model: 'Golf', year: 2018, vatReclaimable: true, vatConfirmed: true },
  ];
  assert.equal(selectReplacement(old, candidates).match.stock, 'AA00002');
});
