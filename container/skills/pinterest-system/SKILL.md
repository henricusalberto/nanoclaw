---
name: pinterest-system
description: "Full Pinterest dropshipping analytics system — pipeline, dashboard, decision engine, data ingestion, and Shopify integration. Use when: working on Pinterest ad performance, campaign analysis, dashboard features, pipeline debugging, data ingestion, benchmarks, kill/scale decisions, funnel metrics, COGS, or any code in the pinterest-system directory."
---

# Pinterest Analytics System

## Directory Layout
```
~/.openclaw/workspace/BUSINESSES/pinterest-store/code/
├── pinterest/                        ← Main Python package
│   ├── dashboard/
│   │   ├── app.py                   ← Flask web app (live dashboard, port 8765)
│   │   ├── data.py                  ← All SQL queries → returns dict
│   │   ├── benchmarks.py            ← BENCHMARKS thresholds + diagnose_product()
│   │   └── render.py                ← HTML generation from data dict
│   ├── ingest/
│   │   ├── shopify.py               ← Shopify orders → SQLite
│   │   ├── shopify_products.py      ← Product catalogue + prices
│   │   ├── shopify_funnel.py        ← ShopifyQL funnel (sessions, ATC, checkout, CVR, bounce)
│   │   ├── pinterest_csv.py         ← DEPRECATED 2026-02-28 — do not use
│   │   ├── pinterest_api.py         ← Pinterest API ingest (rolling 7d, 3 ad accounts)
│   │   └── sheets.py                ← Google Sheets → SQLite (product_tests, store_research)
│   ├── analytics/
│   │   ├── build.py                 ← Rebuilds campaign_performance_daily from raw facts
│   │   ├── decisions.py             ← Decision engine + Telegram alerts + follow-up tracker
│   │   └── integrity.py             ← Data integrity checks
│   ├── campaign_parser.py           ← Parse campaign names (store/batch/splitter)
│   ├── cli.py                       ← Full pipeline entry point (python -m pinterest.cli)
│   ├── config.py                    ← DB_PATH, DATA_DIR, LOG_PATH, KILL_FLOOR_BUDGET, ROAS_FALLBACK
│   ├── db.py                        ← DB connection helpers
│   └── utils.py                     ← URL normalization, EUR parsing
├── data/
│   ├── pinterest.db                 ← SQLite DB (source of truth)
│   ├── pipeline_runs.log            ← Pipeline execution log (JSON lines)
│   └── rate_limit.json              ← Pinterest API rate limit state
├── exports/                         ← Pinterest CSV exports drop zone
├── references/
│   ├── architecture.md              ← Data flow, DB schemas, decision logic
│   ├── runbook.md                   ← Operations: run pipeline, restart dashboard, debug
│   └── business-rules.md            ← Kill floor, thresholds, step-down philosophy
├── scripts/                         ← DEPRECATED legacy scripts (do not use)
└── tests/                           ← pytest test suite
```

## How to Run

```bash
cd ~/.openclaw/workspace/BUSINESSES/pinterest-store/code
source venv/bin/activate

# Full pipeline (cron runs at 8,12,16,20,23 CET):
python -m pinterest.cli

# Flask dashboard (live, port 8765):
python -m pinterest.dashboard.app

# Individual ingest steps:
python -m pinterest.ingest.shopify
python -m pinterest.ingest.shopify_products
python -m pinterest.ingest.shopify_funnel
python -m pinterest.ingest.pinterest_api

# Analytics only:
python -c "from pinterest.analytics.build import run; from pinterest.config import DB_PATH; run(DB_PATH)"
python -c "from pinterest.analytics.decisions import run; run()"
```

## Dashboard Access

| Method | URL |
|--------|-----|
| Local | `http://127.0.0.1:8765/` |
| Tailscale (remote) | `https://km-pro-2.tail6c9cd2.ts.net` |

## Flask API Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/` | GET | Full dashboard HTML. Params: `?from=YYYY-MM-DD&to=YYYY-MM-DD` or `?date=Nd` |
| `/api/data` | GET | Returns `data.run()` as JSON |
| `/api/refresh` | POST | Triggers fresh Pinterest API ingest |
| `/api/rate-limit` | GET | Returns current rate limit info |

## Pipeline Order (cli.py)

| Step | Module | What it does |
|------|--------|-------------|
| 0a | `ingest/shopify.py` | Shopify orders (last 90 days) |
| 0b | `ingest/shopify_products.py` | Product catalogue + live prices |
| 0c | `ingest/shopify_funnel.py` | ShopifyQL funnel metrics (last 3 days) |
| 1 | `ingest/pinterest_api.py` | Pinterest API → ad-level + campaign-level (rolling 7d) |
| 2 | `analytics/build.py` | Rebuild `campaign_performance_daily` |
| 3 | `analytics/decisions.py:run()` | Generate recommendations, log to `campaign_decisions` |
| 4a | `analytics/decisions.py:backfill_outcomes()` | Fill 1d/3d/7d ROAS outcomes for past decisions |
| 4b | `analytics/decisions.py:detect_ghost_decisions()` | Detect unlogged budget/status changes |
| 4c | `analytics/decisions.py:send_decision_alert()` | Daily Telegram action alert |
| 4d | `analytics/decisions.py:check_decision_followups()` | 1d/3d/7d outcome follow-up alerts |
| 5 | `dashboard/render.py` | Write static HTML backup |

