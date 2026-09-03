# Free runtime Operator cutover

- `OPERATOR_SCHEDULER_MODE=external` disables only the in-process `setInterval`; the Operator V2 implementation remains the single execution authority.
- `.github/workflows/operator-health.yml` obtains GitHub OIDC and invokes exactly one bounded `/api/internal/operator/health-cycle` run.
- Autonomous Curator already uses `.github/workflows/autonomous-curator.yml` with OIDC; no second Curator scheduler is introduced.
- Newsletter production send/approval paths are unchanged.
- Public storefront and catalog remain on the static storefront + Supabase Edge runtime, independent of backend process availability.
