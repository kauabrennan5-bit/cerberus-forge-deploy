-- Cerberus Finds Archive — Bloco N6 — Affiliate Economics + Link Resolution
-- Migration estritamente aditiva: CRIA as tabelas public.affiliate_providers
-- e public.affiliate_links.
-- NÃO altera, remove ou recria nenhuma tabela, coluna, índice ou policy existente.
-- NÃO altera public.products, public.candidates nem o catálogo canônico.
-- Padrão: RLS ON, zero policies públicas, CHECKs fechados (catálogos),
-- idempotência (PKs determinísticas + unique de digest), auditável.
--
-- Fronteiras de governança:
--   AFFILIATE LINK != PRODUCT FACT   (o link nunca promove candidato nem
--   produto; não existe FK que permita promoção implícita)
--   AFFILIATE LINK != AUTHORITY      (registrar/validar um link NÃO autoriza
--   publicação — publicar segue exclusivamente o N5: DECISION + Policy
--   Engine + ApprovalStore)
--   SEM PROVENIÊNCIA -> SEM AUTORIDADE (provenance fechada em
--   'admin:manual'; valores derivados/inferidos são rejeitados)
--   O sistema JAMAIS armazena credenciais, tokens ou API keys aqui;
--   credential_ref é referência opaca ao ambiente do backend (env vars),
--   nunca o segredo em si.
--
-- MarketplaceSource alinhado ao catálogo fechado do N2 (MarketplaceSource):
--   MercadoLivre | Shopee — 'Outro' não faz parte do catálogo N6 v1.

