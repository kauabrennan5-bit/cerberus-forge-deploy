-- Product fields present in LIVE without independent versions in the remote
-- migration ledger. Kept outside supabase/migrations to avoid retroactive push.
begin;

alter table public.products add column if not exists curator_note text;
alter table public.products
  drop constraint if exists products_curator_note_length_check,
  add constraint products_curator_note_length_check check (curator_note is null or char_length(curator_note) between 1 and 500);

alter table public.products
  add column if not exists raw_title text,
  add column if not exists display_title text;
alter table public.products
  drop constraint if exists products_raw_title_length_check,
  add constraint products_raw_title_length_check check (raw_title is null or char_length(raw_title) between 3 and 500),
  drop constraint if exists products_display_title_length_check,
  add constraint products_display_title_length_check check (display_title is null or char_length(display_title) between 3 and 90);

alter table public.products add column if not exists oferta_promocional jsonb;
alter table public.products drop constraint if exists products_oferta_promocional_shape_check;
alter table public.products add constraint products_oferta_promocional_shape_check
  check (
    oferta_promocional is null or (
      jsonb_typeof(oferta_promocional) = 'object'
      and jsonb_typeof(oferta_promocional -> 'price') = 'number'
      and (oferta_promocional ->> 'price')::numeric > 0
      and oferta_promocional ->> 'condition' in ('pix', 'pix_with_coupon', 'coupon', 'other')
      and oferta_promocional ->> 'source' = 'admin_confirmed'
      and jsonb_typeof(oferta_promocional -> 'confirmedAt') = 'number'
      and (oferta_promocional ->> 'confirmedAt')::numeric > 0
      and jsonb_typeof(oferta_promocional -> 'benefits') = 'array'
    )
  );

commit;
