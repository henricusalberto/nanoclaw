# Experiment Schema

Each experiment object in `experiments.json`:

```json
{
  "id": "EXP-001",                         // auto-assigned
  "status": "running|concluded|paused",
  "business": "pinterest|revive|general",
  "type": "ad|landing_page|creative|product_research|pricing|business",
  "hypothesis": "We believe X will improve Y because Z",
  "variable": "Short description of what's being changed",
  "primary_metric": "CVR|ROAS|CPA|revenue|other",
  "primary_goal": "Underlying business goal this serves",
  "thresholds": {
    "min_days": 7,
    "min_sessions_per_variant": 100,
    "min_spend_per_variant": 30,
    "win_threshold": "CVR lift >20%"
  },
  "setup": {
    "control": "Description of control variant",
    "test": "Description of test variant",
    "notes": "Any setup specifics (duplicate product URL, campaign IDs, etc.)"
  },
  "start_date": "2026-03-22",
  "end_date": null,                         // set on conclude
  "result": null,                           // set on conclude: "winner|no_difference|inconclusive"
  "learning": null                          // set on conclude: 1-2 sentence takeaway
}
```

## Business values
- `pinterest` — Pinterest ads / dropshipping
- `revive` — Revive Plus / Nightcap brand
- `general` — cross-business or ops experiments

## Type values
- `landing_page` — PDP vs prelander vs listicle vs advertorial
- `creative` — new video/image ad creative
- `ad` — targeting, bidding, campaign structure
- `product_research` — new product viability
- `pricing` — price point / bundle testing
- `business` — process, tool, or operational experiment
