import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const repositoryRoot = process.cwd();
const heroSource = readFileSync(resolve(repositoryRoot, 'src/components/NexbotHero.tsx'), 'utf8');
const appSource = readFileSync(resolve(repositoryRoot, 'src/App.tsx'), 'utf8');
const heroStyles = readFileSync(resolve(repositoryRoot, 'src/index.css'), 'utf8');
test('hero carrega o asset local sem iframe, Spline ou runtime CDN', () => {
  assert.doesNotMatch(heroSource, /<iframe|spline-viewer|my\.spline\.design|prod\.spline\.design/i);
  assert.doesNotMatch(heroSource, /https?:\/\//i);
});

test('hero mantém conteúdo, controles, fallback, acessibilidade e atribuição', () => {
  assert.match(heroSource, /Curadoria para quem não quer encontrar o óbvio\./);
  assert.match(heroSource, /Explorar acervo/);
  assert.match(heroStyles, /@media \(max-width: 959px\)/);
  assert.match(heroStyles, /@media \(prefers-reduced-motion: reduce\)/);
});

test('home mostra NEXBOT antes do acervo e não o repete em Salvos', () => {
  assert.match(appSource, /!showOnlyFavorites && <NexbotHero/);
  assert.match(appSource, /id="cerberus-acervo"/);
  assert.match(appSource, /scrollIntoView\(\{ behavior: reduceMotion \? 'auto' : 'smooth'/);
});
