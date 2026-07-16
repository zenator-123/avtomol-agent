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
