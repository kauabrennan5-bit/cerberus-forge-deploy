# Cerberus Cloudflare Zero-Cost Migration

Status: PARALLEL MIGRATION — CURRENT PRODUCTION MUST REMAIN UNCHANGED

## Non-negotiable constraints

1. Do not suspend, delete, downgrade, or reconfigure the current Render production services during migration.
2. Do not alter the current production domain or DNS until explicit cutover approval.
3. Do not change production Supabase schema/data destructively.
4. Do not weaken Shopee identity, affiliate-link, publication, human-approval, security, newsletter, or editorial gates.
5. New infrastructure must be designed to fail closed on free-tier limits instead of generating paid usage.
6. Migration work stays isolated on `migration/cloudflare-zero-cost` until validated.

## Target architecture

- Cloudflare Static Assets / Pages: public React/Vite storefront, always available without server sleep.
- Supabase: canonical product/catalog/runtime state.
- Cloudflare Worker: lightweight HTTP APIs and Telegram webhook.
- GitHub Actions: bounded heavy curator/newsletter/maintenance jobs.
- Shopee Affiliate API: discovery and affiliate links.
- Gemini/OpenAI: optional/budgeted editorial and visual enrichment.
- Brevo: newsletter provider.

## Key architectural changes

- Remove public-site dependency on an always-on Node/Express server.
- Stop using Git commit + deploy as the catalog publication mechanism.
- Read public catalog from Supabase.
- Replace long-running polling workers with event/cron driven execution.
- Replace Telegram polling with webhook execution.
- Run heavy autonomous curator cycles in bounded jobs instead of a permanent Render process.
- Preserve the existing production deployment until the parallel environment passes acceptance.

## Migration phases

### Phase 0 — Baseline and freeze boundaries
- Inventory current Render services, GitHub workflows, Supabase dependencies, environment variables, routes, jobs and external providers.
- Define parity checklist and rollback/cutover contract.

### Phase 1 — Public site parallel deployment
- Adapt React/Vite build for static hosting.
- Make catalog pages consume Supabase/public API without requiring Express.
- Deploy a separate Cloudflare preview hostname.
- Do not touch the current Render URL/domain.

### Phase 2 — Lightweight API and Telegram
- Move webhook-safe APIs to Cloudflare Worker.
- Keep secrets server-side.
- Validate Telegram commands/callbacks and human approval flows in isolated test mode.

### Phase 3 — Curator runtime
- Extract autonomous curator entrypoints so GitHub Actions can execute them directly.
- Persist state in Supabase rather than process memory.
- Remove dependency on Render health/SHA endpoints.
- Keep existing editorial, identity, image, affiliate, deduplication and publication gates.

### Phase 4 — Newsletter and scheduled work
- Convert permanent polling loops to bounded scheduled/event jobs.
- Preserve weekly approval and send safety contract.

### Phase 5 — Parallel acceptance
- Compare current Render production and Cloudflare candidate for catalog, product pages, redirects, Telegram, curator, newsletter, analytics and failure behavior.
- Validate free-tier usage budgets.

### Phase 6 — Optional cutover
- Only after explicit human approval: move public DNS/domain to Cloudflare candidate.
- Keep old Render deployment available for rollback during the agreed observation window.
- Render shutdown/removal is a separate explicit action and is not part of migration acceptance.

## Acceptance rule

No production cutover and no Render shutdown happens automatically. The current production remains the authority until the user explicitly approves cutover after parity validation.
