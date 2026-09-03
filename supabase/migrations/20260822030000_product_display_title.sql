-- PROMPT 100 — NÃO EXECUTAR SEM APROVAÇÃO MANUAL EXPLÍCITA.
-- Preserva o campo canônico existente `produto`; não reprocessa, não altera e
-- não preenche automaticamente nenhum produto histórico.

begin;

alter table public.products
  add column if not exists raw_title text,
  add column if not exists display_title text;

alter table public.products
  drop constraint if exists products_raw_title_length_check,
  add constraint products_raw_title_length_check
    check (raw_title is null or char_length(raw_title) between 3 and 500),
  drop constraint if exists products_display_title_length_check,
  add constraint products_display_title_length_check
    check (display_title is null or char_length(display_title) between 3 and 90);

comment on column public.products.raw_title is
  'Título observado na fonte. Campo opcional, preservado sem normalização automática.';
comment on column public.products.display_title is
  'Título editorial curto em PT-BR destinado à vitrine. Campo opcional; produto permanece fallback canônico.';

commit;
