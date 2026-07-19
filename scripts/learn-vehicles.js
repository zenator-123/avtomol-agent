const fs = require("node:fs/promises");
const path = require("node:path");
const { learnVehicles } = require("../lib/vehicle-learning");

async function main() {
  const root = path.resolve(__dirname, "..");
  const input = process.env.INVENTORY_FEED_PATH || path.join(root, "data", "vehicle-inventory.json");
  const output = process.env.VEHICLE_KNOWLEDGE_PATH || path.join(root, "data", "vehicle-knowledge.json");
  let payload;
  let catalogSource = "LOCAL_TEST_SAMPLE";
  if (process.env.INVENTORY_FEED_URL) {
    const response = await fetch(process.env.INVENTORY_FEED_URL, {
      headers: process.env.INVENTORY_FEED_TOKEN ? { Authorization: `Bearer ${process.env.INVENTORY_FEED_TOKEN}` } : {},
    });
    if (!response.ok) throw new Error(`AUTO1 потокът върна HTTP ${response.status}.`);
    payload = await response.json();
    catalogSource = "AUTO1_FEED";
  } else {
    payload = JSON.parse(await fs.readFile(input, "utf8"));
  }
  const vehicles = Array.isArray(payload) ? payload : payload.vehicles;
  if (!Array.isArray(vehicles)) throw new Error("Автомобилният каталог трябва да съдържа масив vehicles.");
  const knowledge = learnVehicles(vehicles, new Date().toISOString(), { catalogSource, expectedCatalogSize: 25000 });
  await fs.writeFile(output, `${JSON.stringify(knowledge, null, 2)}\n`, "utf8");
  console.log(`Научени: ${knowledge.totals.uniqueVehicles} автомобила, ${knowledge.totals.brands} марки, ${knowledge.totals.learnedModelEngineGroups} групи. Пълен AUTO1 каталог: ${knowledge.completeAuto1Catalog ? "ДА" : "НЕ"}.`);
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
