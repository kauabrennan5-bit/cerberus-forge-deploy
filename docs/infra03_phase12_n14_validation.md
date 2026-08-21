# INFRA-03 Phase 12 — Controlled N13 → N14 Validation

## Status

`READY FOR REVIEW`

The controlled production proof completed the authorized chain `Shopee official API → N3 research → candidate_evidence → N13 curation → N14 Commercial Brain`. N13 returned `PASS`. N14 executed successfully and its replay returned `identical_duplicate` with the same decision digest, score, band, rationale inputs, and idempotency key.

This report does not claim a commercial approval, an N15 decision, a publication decision, or a successful score when the evidence did not support one. N14 correctly returned `band=INSUFFICIENT`, `confidence=LOW`, `coverage=0`, `dimensions_used=[]`, and `score=null` because all six commercial dimensions remained `UNKNOWN`. This is a fail-closed analytical result, not a fabricated score.

The report label below is an operational correlation label assigned from the persisted N14 timestamp. It is not a backend-generated authorization artifact.

`PROOF_RUN_ID = INFRA03_PHASE12_N14_CORRECTED_20260820T034801Z`

## Scope and stop boundary

The authorized scope was production validation of N13 → N14 only. N15, N16, N17, N18, N19, N20, publication, affiliate-link creation, Telegram, scheduler, agents, job_queue, and canonical product mutation were not invoked.

The proof used the existing production backend at `https://cerberus-forge-deploy.onrender.com` and the current served SHA `7fd48567753bec51186db1ceb423fbc726931c51`.

## Previous failure and correction

The previous attempt created candidate `can-dfaa82fafc7229360330d22b`, but the executor read the administrative password multiple times. Only the first read received input; later reads sent empty headers. N3 therefore returned HTTP 401 with the sanitized error `Senha ausente`, and N13 correctly returned `BLOCKED` because no evidence was linked.

The correction was limited to the temporary proof executor. It reads the password once, keeps it in memory for the duration of the proof, reuses the authenticated header for every authorized call, and unsets it on process exit. No backend code, schema, production configuration, credential, N13 rule, N14 rule, or marketplace adapter was changed.

## Candidate and N3 research proof

The corrected proof created the following temporary candidate:

`candidate_id = can-5535b68499b1bba6179fef60`

The candidate used `marketplace=Shopee`, the official Shopee product URL, `external_listing_id=23794344926`, `metadata.shop_id=1530442944`, and `metadata.provenance=n10:discovery`. The candidate was removed during governed cleanup.

N3 returned HTTP 201 with:

`research_id = rs-sha256:12242ba599e6d0515`

`session_evidence_id = evi-sha256:30b652a4a9a2ec865`

The official API evidence summary was:

`title = KNOWN, source=api, quality=HIGH`

`price = UNKNOWN`

`images = UNKNOWN`

`seller = UNKNOWN`

`rating = UNKNOWN`

`review_count = UNKNOWN`

`availability = UNKNOWN`

`category = UNKNOWN`

The evidence summary is an observation from the real N3 response. It is not a canonical product update and did not change `products`.

## N13 result and replay

N13 call A returned HTTP 200 with `outcome=evaluated` and `verdict=PASS`.

The N13 decision digest was:

`sha256:e9d7cc23204532d7dbcbf484e929799e933aac284ed23e606654c886a1c648c4`

N13 call B, with the identical payload and candidate, returned HTTP 200 with `outcome=identical_duplicate` and `verdict=PASS`.

The N13 replay digest matched call A exactly. The persisted N13 assessment identifier linked into the N14 record was:

`cur-988d3e38d62f131096a3ae397dcca701a563e2bd`

The N13 PASS was structural and evidence-backed. It did not imply sufficient commercial evidence, N15 approval, or permission to publish.

## N14 result and replay

N14 call A was executed only after N13 PASS and returned HTTP 200 with `outcome=evaluated`.

The decision result was:

`score = null`

`band = INSUFFICIENT`

`confidence = LOW`

`coverage = 0`

`dimensions_used = []`

`dimensions_unknown = [availability, commission, competition, market, price, seller]`

`digest = sha256:a94a8ea9ff661bb42b2181e85578e7e9cca2dd4b7f40758e10269c68f68784b3`

