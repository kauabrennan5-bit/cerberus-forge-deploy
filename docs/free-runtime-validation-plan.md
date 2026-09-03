# Integrated validation before Render Free downgrade

Validation is read-only with respect to newsletter delivery and must not publish products.

Required evidence:
1. Static storefront home returns 200.
2. A direct `/produto/...` SPA route returns 200.
3. Supabase Edge public catalog returns active/published products.
4. Storefront `catalog-runtime.json` points at the Edge catalog.
5. Telegram status reports canonical gateway URL, secret configured, API healthy and backend ready.
6. Operator external workflow completes one bounded OIDC health cycle.
7. Autonomous Curator external workflow can run in `status` mode without publication; production schedule remains the existing single curator trigger.
8. Daily invariant is read from the latest curator run; validation does not manufacture completion state.
9. No newsletter `sendNow`, approval, weekly draft, audience mutation or product publication is invoked by this validation.
