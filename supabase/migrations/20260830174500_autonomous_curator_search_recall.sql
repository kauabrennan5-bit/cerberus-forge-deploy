-- Expand autonomous curator discovery recall without lowering any quality gate.
-- The Shopee API remains capped at 10 offers per search page; this migration
-- increases how many ranked candidates may receive the expensive full
-- affiliate/extraction/image/editorial/pipeline evaluation in one category.

alter table public.autonomous_curator_config
  drop constraint if exists autonomous_curator_config_max_enrich_per_category_check;

alter table public.autonomous_curator_config
  add constraint autonomous_curator_config_max_enrich_per_category_check
  check (max_enrich_per_category >= 1 and max_enrich_per_category <= 20);

update public.autonomous_curator_config
set max_search_candidates = 10,
    max_enrich_per_category = 16,
    updated_at = now()
where id = 'default';