`idempotency_key = cb-a94a8ea9ff661bb42b2181e85578e7e9cca2dd4b7f40758e10269c68f68784b3`

The N14 persisted assessment was obtained through the read-only GET route:

`assessment_id = cb-5535b68499b1bba6179fef60`

`filter_version = n14:commercial_brain_v1`

`classification = null`

`recommendation = null`

`is_actionable = false`

`persisted N13 gate verdict = PASS`

N14 call B returned HTTP 200 with `outcome=identical_duplicate`. Its score, band, coverage, unknown dimensions, decision digest, and decision idempotency key matched call A exactly.

The result demonstrates deterministic replay and correct UNKNOWN handling. The real Shopee response exposed only a title among the fields used by the research bridge; it did not provide enough provenance-backed commercial dimensions for N14 to assign a numeric score. The system therefore preserved `UNKNOWN` and did not inflate the score with zeros or inferred values.

The decision digest exposed by N14 and the persisted assessment row's database idempotency key are distinct fields in the existing contract. The decision digest and replay key were identical across the two N14 calls; the persisted row remained singular, as verified by `assessment_id` and the `identical_duplicate` outcome.

## Cleanup

Cleanup was performed selectively and in the required order using `RETURNING` and the exact temporary candidate ID:

1. `publication_executions` — completed first.
2. `candidate_assessment` — removed the temporary N13 and N14 assessments.
3. `candidate_evidence` — removed the evidence created by N3 for the proof candidate.
4. `candidates` — removed the temporary candidate last.

No `TRUNCATE` and no broad deletion was used. No canonical product, affiliate link, job, publication, or commercial cycle was deleted or changed.

## Baseline before and after

The baseline before the corrected proof was:

`products=13`

`candidates=0`

`candidate_evidence=0`

`candidate_assessment=0`

`affiliate_links=0`

`job_queue=0`

`publication_executions=0`

`commercial_cycles=0`

The post-cleanup baseline was identical:

`products=13`

`candidates=0`

`candidate_evidence=0`

`candidate_assessment=0`

`affiliate_links=0`

`job_queue=0`

`publication_executions=0`

`commercial_cycles=0`

## Gates

`npm test` — PASS, 1358/1358 tests passed.

`npx tsc --noEmit` — PASS.

`npm run build` — PASS.

`git diff --check` — PASS.

`/health` — HTTP 200, status `ok`, served SHA `7fd48567753bec51186db1ceb423fbc726931c51`.

The repository was not clean at gate start despite the inherited context stating that it was clean. The working tree contained 28 pre-existing untracked paths, including earlier INFRA reports, N16 reports, the Mercado Livre source directory, and its test file. No such file was modified, removed, staged, committed, pushed, or deployed during this phase. This is recorded as an unexpected pre-existing workspace divergence and is intentionally left for review.

The generic secret scan returned a warning because it matched seven pre-existing tracked files containing placeholders, test passwords, an example environment assignment, and a token-shaped test fixture. The scan emitted no values. No production credential was printed or added by this phase. The flagged files were not modified.

## Production and repository changes

No backend source file was changed. No migration was applied. No Render configuration was changed. No commit, push, or deploy was performed.

The only project deliverable created by this phase is this report. The temporary proof scripts and response files were stored outside the repository under `/tmp`.

## Final decision

`N13 = PASS`

`N13 replay = PASS / identical_duplicate`

`N14 = evaluated / INSUFFICIENT`

`N14 replay = identical_duplicate`

`N14 numeric score = not assigned because evidence coverage was zero`

`N15 = NOT EXECUTED`

`N16 = NOT EXECUTED`

`N17+ = NOT EXECUTED`

`PUBLICATION = NOT EXECUTED`

The authorized Phase 12 boundary is complete. The system is ready for human review, with the score insufficiency and the pre-existing workspace/secret-scan findings explicitly preserved as review items. No N15 validation should begin without explicit authorization.

## References

[1]: https://cerberus-forge-deploy.onrender.com/health "Cerberus Forge production health endpoint"
[2]: https://github.com/kauabrennan5-bit/cerberus-forge-deploy "Cerberus Forge Deploy repository"
[3]: https://shopee.com.br/product/1530442944/23794344926 "Shopee product identity used by the controlled proof"
