import { readFileSync, writeFileSync } from 'node:fs';

function patch(path, from, to) {
  const source = readFileSync(path, 'utf8');
  if (!source.includes(from)) throw new Error(`PATCH_SOURCE_NOT_FOUND:${path}`);
  writeFileSync(path, source.replace(from, to));
}

const eligibleFields = `        displayTitle: \`Produto \${index}\`,\n        displayTitleStatus: "reviewed",\n        imageEditorialStatus: "clean",\n        imageCuration: { status: "ready", raw: [], gallery: [], principal: "https://example.com/image.jpg", decision: "approved", confidence: 1, reason: "test" },\n`;
patch(
  'tests/autonomousCuratorCategoryPolicy.test.ts',
  '        produto: `Produto ${index}`,\n        categoria: category as Product["categoria"],',
  '        produto: `Produto ${index}`,\n' + eligibleFields + '        categoria: category as Product["categoria"],',
);
patch(
  'tests/autonomousCuratorCategoryPolicy.test.ts',
  'test("fulfilled categories is based only on active published count >= target", () => {',
  'test("fulfilled categories is based only on Edge-v3 eligible public count >= target", () => {',
);

const continuousEligible = `    displayTitle: id,\n    displayTitleStatus: "reviewed",\n    imageEditorialStatus: "clean",\n    imageCuration: { status: "ready", raw: [], gallery: [], principal: "https://example.com/a.jpg", decision: "approved", confidence: 1, reason: "test" },\n`;
patch(
  'tests/autonomousCuratorContinuousV2.test.ts',
  '    produto: id,\n    categoria: category,\n    preco: 100,',
  '    produto: id,\n' + continuousEligible + '    categoria: category,\n    preco: 100,',
);

console.log('updated public eligibility fixtures');
