import fs from 'node:fs';
import path from 'node:path';
import { acceptedLegacyDuplicateVersions, listSupabaseMigrations } from './supabase-rebuild-order.mjs';

const migrationsDir = path.resolve('supabase/migrations');
const baselinePath = path.resolve('supabase/baseline.sql');
const files = listSupabaseMigrations();

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
const rawVersions = new Map();

for (const file of files) {
  const match = file.match(/^(\d{8,14})_/);
  if (!match) {
    errors.push(`${file}: filename must start with an 8–14 digit migration version followed by '_'`);
    continue;
  }
  const version = match[1];
  const group = rawVersions.get(version) ?? [];
  group.push(file);
  rawVersions.set(version, group);
}

for (const [version, group] of rawVersions) {
  if (group.length > 1 && !acceptedLegacyDuplicateVersions.has(version)) {
    errors.push(`unexpected duplicate migration version ${version}: ${group.join(', ')}`);
  }
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

function inspectSql(sql, file) {
  sql = stripComments(sql);
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

if (!fs.existsSync(baselinePath)) {
  errors.push('supabase/baseline.sql is required for the pre-20260814 LIVE schema');
} else {
  inspectSql(fs.readFileSync(baselinePath, 'utf8'), 'supabase/baseline.sql');
}

for (const file of files) {
  inspectSql(fs.readFileSync(path.join(migrationsDir, file), 'utf8'), file);
}

for (const item of missingReferences.values()) {
  errors.push(`missing bootstrap table public.${item.table}: first ${item.kind} seen in ${item.file} before any tracked CREATE TABLE`);
}

const absentFromReplay = [...expectedLiveTables]
  .filter((table) => !createdTables.has(table))
  .sort();
if (absentFromReplay.length) {
  errors.push(`LIVE tables absent from baseline+migrations: ${absentFromReplay.join(', ')}`);
}

console.log(`Supabase migration files: ${files.length}`);
console.log(`Raw migration versions: ${rawVersions.size}`);
console.log(`Tracked CREATE TABLE objects including baseline: ${createdTables.size}`);
console.log('Replay order:');
for (const file of files) console.log(`- ${file}`);

if (errors.length) {
  console.error('\nMigration integrity errors:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log('Baseline, migration ordering and bootstrap-reference checks passed.');