-- ============================================================
-- Tabela 1: Affiliate Provider Registry
-- ============================================================
create table if not exists public.affiliate_providers (
  provider_id text primary key,
  provider_code text not null unique check (char_length(provider_code) between 2 and 32),
  name text not null check (char_length(name) between 2 and 120),
  -- Catálogo fechado de marketplaces do N2 (alinhado a MarketplaceSource)
  marketplace text not null check (marketplace in ('MercadoLivre', 'Shopee')),
  -- Programa real de afiliados (ex.: "Shopee Affiliates BR", "ML Afiliados e Criadores")
  program_name text not null default '' check (char_length(program_name) <= 160),
  -- Catálogo fechado de status. Sem inventar novos estados sem autorização:
  --   ACTIVE             — provider registrado e apto a ter links resolvidos
  --   INACTIVE           — suspenso pelo admin; links existentes não são usados
  --   PENDING_REVIEW     — aguardando confirmação/verificação humana
  --   WITHDRAWN          — retirado pela autoridade humana; histórico preservado
  status text not null default 'PENDING_REVIEW'
    check (status in ('ACTIVE', 'INACTIVE', 'PENDING_REVIEW', 'WITHDRAWN')),
  -- Resolução de links: v1 só permite MANUAL (admin registra o link do painel
  -- do programa). IMPORT/PORTAL/API são evolutivos e NÃO entram sem nova
  -- autorização contratual.
  resolution_method text not null default 'MANUAL'
    check (resolution_method in ('MANUAL', 'IMPORT', 'PORTAL', 'API')),
  -- Autoria/propriedade da adesão ao programa:
  --   owner-human — a adesão a programas de afiliados é sempre humana
  --   (cadastro, aprovação e credenciais vivem fora do sistema)
  ownership text not null default 'owner-human'
    check (ownership in ('owner-human')),
  -- Proveniência fechada v1: somente 'admin:manual'.
  provenance text not null default 'admin:manual'
    check (provenance in ('admin:manual')),
  -- Referência opaca ao ambiente do backend (env var do Render), NUNCA o
  -- segredo em si. Ex.: 'env:SHOPEE_AFFILIATE_REF' ou vazio.
  credential_ref text not null default '' check (char_length(credential_ref) <= 120),
  -- Termos públicos do programa (não inventados): URL da página oficial
  terms_url text not null default '' check (char_length(terms_url) <= 512),
  notes text not null default '' check (char_length(notes) <= 2000),
  -- Auditoria e versão
  contract_version text not null default '1.0',
  idempotency_key text unique,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_by text not null default 'operator-admin',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.affiliate_providers is 'Bloco N6: Affiliate Provider Registry — programas de afiliados declarados explicitamente por autoridade humana. NUNCA tratar registro como adesão efetiva, credencial válida ou autorização de publicação. A adesão real a programas de afiliados é sempre humana e externa.';

-- Índices aditivos
create index if not exists idx_affiliate_providers_status on public.affiliate_providers (status);
create index if not exists idx_affiliate_providers_marketplace on public.affiliate_providers (marketplace);
create index if not exists idx_affiliate_providers_provider_code on public.affiliate_providers (provider_code);
create index if not exists idx_affiliate_providers_resolution_method on public.affiliate_providers (resolution_method);

-- ============================================================
-- Tabela 2: Affiliate Link Record
-- ============================================================
create table if not exists public.affiliate_links (
  link_id text primary key,
  -- Alvo: candidato OU produto canônico (um link pertence a um alvo de cada
  -- vez; texto referencial — SEM FK: AFFILIATE LINK != PRODUCT FACT e sem
  -- promoção implícita de candidato).
  candidate_id text,
  product_id text,
  marketplace text not null check (marketplace in ('MercadoLivre', 'Shopee')),
  provider_id text not null references public.affiliate_providers (provider_id) on delete restrict,
  -- A URL rastreada fornecida explicitamente. URL pública de afiliado não é
  -- segredo; pode ser logada com metadados de proveniência.
  affiliate_url text not null check (char_length(affiliate_url) between 12 and 2048),
  -- Proveniência fechada v1: somente 'admin:manual'.
  provenance text not null default 'admin:manual'
    check (provenance in ('admin:manual')),
  -- Catálogo fechado de estados do link:
  --   DRAFT          — registrado, ainda não validado
  --   VALID          — validado (estrutura + domínio + redirect) e aprovado
  --                    para USO pelo executor N5 (não é autorização de
  --                    publicação por si só)
  --   EXPIRED        — passou de expires_at declarado
  --   INVALID        — reprovado na validação
  --   REVOKED        — revogado pela autoridade humana; histórico preservado
  status text not null default 'DRAFT'
    check (status in ('DRAFT', 'VALID', 'EXPIRED', 'INVALID', 'REVOKED')),
  -- Catálogo fechado do resultado da última validação:
  --   UNVALIDATED    — validação ainda não executada (padrão; nunca vira
  --                    APPROVED artificialmente)
  --   VALID          — todas as checagens passaram
  --   INVALID        — ao menos uma checagem falhou (rejeitado)
  --   INCONCLUSIVE   — checagem externa não pôde ser concluída localmente
  --                    (ex.: fetch indisponível) — permanece não-aprovado
  --   PENDING_EXTERNAL — aguardando checagem viva futura
  validation_state text not null default 'UNVALIDATED'
    check (validation_state in ('UNVALIDATED', 'VALID', 'INVALID', 'INCONCLUSIVE', 'PENDING_EXTERNAL')),
  -- Detalhes da validação (motivos de falha, hosts, redirect final)
  validation_result jsonb not null default '{}'::jsonb check (jsonb_typeof(validation_result) = 'object'),
  -- Digest idempotente: sha256(provider_id:target:affiliate_url)
  digest text not null unique,
  observed_at timestamptz not null default now(),
  expires_at timestamptz null,
  notes text not null default '' check (char_length(notes) <= 2000),
  -- Auditoria e versão
  contract_version text not null default '1.0',
  idempotency_key text unique,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_by text not null default 'operator-admin',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Regra: um link pertence a exatamente um alvo (candidato XOR produto).
  constraint affiliate_links_exactly_one_target check (
    (candidate_id is not null)::int + (product_id is not null)::int = 1
  )
);
comment on table public.affiliate_links is 'Bloco N6: Affiliate Link Record — link de afiliado fornecido EXPLICITAMENTE por autoridade humana. AFFILIATE LINK != PRODUCT FACT: o registro NÃO promove candidato, NÃO cria produto canônico e NÃO autoriza publicação. Uso na publicação exige DECISION + Policy Engine + ApprovalStore (N5).';

-- CHECKs: sem target vazio e sem marketplace/URL genéricos (defesa em profundidade)
alter table public.affiliate_links add constraint affiliate_links_no_target_empty
  check (candidate_id is not null or product_id is not null);

-- Índices aditivos: alvo, provider, status, digest (idempotência), expiração
create index if not exists idx_affiliate_links_candidate on public.affiliate_links (candidate_id) where candidate_id is not null;
create index if not exists idx_affiliate_links_product on public.affiliate_links (product_id) where product_id is not null;
create index if not exists idx_affiliate_links_provider on public.affiliate_links (provider_id);
create index if not exists idx_affiliate_links_status on public.affiliate_links (status);
create index if not exists idx_affiliate_links_validation on public.affiliate_links (validation_state);
create index if not exists idx_affiliate_links_marketplace on public.affiliate_links (marketplace);
create index if not exists idx_affiliate_links_expires on public.affiliate_links (expires_at) where expires_at is not null;

-- ============================================================
-- Row Level Security: ativo; SEM políticas públicas
-- (somente service role / backend, igual aos Blocos N1-N5/13/14/15/16/17)
-- ============================================================
alter table public.affiliate_providers enable row level security;
alter table public.affiliate_links enable row level security;

-- Garantir que nenhuma policy pública exista (idempotente).
do $$
declare
  _pol record;
begin
  for _pol in (
    select policyname from pg_policies
    where tablename = 'affiliate_providers' and schemaname = 'public'
  ) loop
    execute format('drop policy if exists %I on public.affiliate_providers', _pol.policyname);
  end loop;
  for _pol in (
    select policyname from pg_policies
    where tablename = 'affiliate_links' and schemaname = 'public'
  ) loop
    execute format('drop policy if exists %I on public.affiliate_links', _pol.policyname);
  end loop;
end $$;
