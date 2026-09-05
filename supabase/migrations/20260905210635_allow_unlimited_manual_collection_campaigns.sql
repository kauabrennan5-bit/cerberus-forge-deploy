-- Restore the LIVE schema change that allows independent manual collection campaigns.

create or replace function public.rekey_manual_collection_campaign()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.campaign_type = 'collection'
     and new.edition_key is not null
     and new.edition_key like 'collection:%' then
    new.edition_key := 'manual:' || new.id::text || ':' || new.edition_key;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_rekey_manual_collection_campaign on public.email_campaigns;
create trigger trg_rekey_manual_collection_campaign
before insert on public.email_campaigns
for each row
execute function public.rekey_manual_collection_campaign();
