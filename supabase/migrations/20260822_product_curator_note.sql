-- PROMPT 100 — NÃO EXECUTAR SEM APROVAÇÃO MANUAL EXPLÍCITA.
-- Campo aditivo e opcional. Não cria nem altera produtos existentes.

begin;

alter table public.products
  add column if not exists curator_note text;

alter table public.products
  drop constraint if exists products_curator_note_length_check,
  add constraint products_curator_note_length_check
    check (curator_note is null or char_length(curator_note) between 1 and 500);

comment on column public.products.curator_note is
  'Nota editorial opcional aprovada pelo curador. Não é exibida quando vazia.';

commit;
