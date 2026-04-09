---
name: experiment-tracker
description: "Track, log, and manage business experiments across Pinterest, Revive Plus, and general business operations. Use when: starting a new experiment (ad test, landing page test, creative test, product research, pricing test, business process test), checking what experiments are currently running, updating experiment progress, concluding an experiment with a result, or reviewing learnings from past experiments. Triggers on: 'start an experiment', 'log this experiment', 'what experiments are running', 'conclude experiment', 'what did we learn from', 'test and iterate', 'run a test'."
---

# Experiment Tracker

Tracks all business experiments (ads, landing pages, creatives, product research, pricing, business ops) across Pinterest and Revive Plus. Every experiment follows the same discipline: clear hypothesis, one variable, clean measurement, defined thresholds, logged learning.

## Files
- `data/experiments.json` — all experiments
- `data/learnings.md` — concluded experiment learnings (auto-appended)
- `scripts/experiment.py` — CLI for all operations
- `references/schema.md` — full field schema and valid values

## Commands

```bash
SKILL_DIR=~/.openclaw/workspace/skills/experiment-tracker

# Step 0: Always diagnose before deciding what to test
python3 $SKILL_DIR/scripts/diagnose.py <product_handle> [--days 7] [--campaign-id <id>] [--ad-account <id>]
# Example:
python3 $SKILL_DIR/scripts/diagnose.py silkpores --days 7 --campaign-id 626757091046 --ad-account 549769316006

python3 $SKILL_DIR/scripts/experiment.py list
python3 $SKILL_DIR/scripts/experiment.py list --status=running
python3 $SKILL_DIR/scripts/experiment.py list --business=pinterest
python3 $SKILL_DIR/scripts/experiment.py get EXP-001
python3 $SKILL_DIR/scripts/experiment.py next-id
python3 $SKILL_DIR/scripts/experiment.py add '<json>'
python3 $SKILL_DIR/scripts/experiment.py update EXP-001 '<json_patch>'
python3 $SKILL_DIR/scripts/experiment.py conclude EXP-001 "winner" "Listicle outperformed PDP by 40% CVR"
```

## Workflow

### Step 0: Diagnose (always first)
Run `diagnose.py` before any experiment discussion. It pulls:
- Pinterest: spend, impressions, clicks, CTR, CPC, CPM, orders, ROAS
- Shopify: sessions, bounce rate, ATC rate, checkout rate, CVR, AOV
- Demographics: age breakdown, gender split, device split (account-level)
- Auto-diagnosis: identifies the weakest funnel point and highest-leverage test

The brief answers: *where is the funnel leaking, and what's the data-grounded reason to test X?*

Demographics are key for creative/copy decisions: knowing it's 70% female, 25-34, on Android mobile
shapes every word written and every image chosen.

### Starting an experiment
1. Ask: hypothesis, variable, primary metric, business goal, minimum thresholds, control vs test setup
2. Run `next-id` to get the ID
3. Run `add` with the full JSON (see references/schema.md)
4. Confirm to Maurizio: ID, what's being tested, when to check back

### Checking status
- Run `list --status=running` and format as a clean table
- Include: ID, business, variable, days running, next check date

### Concluding an experiment
1. Ask for result and key learning (1–2 sentences)
2. Run `conclude` — automatically appends to learnings.md
3. Update any relevant README or business file if the result changes strategy

### Reviewing learnings
- Read `data/learnings.md` directly
- Filter by business section as needed

## Test Setup by Type

| Type | Setup |
|------|-------|
| Landing page | Duplicate Shopify product (clean URL) + duplicate Pinterest campaign + new pin |
| New creative | Duplicate campaign + new pin, same destination URL |
| Product research | New Shopify listing + new test campaign |
| Pricing | Duplicate product with new price, split traffic via new campaign |
| Business/ops | Document control process vs new process, define measurable metric |

## Thresholds (defaults, override per experiment)
- Min 7 days running
- Min 100 sessions per variant
- Min €30 spend per variant (ads)
- Win threshold defined before starting — not after seeing results

## Framework
Pinterest's own data: brands using test-and-learn drove 2.2x higher action intention.
Cycle: Identify primary goals → Test → Evaluate against KPIs → Apply learnings → next test.
Primary goal is always business outcome (profit/ROAS/revenue), not just the metric.
