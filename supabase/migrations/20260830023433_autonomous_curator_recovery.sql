-- Autonomous Curator recovery: editorial image storage + deeper bounded candidate retries.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-editorial',
  'product-editorial',
  true,
  12582912,
  array['image/png', 'image/jpeg', 'image/webp']::text[]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types,
    updated_at = now();

-- The original schema intentionally capped enrichment at 3 candidates/category.
-- Recovery needs 4 while remaining strictly bounded, so widen only to the
-- exact new ceiling before updating the operational config.
alter table public.autonomous_curator_config
  drop constraint if exists autonomous_curator_config_max_enrich_per_category_check;

alter table public.autonomous_curator_config
  add constraint autonomous_curator_config_max_enrich_per_category_check
  check (max_enrich_per_category between 1 and 4);

update public.autonomous_curator_config
set max_enrich_per_category = greatest(max_enrich_per_category, 4),
    updated_at = now();
