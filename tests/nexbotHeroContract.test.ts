import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const repositoryRoot = process.cwd();
const heroSource = readFileSync(resolve(repositoryRoot, 'src/components/NexbotHero.tsx'), 'utf8');
const appSource = readFileSync(resolve(repositoryRoot, 'src/App.tsx'), 'utf8');
const heroStyles = readFileSync(resolve(repositoryRoot, 'src/index.css'), 'utf8');
const model = readFileSync(
  resolve(repositoryRoot, 'public/assets/3d/nexbot_robot_character_concept.glb'),
);

const readGlbJson = (buffer: Buffer) => {
  assert.equal(buffer.subarray(0, 4).toString('utf8'), 'glTF');
  assert.equal(buffer.readUInt32LE(4), 2);
  assert.equal(buffer.readUInt32LE(8), buffer.byteLength);

  let offset = 12;
  while (offset < buffer.byteLength) {
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.readUInt32LE(offset + 4);
    if (chunkType === 0x4e4f534a) {
      return JSON.parse(buffer.subarray(offset + 8, offset + 8 + chunkLength).toString('utf8').trim());
    }
    offset += 8 + chunkLength;
  }

  throw new Error('GLB JSON chunk ausente');
};

test('NEXBOT usa o GLB validado e preserva sua estrutura glTF 2.0', () => {
  assert.equal(
    createHash('sha256').update(model).digest('hex'),
    '65eb09878bc7a4e33620e8472763abcae945c43878c827260614a7175ef695a9',
  );

  const gltf = readGlbJson(model);
  assert.equal(gltf.asset?.version, '2.0');
  assert.equal(gltf.nodes?.length, 123);
  assert.equal(gltf.meshes?.length, 43);
  assert.equal(gltf.scenes?.length, 1);
});

test('hero carrega o asset local sem iframe, Spline ou runtime CDN', () => {
  assert.match(heroSource, /NEXBOT_MODEL_URL = '\/assets\/3d\/nexbot_robot_character_concept\.glb'/);
  assert.match(heroSource, /import\('three'\)/);
  assert.doesNotMatch(heroSource, /<iframe|spline-viewer|my\.spline\.design|prod\.spline\.design/i);
  assert.doesNotMatch(heroSource, /https?:\/\//i);
});

test('hero mantém conteúdo, controles, fallback, acessibilidade e atribuição', () => {
  assert.match(heroSource, /Curadoria para quem não quer encontrar o óbvio\./);
  assert.match(heroSource, /Entrar na curadoria/);
  assert.match(heroSource, /supportsWebGL/);
  assert.match(heroSource, /aria-label', 'NEXBOT, guardião 3D interativo da Cerberus Finds'/);
  assert.match(heroSource, /Pausar/);
  assert.match(heroSource, /Reposicionar/);
  assert.match(heroSource, /jules\.sore13, CC BY 4\.0/);
  assert.match(heroSource, /prefers-reduced-motion: reduce/);
  assert.match(heroStyles, /@media \(max-width: 959px\)/);
  assert.match(heroStyles, /@media \(prefers-reduced-motion: reduce\)/);
});

test('home mostra NEXBOT antes do acervo e não o repete em Salvos', () => {
  assert.match(appSource, /!showOnlyFavorites && <NexbotHero/);
  assert.match(appSource, /id="cerberus-acervo"/);
  assert.match(appSource, /scrollIntoView\(\{ behavior: reduceMotion \? 'auto' : 'smooth'/);
});
