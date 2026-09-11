begin;

-- pgcrypto is installed in the extensions schema in production. Keep SECURITY
-- DEFINER functions on an explicit trusted search path so digest() resolves
-- without exposing them to public-schema object shadowing.
alter function public.cerberus_telegram_register_update(bigint,text)
  set search_path = pg_catalog, extensions;
alter function public.cerberus_telegram_mark_update(bigint,text,text)
  set search_path = pg_catalog, extensions;
alter function public.cerberus_telegram_discard_review(text,text,text,text,text)
  set search_path = pg_catalog, extensions;
alter function public.cerberus_telegram_publish_review(text,text,text,text,text)
  set search_path = pg_catalog, extensions;
alter function public.cerberus_telegram_apply_rotation(uuid,text,text,text,text)
  set search_path = pg_catalog, extensions;
alter function public.cerberus_telegram_rotation_decision(uuid,text,text,text,text,text)
  set search_path = pg_catalog, extensions;

commit;
