import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const directory = new URL("../supabase/migrations/", import.meta.url);
const files = (await readdir(directory)).filter(file => file.endsWith(".sql")).sort();
const prefixes = new Map();
for (const file of files) {
  // O repositório contém migrations históricas no formato YYYYMMDD. Elas não
  // são renomeadas porque já foram aplicadas. Novas migrations usam o formato
  // reproduzível YYYYMMDDHHMMSS e essas versões precisam ser únicas.
  const prefix = file.match(/^(\d{8}(?:\d{6})?)_/)?.[1];
  if (!prefix) throw new Error(`MIGRATION_FILENAME_INVALID:${file}`);
  if (prefix.length === 14) {
    if (prefixes.has(prefix)) throw new Error(`MIGRATION_VERSION_DUPLICATE:${prefix}:${prefixes.get(prefix)}:${file}`);
    prefixes.set(prefix, file);
  }
}

const hardening = files.find(file => file.endsWith("_weekly_production_hardening_final.sql"));
if (!hardening) throw new Error("WEEKLY_HARDENING_MIGRATION_MISSING");
const sql = await readFile(join(directory.pathname, hardening), "utf8");
for (const required of [
  "image_editorial_status", "image_curation", "image_review_fingerprint", "display_title_status",
  "editorial_snapshot", "editorial_fingerprint", "approval_audience_count", "oferta_promocional",
  "email_campaigns_weekly_sent_cutoff_idx",
]) {
  if (!sql.includes(required)) throw new Error(`WEEKLY_HARDENING_MIGRATION_CONTRACT_MISSING:${required}`);
}
if (!/^\d{14}_/.test(hardening)) throw new Error(`WEEKLY_HARDENING_VERSION_INVALID:${hardening}`);
console.log(`Migration check PASS (${files.length} migrations; unique 14-digit versions; ${hardening}).`);
