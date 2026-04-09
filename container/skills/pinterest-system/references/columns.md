# Dashboard Data Fields (data.py output)

## KPI Cards
| Field | Description |
|-------|-------------|
| `kpi_spend` | Total Pinterest spend (EUR) for date range |
| `kpi_rev` | Total Shopify revenue (EUR, ×0.92 from USD) |
| `kpi_roas` | `kpi_rev / kpi_spend` |
| `kpi_rev_pin` | Pinterest-attributed revenue only (for reference) |
| `kpi_orders` | Total Shopify order count |
| `kpi_aov` | Average order value (EUR) |

## Campaign Table
| Field | Description |
|-------|-------------|
| `campaign_id` | Pinterest campaign ID |
| `campaign_name` | Campaign name (parsed for store/batch) |
| `spend` | Total spend (EUR) |
| `impressions` | Total impressions |
| `clicks` | Outbound clicks |
| `ctr` | Click-through rate |
| `cpm` | Cost per mille |
| `cpc` | Cost per click |
| `roas_7d` | 7-day ROAS |
| `roas_3d` | 3-day ROAS |
| `decision` | Engine recommendation (KILL/SCALE/KEEP/WATCH/LEARNING) |
| `daily_budget` | Current daily budget from budget snapshot |
| `budget_history` | List of budget changes over time |

## Product Table
| Field | Description |
|-------|-------------|
| `product_name` | Product name |
| `product_handle` | Shopify product handle |
| `spend` | Total ad spend attributed |
| `revenue` | Shopify revenue (URL-matched) |
| `roas` | Product-level ROAS |
| `orders` | Order count |
| `sessions` | Shopify sessions (from funnel) |
| `atc_rate` | Add-to-cart rate |
| `checkout_rate` | Checkout initiation rate |
| `cvr` | Conversion rate |
| `bounce_rate` | Bounce rate |
| `cogs` | Cost of goods (from Google Sheets) |
| `target_roas` | Target ROAS (from Google Sheets) |

## Charts
| Field | Description |
|-------|-------------|
| `chart_daily` | Daily spend vs revenue (bar chart data) |
| `chart_roas_trend` | 14-day ROAS trend line |
