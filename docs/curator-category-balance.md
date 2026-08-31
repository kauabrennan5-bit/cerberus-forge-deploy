# Cerberus Autonomous Curator — category balance

Public inventory contract:

- 10 public categories.
- Exactly 2 active published products per category.
- If a category has fewer than 2 products, the continuous curator bypasses the 24h cooldown for that category-recovery phase and keeps trying on scheduled cycles until coverage is restored.
- Quality, image, similarity, affiliate-link and pipeline publication gates are unchanged.
- After all categories have 2 products, normal cadence is one new eligible product per category only after at least 24 hours.
- When the daily new product is publicly validated, the oldest prior visible product in that category is archived so the category remains at 2.
- During bootstrap, successful publications produced for a category that was already full are archived by the coordinator before the balancing catalog sync; sparse categories retain the new product.

The original Continuous Curator V2 discovery and scoring engine is preserved unchanged in `autonomousCuratorContinuousV2Base.ts`; `autonomousCuratorContinuousV2.ts` coordinates the inventory policy around it.
