-- Cerberus Autonomous Curator — estado operacional, auditoria e identidade Shopee.
-- Fail-closed por padrão: o scheduler não publica até `enabled=true` após dry-run validado.

create table if not exists public.autonomous_curator_config (
  id text primary key default 'default' check (id = 'default'),
  enabled boolean not null default false,
  auto_publish_enabled boolean not null default true,
  auto_publish_threshold integer not null default 88 check (auto_publish_threshold between 70 and 100),
  review_threshold integer not null default 72 check (review_threshold between 50 and 99),
  max_daily_per_category integer not null default 1 check (max_daily_per_category between 0 and 3),
  max_search_candidates integer not null default 10 check (max_search_candidates between 1 and 10),
  max_enrich_per_category integer not null default 1 check (max_enrich_per_category between 1 and 3),
  updated_at timestamptz not null default now(),
  constraint autonomous_curator_threshold_order check (review_threshold < auto_publish_threshold)
);

insert into public.autonomous_curator_config (id)
values ('default')
on conflict (id) do nothing;

create table if not exists public.autonomous_curator_runs (
  id uuid primary key default gen_random_uuid(),
  run_date date not null,
  status text not null default 'running' check (status in ('running','completed','partial','failed','dry_run')),
  dry_run boolean not null default false,
  profile_version text not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  categories_total integer not null default 0,
  categories_processed integer not null default 0,
  auto_published integer not null default 0,
  review_required integer not null default 0,
  rejected integer not null default 0,
  failed integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists autonomous_curator_runs_real_date_uq
  on public.autonomous_curator_runs(run_date)
  where dry_run = false;

create index if not exists autonomous_curator_runs_started_idx
  on public.autonomous_curator_runs(started_at desc);

create table if not exists public.autonomous_curator_candidates (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.autonomous_curator_runs(id) on delete cascade,
  category text not null,
  search_query text not null,
  shop_id text,
  item_id text,
  source_product_url text,
  raw_title text,
  display_title text,
  score integer,
  score_breakdown jsonb not null default '{}'::jsonb,
  decision text not null check (decision in ('auto_selected','auto_published','review_required','rejected','failed','duplicate','no_candidate','dry_run_auto','dry_run_review')),
  reason text,
  product_id text,
  review_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(run_id, category)
);

create index if not exists autonomous_curator_candidates_identity_idx
  on public.autonomous_curator_candidates(shop_id, item_id)
  where shop_id is not null and item_id is not null;

create table if not exists public.product_source_identities (
  id uuid primary key default gen_random_uuid(),
  marketplace text not null,
  shop_id text not null,
  item_id text not null,
  source_product_url text not null,
  product_id text,
  review_id text,
  source text not null default 'autonomous_curator',
  reserved_run_id uuid references public.autonomous_curator_runs(id) on delete set null,
  reserved_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(marketplace, shop_id, item_id)
);

create unique index if not exists product_source_identities_product_uq
  on public.product_source_identities(product_id)
  where product_id is not null;

create index if not exists product_source_identities_review_idx
  on public.product_source_identities(review_id)
  where review_id is not null and product_id is null;

create table if not exists public.product_image_editorial_reviews (
  id uuid primary key default gen_random_uuid(),
  product_id text not null,
  source text not null default 'autonomous_curator',
  status text not null check (status in ('clean','review_required')),
  primary_image_url text,
  raw_image_urls jsonb not null default '[]'::jsonb,
  gallery_image_urls jsonb not null default '[]'::jsonb,
  assessments jsonb not null default '[]'::jsonb,
  model text,
  review_version text not null default '1.0',
  reviewed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists product_image_editorial_reviews_product_idx
  on public.product_image_editorial_reviews(product_id, reviewed_at desc);

-- Dados operacionais e de auditoria são exclusivamente backend/service-role.
-- Sem políticas públicas, RLS bloqueia anon/authenticated de forma fail-closed.
alter table public.autonomous_curator_config enable row level security;
alter table public.autonomous_curator_runs enable row level security;
alter table public.autonomous_curator_candidates enable row level security;
alter table public.product_source_identities enable row level security;
alter table public.product_image_editorial_reviews enable row level security;

comment on table public.autonomous_curator_config is 'Configuração fail-closed do motor diário de curadoria Shopee.';
comment on table public.autonomous_curator_runs is 'Auditoria de execuções diárias do Autonomous Curator.';
comment on table public.autonomous_curator_candidates is 'Resultado final por categoria em cada execução diária.';
comment on table public.product_source_identities is 'Identidade canônica marketplace para impedir republicação do mesmo item com outro link afiliado.';
comment on table public.product_image_editorial_reviews is 'Prova persistida da revisão visual usada em publicações automáticas.';
