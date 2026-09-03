import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationsDir = path.resolve('supabase/migrations');

// These files predate unique timestamped migration filenames in the repository.
// The effective ordering preserves the chronology proven by LIVE object
// ordinals and supabase_migrations records, without fabricating migrations.
const legacyEffectiveVersion = new Map([
  ['20260816_commercial_brain.sql', '20260816000000'],
  ['20260816_agent_executions.sql', '20260816052812'],
  ['20260816_experiments.sql', '20260816064321'],
  ['20260816_candidates.sql', '20260816082902'],
  ['20260816_candidate_evidence.sql', '20260816100000'],
  ['20260816_job_queue.sql', '20260816110000'],
  ['20260816_policy_evaluations.sql', '20260816120000'],
  ['20260816_product_observations.sql', '20260816130000'],
  ['20260816_candidate_assessment.sql', '20260816181738'],
  ['20260816_affiliate_infrastructure.sql', '20260816220304'],
  ['20260820_governance_candidates.sql', '20260819142113'],
  ['20260820_publication_executions.sql', '20260819173857'],
  ['20260822_newsletter_subscribers.sql', '20260822090000'],
  // LIVE products ordinals prove oferta_promocional was added before
  // raw_title/display_title, and curator_note was added after those fields.
  ['20260822_product_promotion_offer.sql', '20260822100000'],
  ['20260822_product_display_title.sql', '20260822101000'],
  ['20260822_product_curator_note.sql', '20260822102000'],
  ['20260822_newsletter_consent_suppression.sql', '20260822224450'],
]);

export const acceptedLegacyDuplicateVersions = new Set(['20260816', '20260820', '20260822']);

export function migrationVersion(file) {
  const override = legacyEffectiveVersion.get(file);
  if (override) return override;
  const match = file.match(/^(\d{8,14})_/);
  if (!match) throw new Error(`${file}: migration filename must start with an 8–14 digit version followed by '_'`);
  return match[1].padEnd(14, '0');
}

export function listSupabaseMigrations() {
  return fs.readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => {
      const av = migrationVersion(a);
      const bv = migrationVersion(b);
      return av.localeCompare(bv) || a.localeCompare(b);
    });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  for (const file of listSupabaseMigrations()) console.log(path.join('supabase/migrations', file));
}
