# Design QA — Weekly editorial email

- Source visual truth:
  - Complete eight-product target: `[Teste controlado] Novidades da semana — Edição 2026-08-14 · 8 novos achados(1).pdf`
  - Dark mobile reference: `masthead-official-logo-390(1).png`
  - Dark desktop reference: `masthead-official-logo-768(2).png`
- Source dimensions: four A4 PDF pages plus 390 × 2400 px mobile and 768 × 2400 px desktop references
- Intended implementation viewports: 390 px and 768 px wide; A4 print/PDF export
- State represented: dark Cerberus Finds weekly editorial email with official compact masthead, edition number, hero product, microeditorials, two-column pairs, horizontal/compact product modules, closing statement, Instagram-only institutional link, and legal footer
- Design-test cardinality: exactly eight technically renderable products, matching the complete reference sequence
- Production cardinality: unchanged at 3–4 editorially approved products; the eight-product exception is isolated to the controlled design test and never changes canonical product eligibility

## Comparison evidence

- Full-view implementation screenshot: unavailable
- Focused comparison screenshot: unavailable
- Primary CTA interactions in browser: not exercised
- Browser console: not inspected because the preview page did not load
- Structural evidence (not a substitute for visual QA): the controlled design renderer now emits exactly eight cards and the same closed editorial block sequence as the supplied PDF. Automated tests assert the exact subject pattern, edition `08`, headline/deck, dark palette, compact official logo in email clients, large square logo only in print/PDF, Instagram-only footer, responsive tables, masked `/go/:ref` destinations, native Brevo unsubscribe token, and zero mutation of canonical products.

## Findings

- P0 visual findings from the received wrong email: none related to security or send controls
- P1 findings fixed structurally: three products instead of eight; incomplete module sequence; wrong subject/headline; oversized/incorrect print logo behavior; multiple social links instead of Instagram only
- P2 findings fixed structurally: design-test label and copy did not identify the complete eight-product controlled edition
- Preview blocker: the project development command starts the backend on port 3000 rather than the supervised preview port, so the isolated preview could not connect. A subsequent inline-document attempt was blocked by the browser security policy. No alternate browser surface was used and no browser comparison was fabricated.

## Final result

**blocked** — implementation and automated structural validation are complete, but strict browser-based visual comparison against both reference images could not be produced in this environment.