## DB Tables

| Table | Source | Purpose |
|-------|--------|---------|
| `fact_ads_daily` | API + CSV | Ad-level daily spend/clicks/impressions |
| `campaign_daily` | API + CSV | Campaign-level daily data incl. budgets/status |
| `campaign_performance_daily` | analytics/build.py | Derived: spend + revenue + ROAS per campaign/day |
| `shopify_orders` | Shopify API | Orders with Pinterest UTM attribution |
| `shopify_line_items` | Shopify API | Per-product revenue |
| `shopify_products` | Shopify API | Product catalogue with EUR prices |
| `shopify_funnel_daily` | ShopifyQL | Sessions/ATC/checkout per product per day |
| `product_tests` | Google Sheets | COGS, target ROAS, launch dates |
| `store_research` | Google Sheets | Competitor store research |
| `campaign_decisions` | decisions.py | Decision logbook (engine + manual overrides) |
| `detected_decisions` | decisions.py | Ghost decisions — unlogged budget/status changes |

## Decision Engine (analytics/decisions.py)

### Actions
| Action | Trigger |
|--------|---------|
| `SCALE_UP` | 3d ROAS ≥ target AND 3d spend ≥ €15 |
| `SPLIT` | Spend hog >60% AND campaign ROAS ≥ target |
| `SCALE_DOWN` | 7d ROAS 50–75% of target AND budget > €10 floor |
| `KILL` | Budget ≤ €10 AND 7d ROAS < 75% target AND ≥7 days AND ≥€70 spend |
| `KEEP` | Not enough signal (default) |
| `WATCH` | Low spend < €30 |
| `LEARNING` | Campaign < 5 days old |
| `PAUSE` | Manual / ghost detected |
| `REVIVE` | Manual / ghost detected |

### Key Thresholds (config.py)
- `KILL_FLOOR_BUDGET = €10` — never kill above this
- `ROAS_FALLBACK = 3.0` — when no product_tests data
- `SPEND_HOG_PCT = 0.60` — spend hog threshold
- `MIN_CONF_SPEND = €30` — below = WATCH

### Key Functions
- `run(db_path)` → generates recs, logs to `campaign_decisions`, returns `(rec_text, cogs_text)`
- `backfill_outcomes(db_path)` → fills `outcome_1d/3d/7d_roas` in `campaign_decisions`
- `detect_ghost_decisions(db_path)` → fills `detected_decisions` with unlogged changes
- `send_decision_alert(decisions_data, db_path)` → Telegram daily action alert
- `check_decision_followups(db_path)` → Telegram 1d/3d/7d follow-up alerts

## Alert System

### Daily Decision Alert (`send_decision_alert`)
- Sent after each pipeline run
- Shows: actionable campaigns (KILL/SCALE_DOWN/SCALE_UP/SPLIT), WATCH, LEARNING counts

### Follow-up Alerts (`check_decision_followups`)
- 1d, 3d, 7d after a KILL or SCALE_UP decision
- Reports: outcome ROAS vs threshold, verdict (correct / wrong / mixed)

## Revenue Attribution

1. **Product URL match** (`product_revenue`) — ground truth, primary
2. **UTM campaign match** (`utm_revenue`) — secondary
3. **Pinterest pixel** (`roas_checkout`) — directional only, not used for decisions

## Ad Accounts
| ID | Name |
|----|------|
| `549768699527` | Maowowanglo |
| `549769338379` | Lieberteddy CT 2 |
| `549769316006` | Lieberteddy Creative Test account 1 |

## Dashboard Benchmarks (benchmarks.py)
| Metric | Target | Min/Max |
|--------|--------|---------|
| ATC rate | 8% | min 4% |
| Checkout rate | 4% | min 2% |
| CVR | 1.5% | min 0.5% |
| Bounce rate | 80% | max 92% |
| CTR | 0.5% | min 0.3% |
| CPM | €10 | max €18 |
| CPC | €0.60 | max €1.20 |
| Frequency | 1.5 | max 2.5 |

## Campaign Naming Convention
- Regular: `store_#N_DD-MM-YYYY`
- Splitter: `store_#NB_DD-MM-YYYY (no winner_product)`
- Pinterest IDs have `C` prefix; Shopify UTMs use raw number

## Legacy Scripts (DO NOT USE)
| File | Replaced by |
|------|-------------|
| `scripts/run_pipeline.py` | `python -m pinterest.cli` |
| `scripts/generate_dashboard.py` | `python -m pinterest.dashboard.app` |
| `scripts/fetch_email_reports.py` | `pinterest/ingest/pinterest_csv.py` |
| `scripts/backfill_pinterest_reports.py` | `pinterest/ingest/pinterest_api.py` |

## References
- `references/architecture.md` — Full data flow, DB schemas, decision logic details
- `references/runbook.md` — Operations: run pipeline, restart dashboard, debug errors
- `references/business-rules.md` — Kill floor, thresholds, step-down philosophy
- `scripts/schema.sql` — Full DB schema reference
