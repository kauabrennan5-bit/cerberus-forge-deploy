-- Cerberus Bloco 13: observações temporais e contextuais sobre products.
-- Migration aditiva e reversível por escopo; não altera public.products nem insere dados.
-- Observação não é verdade canônica, decisão comercial ou publicação.

create table if not exists public.product_price_observed (
  observation_id text primary key,
  product_id text not null references public.products(id) on delete restrict,
  observed_price numeric(14,2) not null check (observed_price >= 0),
  currency text not null default 'BRL' check (char_length(currency) = 3),
  source_name text not null,
  marketplace text,
  merchant text,
  source_url text not null,
  external_listing_id text,
  observed_at timestamptz not null,
  collection_method text not null,
  confidence text not null check (confidence in ('HIGH', 'MEDIUM', 'LOW', 'INCONCLUSIVE')),
  correlation_id text not null,
  idempotency_key text unique,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  schema_version text not null default '1.0',
  created_at timestamptz not null default now()
);

create table if not exists public.product_availability_observed (
  observation_id text primary key,
  product_id text not null references public.products(id) on delete restrict,
  observed_availability text not null check (observed_availability in ('IN_STOCK', 'OUT_OF_STOCK', 'UNAVAILABLE', 'UNKNOWN')),
  source_name text not null,
  marketplace text,
  merchant text,
  source_url text not null,
  external_listing_id text,
  observed_at timestamptz not null,
  collection_method text not null,
  confidence text not null check (confidence in ('HIGH', 'MEDIUM', 'LOW', 'INCONCLUSIVE')),
  correlation_id text not null,
  idempotency_key text unique,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  schema_version text not null default '1.0',
  created_at timestamptz not null default now()
);

create table if not exists public.product_source_observed (
  observation_id text primary key,
  product_id text not null references public.products(id) on delete restrict,
  source_kind text not null,
  source_name text not null,
  marketplace text,
  merchant text,
  source_url text not null,
  external_listing_id text,
  observed_at timestamptz not null,
  collection_method text not null,
  confidence text not null check (confidence in ('HIGH', 'MEDIUM', 'LOW', 'INCONCLUSIVE')),
  correlation_id text not null,
  idempotency_key text unique,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  schema_version text not null default '1.0',
  created_at timestamptz not null default now()
);

create table if not exists public.product_image_observed (
  observation_id text primary key,
  product_id text not null references public.products(id) on delete restrict,
  image_url text not null,
  image_hash text,
  source_name text not null,
  marketplace text,
  merchant text,
  source_url text not null,
  external_listing_id text,
  observed_at timestamptz not null,
  collection_method text not null,
  confidence text not null check (confidence in ('HIGH', 'MEDIUM', 'LOW', 'INCONCLUSIVE')),
  correlation_id text not null,
  idempotency_key text unique,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  schema_version text not null default '1.0',
  created_at timestamptz not null default now()
);

create index if not exists product_price_observed_product_idx on public.product_price_observed(product_id, observed_at desc);
create index if not exists product_price_observed_source_idx on public.product_price_observed(source_name, observed_at desc);
create index if not exists product_price_observed_correlation_idx on public.product_price_observed(correlation_id, observed_at desc);

create index if not exists product_availability_observed_product_idx on public.product_availability_observed(product_id, observed_at desc);
create index if not exists product_availability_observed_source_idx on public.product_availability_observed(source_name, observed_at desc);
create index if not exists product_availability_observed_correlation_idx on public.product_availability_observed(correlation_id, observed_at desc);

create index if not exists product_source_observed_product_idx on public.product_source_observed(product_id, observed_at desc);
create index if not exists product_source_observed_source_idx on public.product_source_observed(source_name, observed_at desc);
create index if not exists product_source_observed_correlation_idx on public.product_source_observed(correlation_id, observed_at desc);

create index if not exists product_image_observed_product_idx on public.product_image_observed(product_id, observed_at desc);
create index if not exists product_image_observed_source_idx on public.product_image_observed(source_name, observed_at desc);
create index if not exists product_image_observed_correlation_idx on public.product_image_observed(correlation_id, observed_at desc);

alter table public.product_price_observed enable row level security;
alter table public.product_availability_observed enable row level security;
alter table public.product_source_observed enable row level security;
alter table public.product_image_observed enable row level security;

-- O backend usa a service role. Nenhuma leitura ou escrita pública é permitida.
-- Não criar policies anon/authenticated para estas tabelas.

comment on table public.product_price_observed is 'Preço observado em uma fonte e instante; não substitui products.preco nem é decisão comercial.';
comment on table public.product_availability_observed is 'Disponibilidade observada em uma fonte e instante; não substitui o lifecycle de products.';
comment on table public.product_source_observed is 'Origem/listing observada; não cria nem redefine a identidade canônica do produto.';
comment on table public.product_image_observed is 'Imagem observada em uma fonte e instante; não substitui products.imagens.';
