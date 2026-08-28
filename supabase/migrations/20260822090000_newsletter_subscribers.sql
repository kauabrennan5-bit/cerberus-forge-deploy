-- PROMPT 100 — NÃO EXECUTAR SEM APROVAÇÃO MANUAL EXPLÍCITA.
-- A escrita legítima ocorre somente no backend com Service Role. Não há policy
-- pública de SELECT, INSERT, UPDATE ou DELETE e RLS permanece habilitado.

begin;

create table if not exists public.newsletter_subscribers (
  email text primary key,
  created_at timestamptz not null default now(),
  constraint newsletter_subscribers_email_normalized_check
    check (email = lower(btrim(email))),
  constraint newsletter_subscribers_email_format_check
    check (email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$')
);

create index if not exists newsletter_subscribers_created_at_idx
  on public.newsletter_subscribers (created_at desc);

alter table public.newsletter_subscribers enable row level security;

revoke all on table public.newsletter_subscribers from anon, authenticated;

comment on table public.newsletter_subscribers is
  'Inscrições de newsletter. Acesso exclusivo do backend com Service Role; sem leitura pública.';

commit;
