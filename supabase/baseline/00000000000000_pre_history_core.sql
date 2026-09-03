-- Canonical pre-history baseline for rebuilding Cerberus from an empty Supabase project.
--
-- IMPORTANT: this file is intentionally OUTSIDE supabase/migrations.
-- Production already contained these objects before the first recorded migration
-- (20260814). Keeping the baseline outside the live migration directory prevents
-- `supabase db push` from treating this snapshot as a pending production migration.
-- The Supabase Rebuild Gate applies this file only to a fresh local database.

begin;

create table if not exists public.products (
  id text primary key,
  ref text,
  produto text not null,
  categoria text not null,
  preco numeric not null,
  imagens jsonb not null default '[]'::jsonb,
  link text not null,
  ativo boolean default true,
  destaque boolean default false,
  status text default 'published',
  created_by text default 'system',
  slug text,
  descricao text,
  pagina_ponte_url text,
  created_at timestamptz default now()
);

create table if not exists public.catalog_categories (
  name text primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create sequence if not exists public.product_clicks_id_seq;

create table if not exists public.product_clicks (
  id bigint primary key default nextval('public.product_clicks_id_seq'::regclass),
  product_id text not null,
  product_slug text,
  product_name text,
  product_price numeric(10,2) default 0.00,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  fbclid text,
  gclid text,
  ttclid text,
  referrer text,
  landing_page text,
  user_agent text,
  ip_address text,
  created_at timestamptz not null default timezone('utc'::text, now())
);

alter sequence public.product_clicks_id_seq owned by public.product_clicks.id;

create index if not exists idx_product_clicks_created_at on public.product_clicks(created_at);
create index if not exists idx_product_clicks_product_id on public.product_clicks(product_id);
create index if not exists idx_product_clicks_product_slug on public.product_clicks(product_slug);

alter table public.products enable row level security;
alter table public.catalog_categories enable row level security;
alter table public.product_clicks enable row level security;

-- Production has RLS enabled and no public policies for these tables.

commit;
