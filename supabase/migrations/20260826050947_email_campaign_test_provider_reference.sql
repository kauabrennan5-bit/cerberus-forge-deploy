-- FOLLOW-UP — persistência da referência do teste administrativo.
-- Não recria email_campaigns; a migration base já foi aplicada no ambiente remoto.
-- Não altera newsletter_subscribers, consentimento, outbox, Q7 ou recipients.

begin;

alter table public.email_campaigns
  add column if not exists test_provider_message_id text;

comment on column public.email_campaigns.test_provider_message_id is
  'Referência retornada pelo provider para o teste administrativo; nullable para preservar campanhas existentes.';

commit;
