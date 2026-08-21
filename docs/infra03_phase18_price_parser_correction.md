# INFRA-03 — Fase 18 — Safe Price Parser Correction

## Status

**READY FOR REVIEW — FAIL-CLOSED.** The real Shopee response shape was documented by Phase 17 as a top-level string, but the project contract does not document the unit, scale, currency, locale, or conversion rule required to derive `priceMinorUnits`. Therefore, the safe correction is to preserve `priceMinorUnits = null` for every non-numeric price input. No parser conversion was introduced.

## Proof run

`PROOF_RUN_ID=INFRA03_PHASE18_PRICE_PARSER_CORRECTION_20260820T052547Z`

The local repository HEAD used for the gates was `40ae71568f2b5f9e484541818912dd18d213cb1c`. The production health endpoint also served HTTP 200 with version `40ae71568f2b5f9e484541818912dd18d213cb1c` at `2026-08-20T05:23:56.667Z`.

## Objective and authorized scope

The objective was to resolve the Phase 17 parser ambiguity without making a new Shopee call, changing N13–N17, changing the Evidence Bridge unnecessarily, or inventing a monetary unit. The executed scope was limited to local regression coverage, static validation, build validation, a production health check, and a read-only Supabase baseline verification.

No Shopee API call was made during Phase 18. No candidate, evidence, assessment, affiliate link, publication execution, job, or commercial cycle was created or modified.

## Evidence and technical decision

Phase 17 observed the following sanitized runtime shape from one real official `productOfferV2` call [1]:

```text
price_present=true
price_type=string
price_keys=[]
classification=PRICE_SHAPE_CONFIRMED_NON_NUMERIC
```

The current parser in `server/commercial/affiliate/shopeeApiClient.ts` accepts `obj.price` only when its runtime type is `number` [2]. The internal contract in `server/commercial/affiliate/shopeeClientContracts.ts` exposes only `priceMinorUnits: number | null`; it does not define a string-price field or a documented scale and unit for conversion [3].

The strings `"9900"` and `"99.00"` are both syntactically plausible but semantically ambiguous. Without a documented contract, either could represent major units, minor units, or another marketplace-specific representation. Converting either value would therefore create an unsupported fact and could corrupt downstream commercial decisions.

The exact fail-closed rule is:

```text
if price is a finite number:
    preserve the existing numeric behavior
else:
    set priceMinorUnits = null
```

No trimming, decimal parsing, currency inference, locale inference, scaling, rounding, fallback conversion, or permissive coercion was added.

## Files changed

The only Phase 18 implementation file changed was:

```text
tests/shopeeAffiliateIntegration.test.ts
```

The test additions cover five regression cases:

```text
1. Numeric string "9900" remains priceMinorUnits=null.
2. Decimal string "99.00" remains priceMinorUnits=null.
3. Invalid string remains priceMinorUnits=null.
4. Empty string remains priceMinorUnits=null.
5. Absent price remains priceMinorUnits=null.
```

The existing numeric-price test remains unchanged and continues to verify the established numeric behavior.

The following file was intentionally not changed:

```text
server/commercial/affiliate/shopeeApiClient.ts
```

The parser diff is empty because the existing implementation already fails closed for non-numeric input. The Evidence Bridge, N13, N14, N15, N16, and N17 were not changed.

The working tree contains pre-existing untracked reports and files from earlier INFRA/N16 work. They were not included in the Phase 18 implementation diff and were not committed.

## Test and validation gates

The focused Shopee integration suite passed:

```text
47 tests passed
0 failed
16 suites passed
```

The full test gate passed:

```text
1362 tests passed
0 failed
92 suites passed
```

The TypeScript gate passed:

```text
npx tsc --noEmit = PASS
```

The production build passed. It generated the frontend and server bundles and obtained the expected 13-product projection from the backend. The existing chunk-size advisory remained informational and was not introduced by Phase 18.

The whitespace and patch validation passed:

```text
git diff --check = PASS
```

The refined high-confidence secret scan found no matches. A broader heuristic identified one pre-existing file, `scripts/prova_viva_fase_d.sh`, because of a generic credential-like pattern; no secret value was printed, and the file was not changed. No Phase 18 file contains a credential.

The formatting sanity check passed:

```text
literal backslash-n count in tests/shopeeAffiliateIntegration.test.ts = 0
```

The production health check passed:

```text
GET https://cerberus-forge-deploy-backend.onrender.com/health
HTTP_STATUS=200
status=ok
version=40ae71568f2b5f9e484541818912dd18d213cb1c
```

## Database baseline

The inherited pre-phase baseline was recorded in the active task context and is repeated here for comparison:

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

A read-only Supabase query after the Phase 18 gates returned:

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

No database write, cleanup, migration, deletion, or publication operation was performed.

## Pipeline execution status

The following stages were not executed:

```text
N13 = NOT EXECUTED
N14 = NOT EXECUTED
N15 = NOT EXECUTED
N16 = NOT EXECUTED
N17 = NOT EXECUTED
```

No N13 PASS, N14 score, N15 APPROVED, digest, provenance transition, publication, or downstream artifact was fabricated.

## Commit, push, and deploy status

```text
Commit = NOT PERFORMED
Push = NOT PERFORMED
Deploy = NOT PERFORMED
```

Production remains on the previously served SHA `40ae71568f2b5f9e484541818912dd18d213cb1c`. The Phase 18 regression tests remain local and uncommitted.

## Residual dependency and next step

The remaining dependency is authoritative documentation or an explicit project contract defining the unit, scale, currency, locale, and rounding semantics of the Shopee string price. Until that contract exists, `priceMinorUnits` must remain `null` for string inputs, and downstream commercial scoring must treat the price as unknown.

The phase is stopped at **READY FOR REVIEW**. No commit, push, deploy, new Shopee call, N13+, or N17 execution is authorized by this phase.

## References

[1]: infra03_phase17_price_shape_probe.md "INFRA-03 Phase 17 sanitized price-shape probe"
[2]: ../server/commercial/affiliate/shopeeApiClient.ts "Shopee API client parser"
[3]: ../server/commercial/affiliate/shopeeClientContracts.ts "Shopee client contracts"
