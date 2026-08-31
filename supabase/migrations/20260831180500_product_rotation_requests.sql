create table if not exists public.product_rotation_requests (
  id uuid primary key default gen_random_uuid(),
  source_product_id text not null references public.products(id),
  category text not null,
  status text not null default 'searching'
    check (status in ('searching','candidate_ready','applying','replaced','cancelled','failed')),
  requested_by text not null,
  telegram_chat_id text not null,
  candidate_product_id text null references public.products(id),
  replacement_product_id text null references public.products(id),
  rejected_candidate_ids text[] not null default '{}'::text[],
  reason text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz null
);

create index if not exists product_rotation_requests_source_idx
  on public.product_rotation_requests (source_product_id, created_at desc);

create index if not exists product_rotation_requests_status_idx
  on public.product_rotation_requests (status, updated_at desc);

alter table public.product_rotation_requests enable row level security;

comment on table public.product_rotation_requests is
  'Persisted Telegram-initiated product replacement workflow. Old product remains public until an explicitly approved candidate passes revalidation and catalog synchronization.';
