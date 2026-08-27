-- Fonte canônica administrativa para links públicos de redes sociais.
-- Esta migration é local nesta tarefa e não deve ser aplicada sem autorização explícita.

begin;

create table if not exists public.social_links (
  network text primary key check (network in ('instagram', 'tiktok', 'facebook', 'youtube', 'x', 'pinterest')),
  url text not null check (
    char_length(btrim(url)) between 12 and 2048
    and left(lower(btrim(url)), 8) = 'https://'
    and url !~ '[[:space:]]'
  ),
  updated_at timestamptz not null default now()
);

create index if not exists social_links_updated_idx
  on public.social_links (updated_at desc);

alter table public.social_links enable row level security;
revoke all on table public.social_links from public;
revoke all on table public.social_links from anon;
revoke all on table public.social_links from authenticated;
grant all on table public.social_links to service_role;

commit;
