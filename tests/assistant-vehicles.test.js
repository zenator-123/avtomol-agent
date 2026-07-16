const test = require("node:test");
const assert = require("node:assert/strict");
const { findFaqAnswer, generateFallbackReply } = require("../lib/assistant");
const profile = require("../data/store-profile.json");

test("explains included vehicle delivery and pro forma payment", () => {
  const faq = findFaqAnswer(profile, "Включена ли е доставката на колата в цената?");
  assert.equal(faq.id, "vehicle-delivery");
  assert.match(faq.answer, /включена в обявената цена/i);
  assert.match(faq.answer, /проформа фактура/i);
});

test("asks for vehicle preferences and explains the order process", () => {
  const reply = generateFallbackReply({
    matches: [],
    message: "Търся автомобил втора употреба",
    profile,
  });
  assert.match(reply, /бюджет/i);
  assert.match(reply, /Доставката е включена/i);
  assert.match(reply, /проформа фактура/i);
});

test("vehicle search returns actual vehicle products instead of parts", () => {
  const { searchProducts } = require("../lib/catalog");
  const products = [
    {
      id: "vehicle-1",
      source: "avtomol",
      name: "Volkswagen Golf VII 1.6 TDI 2016",
      productType: "with-mileage",
      price: 25000,
      currency: "BGN",
      inStock: true,
      tags: ["vehicle-sync"],
      makes: ["volkswagen"],
      models: ["Golf VII"],
      isVehicle: true,
    },
    {
      id: "part-1",
      source: "avtomol",
      name: "Спирачки за Volkswagen Golf VII",
      productType: "Авточасти",
      price: 100,
      inStock: true,
      makes: ["volkswagen"],
      models: ["Golf VII"],
      partTypes: ["brakes", "parts"],
    },
  ];
  const results = searchProducts(products, "Търся автомобил Volkswagen Golf", 3);
  assert.equal(results[0].id, "vehicle-1");
  assert.equal(results.some((item) => item.id === "part-1"), false);
});
