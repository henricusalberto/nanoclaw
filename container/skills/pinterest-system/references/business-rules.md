# Business Rules & Thresholds

## Decision Engine Rules
| Decision | Condition |
|----------|-----------|
| LEARNING | age ≤ 5 days |
| WATCH | total spend < €30 |
| SCALE | 7d ROAS ≥ target AND 3d ROAS ≥ target |
| KEEP | 7d ROAS ≥ 75% target, trend not down |
| KILL | spend ≥ €80 + 7d ROAS < 60% target + trending down; OR spend ≥ €30 + 7d ROAS < 50% target |

## Spend Hog / Splitter Detection
- 1 product ≥ 60% campaign spend (2 days) + ≥ 2 others ≤ 10% → recommend splitter
- Naming: `store_#NB_DD-MM-YYYY (no winner_product)`

## Revenue & Attribution
- Product revenue (Shopify URL match) > UTM revenue (~100% vs ~80% capture)
- All traffic = Pinterest-driven (incl. email marketing from Pinterest visitors)
- Klaviyo repeats excluded (`is_klaviyo_repeat = 0 OR NULL`)
- Currency: Pinterest = EUR, Shopify = USD (converted × 0.92)

## Campaign Naming
- Regular batch: `store_#N_DD-MM-YYYY`
- Splitter: `store_#NB_DD-MM-YYYY (no product1, product2)`
- Pinterest IDs have `C` prefix; Shopify UTMs have raw number

## Benchmarks
| Metric | Target | Min/Max |
|--------|--------|---------|
| ATC rate | 8% | min 4% |
| Checkout rate | 4% | min 2% |
| CVR | 1.5% | min 0.5% |
| Bounce rate | 80% | max 92% (lower=better) |
| CTR | 0.5% | min 0.3% |
| CPM | €10 | max €18 |
| CPC | €0.60 | max €1.20 |
| Frequency | 1.5 | max 2.5 |

## Ad Accounts
| ID | Name |
|----|------|
| `549768699527` | Maowowanglo |
| `549769338379` | Lieberteddy CT 2 |
| `549769316006` | Lieberteddy Creative Test account 1 |
