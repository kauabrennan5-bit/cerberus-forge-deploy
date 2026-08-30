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

update public.autonomous_curator_config
set max_enrich_per_category = greatest(max_enrich_per_category, 4),
    updated_at = now();
