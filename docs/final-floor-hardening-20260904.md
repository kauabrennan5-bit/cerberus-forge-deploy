# Final floor hardening — 2026-09-04

Scope: production Autonomous Curator resilience and Shopee price evidence.

- OpenAI remains the primary semantic provider.
- Gemini query expansion uses a primary + fallback model chain.
- Gemini semantic ranking is a discovery-only fallback when OpenAI is unavailable; it cannot publish.
- Publication gates remain unchanged: image review, category, price, pipeline, similarity and score threshold 88.
- Shopee price fallback is identity-bound and persisted with source + observedAt provenance.
- Legacy numeric product prices without provenance are not trusted as discovery evidence by themselves.
- Effective daily target/live catalog target are written explicitly to run metadata so stale values do not survive between cycles.
- Telegram V2 remains a dedicated workflow plus the global embedded contract; branch-protection enforcement is configured separately at repository administration level.
