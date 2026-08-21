# INFRA-03 — Phase 19 — Official Price Contract Investigation

## Status

**BLOCKED — CONTRACT UNSPECIFIED.** No authoritative specification was found that defines how the string returned in the Shopee Affiliate Brazil `productOfferV2.price` field maps to `priceMinorUnits`.

## Proof run

```text
PROOF_RUN_ID=INFRA03_PHASE19_PRICE_CONTRACT_20260820T053222Z
```

The investigation was documentation-only and read-only. It made no Shopee API call, used no browser, scraping, proxy, introspection, alternate endpoint, or bypass, and made no code, data, configuration, commit, push, or deployment change.

## Question evaluated

The question was whether an authoritative source specifies the type, currency, unit, decimal scale, monetary representation, rounding behavior, separators, and Brazil-specific semantics of the string returned by the Affiliate Brazil GraphQL operation `productOfferV2.price`, sufficiently to calculate the internal field `priceMinorUnits`.

The relevant internal contract exposes only `priceMinorUnits: number | null`. It does not expose a raw price string, currency, locale, scale, unit, or rounding metadata [6]. The Phase 17 controlled proof established only the runtime shape `price_present=true` and `price_type=string`; it intentionally did not preserve the value and did not prove monetary semantics [7].

## Official sources consulted

The official Shopee Open Platform overview describes the Open Platform as a set of APIs and services for sellers and lists seller-oriented product, order, and marketing capabilities [2]. It does not define the Affiliate Brazil GraphQL operation `productOfferV2` or its `price` field.

The official API Calls guide states that it applies to Shopee Open API v2.0 and documents the v2.0 API domains, HTTP/JSON request model, common parameters, and signature conventions [1]. It does not define the Affiliate Brazil GraphQL selection set or the scalar, unit, currency, scale, or rounding semantics of `productOfferV2.price`.

The official `v2.product.get_item_list` documentation is a different Open API v2 endpoint at `/api/v2/product/get_item_list` and belongs to the seller Product API surface [3]. Its existence does not establish a contract for the Affiliate Brazil GraphQL operation. No type or conversion rule for the target Affiliate `price` string was found in the extracted official page.

The official global-product publishing guide says that the `original_price` field is uploaded in local currency for that specific cross-border seller workflow [4]. That field, operation, and workflow are not the target Affiliate `productOfferV2.price` field. Reusing its local-currency statement would be an unsupported cross-API inference and is therefore rejected.

The repository's earlier source-coverage audit records the same authority boundary: the official Open Platform material did not confirm the Affiliate Brazil `productOfferV2` selection-set contract, while the Brazil Affiliate documentation located at the time was explicitly classified as non-official and was not treated as contractual authority [5]. No non-official documentation was used as normative evidence in this phase.

## Findings by required semantic dimension

```text
official type of target price field:
  NOT SPECIFIED.
  The real runtime observation is string, but no official target-contract scalar definition was found.

currency:
  NOT SPECIFIED.
  Brazil context alone does not authorize inferring BRL for this field.

unit:
  NOT SPECIFIED.
  No official statement identifies major monetary units, minor units, or another unit.

decimal scale:
  NOT SPECIFIED.
  No official fixed number of decimal places or scale factor was found.

monetary value versus minor units:
  NOT SPECIFIED.
  The target contract does not state whether a string such as "9900" means 9,900 major units,
  99.00 major units, 9,900 minor units, or another representation.

rounding rule:
  NOT SPECIFIED.
  No rounding, truncation, banker-rounding, or precision rule was found.

separator semantics:
  NOT SPECIFIED.
  No official rule was found for decimal separators, thousands separators, whitespace,
  currency symbols, or locale-dependent formatting.

Brazil-specific semantics:
  NOT SPECIFIED.
  The endpoint's Brazil host and credentials do not by themselves define the price encoding.

compatibility with priceMinorUnits:
  NOT SAFE TO ESTABLISH.
  The local field requires a normalized number, but the required transformation contract is absent.

official unambiguous transformation example:
  NOT FOUND.
  No official example was found that pairs a target Affiliate price string with a definitive
  currency, unit, scale, and resulting minor-unit number.
```

## Evidence versus inference

The directly observed evidence is limited to the fact that one real `productOfferV2` response carried a top-level `price` value whose runtime type was `string` [7]. The official Open Platform material confirms the existence and conventions of the separate v2 seller API surface, but it does not supply the missing Affiliate Brazil price contract [1] [2] [3]. The internal contract confirms that the consumer expects a numeric `priceMinorUnits` value but does not provide the transformation semantics [6].

It would be an inference, not an observation, to assume that the Brazil marketplace implies Brazilian reais, that a two-decimal display implies a factor of 100, or that a string containing digits represents minor units. It would also be an unsupported inference to borrow the local-currency statement for the unrelated global-product `original_price` field [4]. None of those inferences is permitted by this phase.

## Mathematical rule and example

No mathematical transformation is authorized.

The only safe rule remains:

```text
if the parser receives a finite numeric price already covered by the existing contract:
    preserve the existing numeric behavior
else:
    keep priceMinorUnits=null
```

No string-to-number example is supplied because the official contract does not make any candidate transformation unequivocal.

## Decision

```text
DECISION=B) BLOCKED — CONTRACT UNSPECIFIED
```

The result is not sufficient to implement a parser conversion safely. The fail-closed behavior from Phase 18 must remain unchanged: string `price` values stay `UNKNOWN` and `priceMinorUnits` stays `null`.

## Scope and execution confirmation

```text
Code changes: NONE
Parser changes: NONE
Evidence Bridge changes: NONE
N13: NOT EXECUTED
N14: NOT EXECUTED
N15: NOT EXECUTED
N16: NOT EXECUTED
N17+: NOT EXECUTED
Shopee real call: NOT EXECUTED
Database writes: NONE
Gates: NOT RUN — no code change occurred
Commit: NOT PERFORMED
Push: NOT PERFORMED
Deploy: NOT PERFORMED
```

No test, TypeScript, build, diff, or secret-scan gate was required because the phase explicitly prohibited code changes and no code changed. The next minimum safe action is to obtain an authoritative Affiliate Brazil contract or an official vendor clarification that explicitly states the field's currency, unit, scale, precision, separator, and rounding semantics. Only after that contract is documented and approved may a separate implementation phase be considered.

## References

[1]: https://open.shopee.com/developer-guide/16 "Shopee Open Platform — API calls"
[2]: https://open.shopee.com/developer-guide/4 "Shopee Open Platform — What is Shopee Open Platform?"
[3]: https://open.shopee.com/documents/v2/v2.product.get_item_list?module=89&type=1 "Shopee Open Platform — v2.product.get_item_list"
[4]: https://open.shopee.com/developer-guide/215 "Shopee Open Platform — Publishing global product"
[5]: infra03_phase13_source_coverage.md "Cerberus INFRA-03 Phase 13 source-coverage audit"
[6]: ../server/commercial/affiliate/shopeeClientContracts.ts "Cerberus Shopee client contracts"
[7]: infra03_phase17_price_shape_probe.md "Cerberus INFRA-03 Phase 17 price-shape probe"
