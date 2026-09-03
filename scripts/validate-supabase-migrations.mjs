import fs from 'node:fs';
import path from 'node:path';

const migrationsDir = path.resolve('supabase/migrations');
const files = fs.readdirSync(migrationsDir)
  .filter((name) => name.endsWith('.sql'))
  .sort((a, b) => a.localeCompare(b));

const expectedLiveTables = new Set([
  'affiliate_links', 'affiliate_providers', 'agent_executions',
  'autonomous_curator_candidates', 'autonomous_curator_config', 'autonomous_curator_runs',
  'candidate_assessment', 'candidate_evidence', 'candidates', 'catalog_categories',
  'commercial_artifacts', 'commercial_cycle_steps', 'commercial_cycles', 'commercial_decisions', 'commercial_signals',
  'email_campaign_products', 'email_campaign_recipients', 'email_campaign_telegram_cards', 'email_campaigns',
  'experiments', 'filter_definitions', 'job_queue', 'newsletter_outbox', 'newsletter_subscribers',
  'newsletter_weekly_runtime_config', 'operational_events', 'operational_incidents', 'operational_operations',
  'operational_recovery_attempts', 'operator_state', 'policy_evaluations', 'product_availability_observed',
  'product_clicks', 'product_image_editorial_reviews', 'product_image_observed', 'product_price_observed',
  'product_publication_authorizations', 'product_rotation_requests', 'product_source_identities',
  'product_source_observed', 'products', 'publication_executions', 'social_links', 'telegram_pending_reviews',
]);

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
  for (const match of sql.matchAll(createRe)) events.push({ index: match.index, type: 'create', table: match[1] });

  const referenceRe = /references\s+public\."?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi;
  for (const match of sql.matchAll(referenceRe)) events.push({ index: match.index, type: 'reference', table: match[1] });

  const alterRe = /alter\s+table\s+(?:if\s+exists\s+)?public\."?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi;
  for (const match of sql.matchAll(alterRe)) events.push({ index: match.index, type: 'alter', table: match[1] });

  const indexRe = /create\s+(?:unique\s+)?index(?:\s+if\s+not\s+exists)?[\s\S]{0,240}?\s+on\s+public\."?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi;
  for (const match of sql.matchAll(indexRe)) events.push({ index: match.index, type: 'index', table: match[1] });

  events.sort((a, b) => a.index - b.index);
  for (const event of events) {
    if (event.type === 'create') createdTables.add(event.table);
    else recordMissing(event.table, file, event.type);
  }
}

for (const item of missingReferences.values()) {
  errors.push(`missing bootstrap table public.${item.table}: first ${item.kind} seen in ${item.file} before any tracked CREATE TABLE`);
}

const absentFromTrackedMigrations = [...expectedLiveTables]
  .filter((table) => !createdTables.has(table))
  .sort();

console.log(`Supabase migration files: ${files.length}`);
console.log(`Unique migration versions: ${versions.size}`);
console.log(`Tracked CREATE TABLE objects: ${createdTables.size}`);
console.log(`LIVE tables absent from tracked CREATE TABLE statements: ${absentFromTrackedMigrations.join(', ') || '(none)'}`);

if (errors.length) {
  console.error('\nMigration integrity errors:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log('Migration filename and bootstrap-reference checks passed.');
