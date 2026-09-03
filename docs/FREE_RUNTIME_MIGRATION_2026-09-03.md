# Cerberus free runtime migration — 2026-09-03

Migration is parallel and fail-closed. The existing Render backend remains in service until the free public runtime and Telegram gateway are validated.

## Public runtime
- Storefront: Render Static Site `cerberus-design-static` (CDN/static, no Node web process).
- Public catalog read: Supabase Edge Function `cerberus-public-api`.
- Telegram ingress: Supabase Edge Function `cerberus-telegram-gateway`, which acknowledges Telegram immediately and forwards the original official secret header to the canonical backend for final verification.
- Canonical database: existing Supabase project.

## Backend
- Existing backend URL remains canonical for admin/mutations, Operator, Curator and newsletter workers.
- `TELEGRAM_AUTO_CONFIGURE_WEBHOOK=true` enables boot-time reconciliation of the configured webhook.
- `TELEGRAM_WEBHOOK_URL` must point to the Edge gateway.
- Existing `TELEGRAM_WEBHOOK_SECRET` is preserved; the gateway never needs to know its value.
- No newsletter send/approval is part of migration validation.

## Cost-zero cutover
After gates and runtime validation, change the existing Render backend compute plan from Starter to Free. This preserves the service URL and its existing secrets. Public browsing/catalog no longer depends on this process being awake. GitHub Actions already supplies scheduled external Curator/watchdog triggers; Telegram ingress acknowledges at Edge before background forwarding to the backend.
