# Design QA — Weekly editorial email

- Source visual truth:
  - Mobile: `/workspace/scratch/4ede867e2381/upload/masthead-official-logo-390(1).png`
  - Desktop: `/workspace/scratch/4ede867e2381/upload/masthead-official-logo-768(2).png`
- Source dimensions: 390 × 2400 px (mobile) and 768 × 2400 px (desktop)
- Intended implementation viewports: 390 px and 768 px wide
- State represented: dark Cerberus Finds weekly editorial email with masthead, hero product, two-column product pair, horizontal/compact product modules, closing statement, social link, and legal footer
- Production cardinality: the renderer preserves the weekly contract of 3–4 approved products; it does not invent a fifth product when fewer than the five cards shown in the reference are eligible

## Comparison evidence

- Full-view implementation screenshot: unavailable
- Focused comparison screenshot: unavailable
- Primary CTA interactions in browser: not exercised
- Browser console: not inspected because the preview page did not load
- Structural evidence (not a substitute for visual QA): the weekly renderer now delegates to the canonical editorial renderer that produced the supplied reference design; automated tests assert its exact dark palette, official masthead logo and dimensions, editorial block order, responsive table structure, footer links, masked `/go/:ref` destinations, native Brevo unsubscribe token, and 3/4-product behavior

## Findings

- P0 visual findings: unknown; no rendered browser evidence was available
- P1 visual findings: unknown; no rendered browser evidence was available
- P2 visual findings: unknown; no rendered browser evidence was available
- Preview blocker: the supervised isolated preview runtime failed before the cloud browser could connect to the local route (`ERR_CONNECTION_REFUSED`). The allowed preview-start attempts were exhausted, so no browser screenshot or interaction proof was fabricated.

## Final result

**blocked** — implementation and automated structural validation are complete, but strict browser-based visual comparison against both reference images could not be produced in this environment.
