begin;
alter function public.cerberus_telegram_register_update(bigint,text) set search_path = pg_catalog, extensions;
alter function public.cerberus_telegram_mark_update(bigint,text,text) set search_path = pg_catalog, extensions;
alter function public.cerberus_telegram_discard_review(text,text,text,text,text) set search_path = pg_catalog, extensions;
alter function public.cerberus_telegram_publish_review(text,text,text,text,text) set search_path = pg_catalog, extensions;
alter function public.cerberus_telegram_apply_rotation(uuid,text,text,text,text) set search_path = pg_catalog, extensions;
alter function public.cerberus_telegram_rotation_decision(uuid,text,text,text,text,text) set search_path = pg_catalog, extensions;
commit;
