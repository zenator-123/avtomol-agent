const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeVehicle, vehicleDescription } = require('../scripts/daily-vehicle-sync');

test('normalizes incoming number and sold status', () => {
  const vehicle = normalizeVehicle({ external_id: 'VA52625', status: 'sold', image_urls: 'https://example.com/a.jpg' });
  assert.equal(vehicle.incomingNumber, 'VA52625');
  assert.equal(vehicle.available, false);
  assert.deepEqual(vehicle.images, ['https://example.com/a.jpg']);
});

test('generated description contains visible incoming number', () => {
  const vehicle = normalizeVehicle({ id: 'VA52625', title: 'Volkswagen Golf', status: 'available' });
  assert.match(vehicleDescription(vehicle), /ВХОДЯЩ НОМЕР: VA52625/);
  assert.match(vehicleDescription(vehicle), /color:#d40000/);
});


test('only confirms eligible vehicles up to 25000 km and safe running condition', () => {
  const eligible = normalizeVehicle({
    id: 'AB12345',
    title: 'Test Car',
    status: 'available',
    purchaseType: 'instant purchase',
    price: 19900,
    pricingComplete: true,
    mileage: '25000',
    accidentFree: true,
    drivable: true,
    engineOk: true,
    vatDeductible: true,
    retailReady: true,
  });
  assert.equal(eligible.available, true);

  const highMileage = normalizeVehicle({
    id: 'AB12346',
    status: 'available',
    purchaseType: 'instant purchase',
    price: 19900,
    pricingComplete: true,
    mileage: '25001',
    accidentFree: true,
    drivable: true,
    engineOk: true,
  });
  assert.equal(highMileage.available, false);

  const accidentVehicle = normalizeVehicle({
    id: 'AB12347',
    status: 'available',
    purchaseType: 'instant purchase',
    price: 19900,
    pricingComplete: true,
    mileage: '12000',
    accidentFree: false,
    drivable: true,
    engineOk: true,
  });
  assert.equal(accidentVehicle.available, false);
});

test('description puts large red incoming number after title and explains foreign delivery', () => {
  const html = vehicleDescription(normalizeVehicle({
    id: 'VA52625',
    title: 'Volkswagen Golf',
    price: 20000,
    pricingComplete: true,
    mileage: '12000',
    accidentFree: true,
    drivable: true,
    engineOk: true,
    vatDeductible: true,
    retailReady: true,
  }));
  assert.ok(html.indexOf('<h2>Volkswagen Golf</h2>') < html.indexOf('ВХОДЯЩ НОМЕР: VA52625'));
  assert.match(html, /font-size:32px/);
  assert.match(html, /color:#d40000/);
  assert.match(html, /намира в чужбина/);
  assert.match(html, /проформа фактура/);
  assert.match(html, /Възстановяемо ДДС/);
  assert.match(html, /Готов за продажба на дребно/);
});
