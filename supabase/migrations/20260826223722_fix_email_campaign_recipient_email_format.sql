-- Alinha a validação de formato dos recipients à validação canônica de newsletter_subscribers.
-- A alteração não modifica endereços, consentimento, status ou qualquer dado de subscriber.

begin;

alter table public.email_campaign_recipients
  drop constraint email_campaign_recipients_email_format_check;

alter table public.email_campaign_recipients
  add constraint email_campaign_recipients_email_format_check check (
    subscriber_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$'
  );

commit;
