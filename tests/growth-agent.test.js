const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzeHtml, buildContentPlan, summarizeLeads, trackedUrl } = require("../lib/growth-agent");

test("SEO проверката открива основните проблеми", () => {
  const result = analyzeHtml("<html><head><title>Кратко</title></head><body><img src='x.jpg'><h1>Тест</h1></body></html>", "https://example.com/");
  assert.equal(result.title, "Кратко");
  assert.equal(result.imagesMissingAlt, 1);
  assert.ok(result.issues.some((item) => item.code === "missing_description"));
  assert.ok(result.issues.some((item) => item.code === "missing_canonical"));
});

test("проследимите адреси съдържат UTM параметри", () => {
  const url = new URL(trackedUrl("https://example.com/", "campaign", "facebook", "organic"));
  assert.equal(url.searchParams.get("utm_source"), "facebook");
  assert.equal(url.searchParams.get("utm_campaign"), "campaign");
});

test("планът създава статия и публикация за всеки канал", () => {
  const plan = buildContentPlan({
    sites: [{ slug: "shop", name: "Shop", url: "https://example.com/", topics: ["тема"] }],
    channels: [{ slug: "facebook", enabled: true }, { slug: "google", enabled: true }],
  }, new Date("2026-07-19T00:00:00Z"));
  assert.equal(plan.filter((item) => item.type === "article").length, 1);
  assert.equal(plan.filter((item) => item.type === "social").length, 2);
});

test("отчетът брои запитванията по период", () => {
  const now = Date.parse("2026-07-19T00:00:00Z");
  const lines = [
    JSON.stringify({ capturedAt: "2026-07-18T00:00:00Z" }),
    JSON.stringify({ capturedAt: "2026-06-25T00:00:00Z" }),
    "невалиден ред",
  ];
  assert.deepEqual(summarizeLeads(lines, now), { last7Days: 1, last30Days: 2, total: 2 });
});
