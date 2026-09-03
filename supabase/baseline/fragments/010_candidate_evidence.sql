-- Reconstructed baseline fragment. This schema object exists in LIVE but has no independent migration version in the remote migration history.

create table if not exists public.candidate_evidence (
  evidence_id text primary key,
  candidate_id text not null,
  research_id text not null,
  kind text not null,
  field_name text,
  field_value jsonb,
  field_state text not null,
  source_url text not null,
  source_type text not null,
  collection_method text not null,
  observed_at timestamptz not null,
  evidence_hash text not null default '',
  field_hash text unique,
  quality text not null default 'UNKNOWN',
  unit text,
  evidence_note text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint candidate_evidence_kind_check check (kind in ('RESEARCH_SESSION','FIELD')),
  constraint candidate_evidence_field_state_check check (field_state in ('KNOWN','UNKNOWN','DERIVED','COLLECTION_FAILED','CONTRADICTED')),
  constraint candidate_evidence_source_type_check check (source_type in ('marketplace_page','url_slug','manual','api','scrape','other')),
  constraint candidate_evidence_collection_method_check check (collection_method in ('MANUAL','SCRAPE','API','OTHER')),
  constraint candidate_evidence_quality_check check (quality in ('HIGH','MEDIUM','LOW','UNKNOWN')),
  constraint candidate_evidence_source_url_not_empty check (char_length(source_url) > 8),
  constraint candidate_evidence_metadata_check check (jsonb_typeof(metadata) = 'object'),
  constraint candidate_evidence_check check (kind = 'RESEARCH_SESSION' or field_name in ('title','price','images','seller','rating','review_count','availability','category'))
);
alter table public.candidate_evidence enable row level security;
