-- Keep the products display-title lifecycle compatible with the Autonomous Curator.
-- Existing states remain valid; `reviewed` is the terminal state emitted by both
-- continuous curator workers after editorial title review metadata is recorded.
alter table public.products
  drop constraint if exists products_display_title_status_check;

alter table public.products
  add constraint products_display_title_status_check
  check (display_title_status = any (array[
    'ready'::text,
    'unreviewed'::text,
    'review_required'::text,
    'reviewed'::text
  ]));
