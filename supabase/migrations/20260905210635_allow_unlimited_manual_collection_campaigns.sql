create or replace function public.rekey_manual_collection_campaign()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Telegram/manual collection drafts use the legacy `collection:` key family.
  -- They are intentionally repeatable: every explicit admin action is a new campaign.
  -- Automated weekly campaigns use `weekly:` / `weekly-test:` and keep their own
  -- duplicate-send/idempotency protections unchanged.
  if new.campaign_type = 'collection'
     and new.edition_key is not null
     and new.edition_key like 'collection:%' then
    new.edition_key := 'manual:' || new.id::text || ':' || new.edition_key;
  end if;
  return new;
end;
$$;

revoke all on function public.rekey_manual_collection_campaign() from public, anon, authenticated;

drop trigger if exists trg_rekey_manual_collection_campaign on public.email_campaigns;
create trigger trg_rekey_manual_collection_campaign
before insert on public.email_campaigns
for each row
execute function public.rekey_manual_collection_campaign();

-- Remove the legacy canonical key from already-created manual collection campaigns
-- so the application-level precheck no longer blocks the next explicit admin draft.
update public.email_campaigns
set edition_key = 'manual:' || id::text || ':' || edition_key
where campaign_type = 'collection'
  and edition_key is not null
  and edition_key like 'collection:%';
