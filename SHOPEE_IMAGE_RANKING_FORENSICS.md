# Shopee image/ranking forensics — 2026-08-31

Read-only reproduction from the live backend before this hotfix:

- `/shopee luminária 2`
- provider query executed: yes
- official candidates received: 10
- candidates retained/examined by the command: 8
- cards: 0
- final internal result: `NO_QUALIFIED_REPLACEMENT_FOUND`

The previous pool target was `requested * 4`, so requesting 2 truncated the first official page from 10 candidates to 8 before qualification. The command processed candidates in provider order; there was no deterministic final ranking.

The decisive image bottleneck was the command's dependency on `extractProductForReview` followed by `readinessErrors()`: any `imageEditorialStatus !== clean` became `IMAGE_REVIEW_REQUIRED`, and every readiness error was then treated as a final candidate rejection. The command therefore had no state equivalent to `NEEDS_HUMAN_REVIEW`.

Observed rejection distribution for the eight candidates actually examined in the reproduced command:

- 4 × `no_commercial_image:off_brand_high=3`
- 1 × `no_commercial_image:technical_high=4`
- 1 × `no_commercial_image:off_brand_high=5,collage_high=1`
- 1 × `no_commercial_image:off_brand_high=3,off_brand_medium=1`
- 1 × `no_commercial_image:off_brand_high=2,logo_high=2`

The final two official candidates from the first page were never evaluated because of the pool cap. Older logs cannot retroactively provide their image HTTP/MIME/dimensions; the hotfix adds masked per-candidate diagnostics for the next controlled run.

A separate relevance defect was also observed: at least one official result for the lighting search was a bedside table. The previous command did not rank by query/category relevance before expensive qualification.

This document contains no credentials, affiliate links, full product URLs, item IDs, shop IDs, emails or Telegram tokens.
