import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const repositoryRoot = process.cwd();
const heroPath = resolve(repositoryRoot, 'src/components/NexbotHero.tsx');
const heroSource = readFileSync(heroPath, 'utf8');
const appSource = readFileSync(resolve(repositoryRoot, 'src/App.tsx'), 'utf8');
const mainSource = readFileSync(resolve(repositoryRoot, 'src/main.tsx'), 'utf8');

const retired3dAssets = [
  'public/assets/3d/cerberus_logo.glb',
  'public/assets/3d/nexbot_robot_character_concept.glb',
];

test('home usa o hero quiet/compact canônico e a vitrine de categorias', () => {
  assert.match(heroSource, /className="quiet-hero"/);
  assert.match(heroSource, /CategoryShowcase/);
  assert.match(heroSource, /Explorar acervo/);
  assert.match(heroSource, /Curadoria para quem não quer encontrar o óbvio\./);
  assert.match(appSource, /!showOnlyFavorites && <NexbotHero/);
  assert.match(appSource, /id="cerberus-acervo"/);
  assert.match(mainSource, /design-system-compact\.css/);
  assert.match(mainSource, /design-system-dark-surface\.css/);
  assert.match(mainSource, /design-system-product-detail\.css/);
});

test('hero 3D aposentado não pode voltar ao storefront canônico', () => {
  assert.doesNotMatch(heroSource, /from ['"]three['"]|import\(['"]three['"]\)/);
  assert.doesNotMatch(heroSource, /\.glb|OrbitControls|GLTFLoader|WebGLRenderer|supportsWebGL/);
  assert.doesNotMatch(heroSource, /nexbot-hero|Entrar na curadoria|Símbolo 3D interativo|Scroll to discover/i);
  for (const asset of retired3dAssets) {
    assert.equal(existsSync(resolve(repositoryRoot, asset)), false, `${asset} deve permanecer removido`);
  }
});
