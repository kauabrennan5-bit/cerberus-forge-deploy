-- Defense in depth: the production configuration itself cannot be toggled into
-- autonomous publication. Application code and the products publication guard
-- independently enforce the same invariant.

update public.autonomous_curator_config
set auto_publish_enabled = false,
    updated_at = now()
where auto_publish_enabled is distinct from false;

alter table public.autonomous_curator_config
  drop constraint if exists autonomous_curator_manual_publication_only;

alter table public.autonomous_curator_config
  add constraint autonomous_curator_manual_publication_only
  check (auto_publish_enabled = false);

comment on constraint autonomous_curator_manual_publication_only on public.autonomous_curator_config is
  'Cerberus invariant: Curator may create Telegram reviews but may never auto-publish products.';
