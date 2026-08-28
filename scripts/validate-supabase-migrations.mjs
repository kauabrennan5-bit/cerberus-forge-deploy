import fs from 'node:fs';
import path from 'node:path';

const migrationsDir = path.resolve('supabase/migrations');
const files = fs.readdirSync(migrationsDir)
  .filter((name) => name.endsWith('.sql'))
  .sort((a, b) => a.localeCompare(b));

const errors = [];
const versions = new Map();

for (const file of files) {
  const match = file.match(/^(\d{8,14})_/);
  if (!match) {
    errors.push(`${file}: filename must start with an 8–14 digit migration version followed by '_'`);
    continue;
  }
  const version = match[1];
  const previous = versions.get(version);
  if (previous) errors.push(`duplicate migration version ${version}: ${previous}, ${file}`);
  versions.set(version, file);
}

const stripComments = (sql) => sql
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/--.*$/gm, ' ');

const createdTables = new Set();
const missingReferences = new Map();

function recordMissing(table, file, kind) {
  if (createdTables.has(table)) return;
  const key = `${table}|${file}|${kind}`;
  missingReferences.set(key, { table, file, kind });
}

for (const file of files) {
  const sql = stripComments(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
  const events = [];

  const createRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi;
  for (const match of sql.matchAll(createRe)) {
    events.push({ index: match.index, type: 'create', table: match[1] });
  }

  const referenceRe = /references\s+public\."?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi;
  for (const match of sql.matchAll(referenceRe)) {
    events.push({ index: match.index, type: 'reference', table: match[1] });
  }

  const alterRe = /alter\s+table\s+(?:if\s+exists\s+)?public\."?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi;
  for (const match of sql.matchAll(alterRe)) {
    events.push({ index: match.index, type: 'alter', table: match[1] });
  }

  const indexRe = /create\s+(?:unique\s+)?index(?:\s+if\s+not\s+exists)?[\s\S]{0,240}?\s+on\s+public\."?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi;
  for (const match of sql.matchAll(indexRe)) {
    events.push({ index: match.index, type: 'index', table: match[1] });
  }

  events.sort((a, b) => a.index - b.index);
  for (const event of events) {
    if (event.type === 'create') {
      createdTables.add(event.table);
    } else {
      recordMissing(event.table, file, event.type);
    }
  }
}

for (const item of missingReferences.values()) {
  errors.push(`missing bootstrap table public.${item.table}: first ${item.kind} seen in ${item.file} before any tracked CREATE TABLE`);
}

console.log(`Supabase migration files: ${files.length}`);
console.log(`Unique migration versions: ${versions.size}`);
console.log(`Tracked CREATE TABLE objects: ${createdTables.size}`);

if (errors.length) {
  console.error('\nMigration integrity errors:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log('Migration filename and bootstrap-reference checks passed.');
