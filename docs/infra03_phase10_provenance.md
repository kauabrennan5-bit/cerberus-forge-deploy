# INFRA-03 — Fase 10 — Provenance Contract Audit and Local Correction

## Status

**READY FOR REVIEW — LOCAL ONLY.**

The provenance audit identified a real contract gap and applied the smallest local correction authorized by the phase. No production request, real Shopee call, database write, commit, push, deploy, N14, N15, N16, or N17 execution was performed during this phase.

## Proof context

The previous controlled validation reached the legitimate N13 `BLOCKED` state because the candidate did not contain `metadata.provenance`. The N13 engine reads the candidate's `metadata.provenance`; `metadata.source`, `source_type`, and `collection_method` are not substitutes for candidate provenance.

The canonical value already recognized by the N13 contract is:

```text
n10:discovery
```

The candidates schema already supports the `metadata` JSON object. No migration or schema change was required.

## Root cause

The N2 discovery path normalized the listing and persisted a candidate through `registerCandidate`, but its metadata payload did not include the canonical `provenance` member. The same payload included `metadata.source`, which describes the source of an observed field and is semantically different from the candidate's provenance. Consequently, the N3 Shopee Evidence Bridge and the N3 `candidate_evidence` records could be correct while N13 still failed the independent `c_provenance_valid` criterion.

The N3 research service was not changed in this phase. It correctly persists evidence and does not mutate candidate provenance. The N13 engine was not changed. Its fail-closed behavior remains the governing authority.

## Minimal correction

The N2 registration payload in `server/commercial/discovery/discover.ts` now includes:

```text
metadata.provenance = "n10:discovery"
```

The correction applies to the normal discovery registration path for both supported marketplaces because the provenance describes the N2 operation, not a marketplace-specific observation. The collection source remains represented separately. The Mercado Livre scrape behavior was not changed. No candidate is promoted to a canonical product by this patch.

## Tests added

The local test changes cover the required contract boundaries:

```text
1. Shopee discovery persists metadata.provenance="n10:discovery".
2. N13 recognizes the canonical Shopee discovery provenance and keeps the candidate eligible only at the N13 boundary.
3. Missing provenance remains BLOCKED.
4. Unrecognized provenance remains BLOCKED.
5. Existing N13 replay coverage confirms identical decision, assessment identity, and digest.
```

The tests use local fakes and deterministic fixtures. They do not call Shopee, Render, Supabase, Telegram, scheduler, agents, publication, or affiliate acquisition.

## Gates

```text
npm test: PASS — 1358/1358
npx tsc --noEmit: PASS
npm run build: PASS
git diff --check: PASS
secret scan: PASS — no credential values detected
focused discovery + N13 tests: PASS — 55/55
```

## Baseline

Supabase was queried in read-only mode after the local validation. The observed baseline remained:

```text
products=13
candidates=0
candidate_evidence=0
candidate_assessment=0
affiliate_links=0
job_queue=0
publication_executions=0
commercial_cycles=0
```

No writes were executed in this phase.

## Scope verification

The current Phase 10 tracked diff is limited to:

```text
server/commercial/discovery/discover.ts
tests/discovery.test.ts
tests/curationPipelineN13.test.ts
```

No N3 research code, N13 engine or service, N14, N15, N16, N17, publication, Telegram, scheduler, agents, catalog, products, schema migration, credentials, or deployment configuration was modified.

Existing reports and other untracked files from earlier phases were not included in the Phase 10 correction and remain uncommitted.

## Execution boundary

This phase stops at local review. The following actions remain explicitly unauthorized and were not performed:

```text
real Shopee proof
production candidate creation
production N3 or N13 execution
N14 execution
N15 execution
N16 execution
N17 execution
commit
push
deploy
```

The correction is **READY FOR REVIEW**, not consolidated and not live. A separate authorization is required before any commit, push, deploy, or production re-validation.

## Evidence files

```text
server/commercial/discovery/discover.ts
server/commercial/discovery/research.ts
server/commercial/sources/shopee/adapter.ts
server/commercial/curation/engine.ts
server/repositories/candidatesRepository.ts
supabase/migrations/20260816_candidates.sql
tests/discovery.test.ts
tests/curationPipelineN13.test.ts
```
