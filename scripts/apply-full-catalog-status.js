const fs = require('node:fs/promises');
const {
  decryptManifest,
  validateManifest,
  listShopifyProducts,
  productStock,
  shopifyGraphql,
} = require('./audit-full-vehicle-catalog');

const MODE = String(process.env.FULL_CATALOG_STATUS_MODE || 'dry-run').toLowerCase();
const BATCH_LIMIT = Math.max(1, Number(process.env.FULL_CATALOG_STATUS_BATCH_LIMIT || 2500));
const REPORT_PATH = process.env.FULL_CATALOG_STATUS_REPORT_PATH
  || 'full-catalog-status-report.json';
const CONCURRENCY = Math.max(1, Math.min(12, Number(process.env.FULL_CATALOG_STATUS_CONCURRENCY || 6)));

if (!['dry-run', 'apply'].includes(MODE)) throw new Error(`Invalid mode: ${MODE}`);

async function setProductStatus(product, status) {
  const data = await shopifyGraphql(`mutation FullCatalogProductStatus($product: ProductUpdateInput!) {
    productUpdate(product: $product) { userErrors { field message } }
  }`, { product: { id: product.id, status } });
  if (data.productUpdate.userErrors.length) {
    throw new Error(JSON.stringify(data.productUpdate.userErrors));
  }
}

async function runPool(items, worker) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

async function main() {
  const manifest = validateManifest(await decryptManifest());
  const sold = new Set(manifest.soldOrUnavailableStocks);
  const replacements = new Set(manifest.newEligibleStocks);
  const products = await listShopifyProducts();

  const activationQueue = [];
  const draftQueue = [];
  let soldMatchedProducts = 0;
  let soldAlreadyHidden = 0;
  let replacementMatchedProducts = 0;
  let replacementAlreadyActive = 0;

  for (const product of products) {
    const stock = productStock(product);
    if (!stock) continue;
    if (replacements.has(stock)) {
      replacementMatchedProducts += 1;
      if (product.status === 'ACTIVE') replacementAlreadyActive += 1;
      else activationQueue.push({ product, stock, targetStatus: 'ACTIVE', action: 'activate-replacement' });
      continue;
    }
    if (sold.has(stock)) {
      soldMatchedProducts += 1;
      if (product.status === 'ACTIVE') {
        draftQueue.push({ product, stock, targetStatus: 'DRAFT', action: 'draft-sold' });
      } else {
        soldAlreadyHidden += 1;
      }
    }
  }

  const allPending = [...activationQueue, ...draftQueue];
  const selected = allPending.slice(0, BATCH_LIMIT);
  const report = {
    generatedAt: new Date().toISOString(),
    mode: MODE,
    batchLimit: BATCH_LIMIT,
    concurrency: CONCURRENCY,
    productsRead: products.length,
    manifest: {
      soldOrUnavailableStocks: manifest.soldOrUnavailableStocks.length,
      newEligibleStocks: manifest.newEligibleStocks.length,
    },
    before: {
      soldMatchedProducts,
      soldAlreadyHidden,
      soldPendingDraft: draftQueue.length,
      replacementMatchedProducts,
      replacementAlreadyActive,
      replacementPendingActivation: activationQueue.length,
      replacementMissingProducts: manifest.newEligibleStocks.length
        - new Set(products.map(productStock).filter((stock) => replacements.has(stock))).size,
    },
    selected: {
      total: selected.length,
      activations: selected.filter((item) => item.action === 'activate-replacement').length,
      drafts: selected.filter((item) => item.action === 'draft-sold').length,
    },
    applied: {
      total: 0,
      activations: 0,
      drafts: 0,
    },
    failures: [],
    results: [],
  };

  await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (MODE === 'dry-run') {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  await runPool(selected, async (item) => {
    try {
      await setProductStatus(item.product, item.targetStatus);
      report.applied.total += 1;
      if (item.action === 'activate-replacement') report.applied.activations += 1;
      else report.applied.drafts += 1;
      report.results.push({
        stock: item.stock,
        productId: item.product.id,
        handle: item.product.handle,
        action: item.action,
        status: item.targetStatus,
      });
    } catch (error) {
      report.failures.push({
        stock: item.stock,
        productId: item.product.id,
        handle: item.product.handle,
        action: item.action,
        error: error.message,
      });
    }
    if ((report.applied.total + report.failures.length) % 100 === 0) {
      console.log(JSON.stringify({
        phase: 'status-update',
        completed: report.applied.total,
        failed: report.failures.length,
        selected: selected.length,
      }));
      await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
  });

  report.remainingAfterRun = {
    pendingActivations: Math.max(0, activationQueue.length - report.applied.activations),
    pendingDrafts: Math.max(0, draftQueue.length - report.applied.drafts),
  };
  await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    report: REPORT_PATH,
    selected: report.selected,
    applied: report.applied,
    failures: report.failures.length,
    remainingAfterRun: report.remainingAfterRun,
  }, null, 2));
  if (report.failures.length) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
