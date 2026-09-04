-- Restored from LIVE supabase_migrations history (version 20260828012117).
-- Permite envio geral direto após aprovação e confirmação humana explícita.
-- Mantém o fluxo legado aprovado -> test_sent -> envio e exige pares consistentes
-- para todos os timestamps e atores de confirmação/teste.

begin;

alter table public.email_campaigns
  drop constraint if exists email_campaigns_state_timestamps_check;

alter table public.email_campaigns
  add constraint email_campaigns_state_timestamps_check check (
    (status in ('draft', 'pending_approval')
      and approved_at is null
      and approved_by_telegram_id is null
      and test_sent_at is null
      and test_sent_by_telegram_id is null
      and general_send_confirmed_at is null
      and general_send_confirmed_by_telegram_id is null
      and sent_at is null)
    or (status = 'approved'
      and approved_at is not null
      and approved_by_telegram_id is not null
      and test_sent_at is null
      and test_sent_by_telegram_id is null
      and ((general_send_confirmed_at is null and general_send_confirmed_by_telegram_id is null)
        or (general_send_confirmed_at is not null and general_send_confirmed_by_telegram_id is not null))
      and sent_at is null)
    or (status = 'test_sent'
      and approved_at is not null
      and approved_by_telegram_id is not null
      and test_sent_at is not null
      and test_sent_by_telegram_id is not null
      and ((general_send_confirmed_at is null and general_send_confirmed_by_telegram_id is null)
        or (general_send_confirmed_at is not null and general_send_confirmed_by_telegram_id is not null))
      and sent_at is null)
    or (status = 'sending'
      and approved_at is not null
      and approved_by_telegram_id is not null
      and ((test_sent_at is null and test_sent_by_telegram_id is null)
        or (test_sent_at is not null and test_sent_by_telegram_id is not null))
      and general_send_confirmed_at is not null
      and general_send_confirmed_by_telegram_id is not null
      and sent_at is null)
    or (status = 'sent'
      and approved_at is not null
      and approved_by_telegram_id is not null
      and ((test_sent_at is null and test_sent_by_telegram_id is null)
        or (test_sent_at is not null and test_sent_by_telegram_id is not null))
      and general_send_confirmed_at is not null
      and general_send_confirmed_by_telegram_id is not null
      and sent_at is not null)
    or (status = 'failed'
      and approved_at is not null
      and approved_by_telegram_id is not null
      and ((test_sent_at is null and test_sent_by_telegram_id is null)
        or (test_sent_at is not null and test_sent_by_telegram_id is not null))
      and general_send_confirmed_at is not null
      and general_send_confirmed_by_telegram_id is not null
      and sent_at is null)
    or (status = 'cancelled' and sent_at is null)
  );

commit;
