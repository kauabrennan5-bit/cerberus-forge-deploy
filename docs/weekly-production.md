# Weekly production contract

The production newsletter is a human-gated workflow. No scheduled job approves
or sends a campaign.

## Friday schedule

- `09:30 America/Fortaleza` (`12:30 UTC`): read-only production preflight. It
  reads configuration, audience reconciliation state, products and previous
  editions, then posts a Telegram diagnostic. It does not write products or
  campaigns and never calls the Brevo campaign API.
- `10:00 America/Fortaleza` (`13:00 UTC`): draft generation. A successful run
  persists one `pending_approval` campaign and its immutable editorial snapshot.
  It does not create recipients or a Brevo marketing campaign.

## Freshness and cutoff

Production freshness starts strictly after the most recent campaign satisfying
all of these predicates: `campaign_type = collection`, `edition_key LIKE
'weekly:%'`, `status = sent`, and non-null `sent_at`. Test editions, welcome
messages and manual collections do not advance the cutoff. If no production
weekly has ever been sent, `NEWSLETTER_WEEKLY_INITIAL_LOOKBACK_DAYS` is used,
clamped to 1–30 days and defaulting to 7.

A product freshness timestamp is `max(created_at,
validPromotion.confirmedAt)`. An expired or malformed promotion never creates
freshness and never replaces the canonical base price.

## Product gates

A candidate must be active, published, have a valid ref and destination, a
public category, positive canonical price, a current editorial display-title
review, and a current clean image review. The image review stores the reviewed
URLs, per-image decision/confidence/reason, selected primary image, model,
version, timestamp and SHA-256 of the selected URL. Changing the selected image
invalidates that proof. The selected image must still belong to the canonical
image set and both title/image reviews must use the current contract version.
Raw marketplace titles are never a weekly fallback.

## Ranking and composition

Ranking is deterministic: statistical confidence, clicks, freshness, then
product ID. Textually near-duplicate products in the same category are removed
using title-token Jaccard similarity of at least 0.70.

The top-ranked product is always the hero. The edition is thematic when the
hero category has at least three products and represents at least 60% of the
strong top-six pool. Otherwise it is diversified: ranking quality is preserved,
normally no more than two products per category, and weak products are never
added solely to satisfy diversity. Every edition needs three or four products.

## Approval and send gates

The first Telegram click first reloads and compares the canonical products with
the immutable draft snapshot. Only unchanged content can move from
`pending_approval` to `approved`; it then synchronizes the production audience
and shows a second button with the verified count. It does not create a Brevo
campaign and cannot send email. A failed audience sync persists a pending count
instead of reusing an older ready value.

The second explicit click records final confirmation. Immediately before any
Brevo campaign creation, the backend reloads every canonical product and
compares ref, editorial title, category, base price, valid promotion, approved
image and fingerprint, link identity and product ID against the approved
snapshot. It then synchronizes the audience again and requires a positive exact
match with the count displayed at approval. Any content, expiry, approval-TTL or
audience change blocks delivery and requires regeneration/review.

Weekly copy has its own Gemini responsibility and model setting
(`GEMINI_WEEKLY_COPY_MODEL`), separate from product curation and image review.
The 09:30 preflight checks both configuration and the live in-process weekly
copy budget; exhausted budget blocks readiness before draft time.
