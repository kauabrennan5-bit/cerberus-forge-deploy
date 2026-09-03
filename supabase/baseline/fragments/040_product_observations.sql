-- Historical schema fragment for product observation tables; intentionally not a live migration.

create table if not exists public.product_price_observed (
  observation_id text primary key, product_id text not null references public.products(id) on delete restrict,
  observed_price numeric(14,2) not null check (observed_price >= 0), currency text not null default 'BRL' check (char_length(currency)=3),
  source_name text not null, marketplace text, merchant text, source_url text not null, external_listing_id text,
  observed_at timestamptz not null, collection_method text not null, confidence text not null,
  correlation_id text not null, idempotency_key text unique, metadata jsonb not null default '{}'::jsonb,
  schema_version text not null default '1.0', created_at timestamptz not null default now(),
  constraint product_price_observed_confidence_check check (confidence in ('HIGH','MEDIUM','LOW','INCONCLUSIVE')),
  constraint product_price_observed_metadata_check check (jsonb_typeof(metadata)='object')
);
create table if not exists public.product_availability_observed (
  observation_id text primary key, product_id text not null references public.products(id) on delete restrict,
  observed_availability text not null, source_name text not null, marketplace text, merchant text, source_url text not null,
  external_listing_id text, observed_at timestamptz not null, collection_method text not null, confidence text not null,
  correlation_id text not null, idempotency_key text unique, metadata jsonb not null default '{}'::jsonb,
  schema_version text not null default '1.0', created_at timestamptz not null default now(),
  constraint product_availability_observed_observed_availability_check check (observed_availability in ('IN_STOCK','OUT_OF_STOCK','UNAVAILABLE','UNKNOWN')),
  constraint product_availability_observed_confidence_check check (confidence in ('HIGH','MEDIUM','LOW','INCONCLUSIVE')),
  constraint product_availability_observed_metadata_check check (jsonb_typeof(metadata)='object')
);
create table if not exists public.product_source_observed (
  observation_id text primary key, product_id text not null references public.products(id) on delete restrict,
  source_kind text not null, source_name text not null, marketplace text, merchant text, source_url text not null,
  external_listing_id text, observed_at timestamptz not null, collection_method text not null, confidence text not null,
  correlation_id text not null, idempotency_key text unique, metadata jsonb not null default '{}'::jsonb,
  schema_version text not null default '1.0', created_at timestamptz not null default now(),
  constraint product_source_observed_confidence_check check (confidence in ('HIGH','MEDIUM','LOW','INCONCLUSIVE')),
  constraint product_source_observed_metadata_check check (jsonb_typeof(metadata)='object')
);
create table if not exists public.product_image_observed (
  observation_id text primary key, product_id text not null references public.products(id) on delete restrict,
  image_url text not null, image_hash text, source_name text not null, marketplace text, merchant text, source_url text not null,
  external_listing_id text, observed_at timestamptz not null, collection_method text not null, confidence text not null,
  correlation_id text not null, idempotency_key text unique, metadata jsonb not null default '{}'::jsonb,
  schema_version text not null default '1.0', created_at timestamptz not null default now(),
  constraint product_image_observed_confidence_check check (confidence in ('HIGH','MEDIUM','LOW','INCONCLUSIVE')),
  constraint product_image_observed_metadata_check check (jsonb_typeof(metadata)='object')
);
alter table public.product_price_observed enable row level security;
alter table public.product_availability_observed enable row level security;
alter table public.product_source_observed enable row level security;
alter table public.product_image_observed enable row level security;
