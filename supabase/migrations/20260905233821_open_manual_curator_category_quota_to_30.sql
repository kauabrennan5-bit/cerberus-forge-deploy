-- Manual-review mode may prepare up to 30 products per category.
-- Automatic publication remains explicitly disabled.

alter table public.autonomous_curator_config
  drop constraint if exists autonomous_curator_config_max_daily_per_category_check;

alter table public.autonomous_curator_config
  add constraint autonomous_curator_config_max_daily_per_category_check
  check (max_daily_per_category >= 0 and max_daily_per_category <= 30);

update public.autonomous_curator_config
set max_daily_per_category = 30,
    enabled = true,
    auto_publish_enabled = false,
    updated_at = now()
where id = 'default';
