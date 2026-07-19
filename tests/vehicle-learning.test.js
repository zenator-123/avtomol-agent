const test = require("node:test");
const assert = require("node:assert/strict");
const { extractEngine, learnVehicles, scoreVehicle } = require("../lib/vehicle-learning");

test("extracts engine designation", () => {
  assert.equal(extractEngine({ title: "Volkswagen Passat 2.0 TDI 2018" }), "2.0 TDI");
});

test("learns unique vehicles and aggregates statistics", () => {
  const knowledge = learnVehicles([
    { incomingNumber: "A1", title: "BMW 320d 2.0 D", brand: "BMW", model: "3 серия", year: 2018, mileage: 150000, price: 20000, fuel: "Дизел", status: "available" },
    { incomingNumber: "A1", title: "duplicate", brand: "BMW", model: "3 серия" },
    { incomingNumber: "A2", title: "BMW 320d 2.0 D", brand: "BMW", model: "3 серия", year: 2020, mileage: 110000, price: 24000, fuel: "Дизел", status: "sold" },
  ], "2026-07-19T00:00:00.000Z");
  assert.equal(knowledge.totals.uniqueVehicles, 2);
  assert.equal(knowledge.totals.availableVehicles, 1);
  assert.equal(knowledge.models[0].medianPrice, 22000);
  assert.equal(knowledge.recommendations[0].incomingNumber, "A1");
});

test("prefers an available diesel in the requested mileage range", () => {
  assert.ok(scoreVehicle({ available: true, mileage: 150000, fuel: "diesel" }) > scoreVehicle({ available: true, mileage: 280000, fuel: "petrol" }));
});

test("does not label the 50-car test sample as the complete AUTO1 catalog", () => {
  const rows = Array.from({ length: 50 }, (_, index) => ({ incomingNumber: `T${index}`, brand: "Тест", model: "Модел" }));
  const knowledge = learnVehicles(rows, "2026-07-19T00:00:00.000Z", { catalogSource: "LOCAL_TEST_SAMPLE", expectedCatalogSize: 25000 });
  assert.equal(knowledge.completeAuto1Catalog, false);
  assert.equal(knowledge.catalogSource, "LOCAL_TEST_SAMPLE");
});
