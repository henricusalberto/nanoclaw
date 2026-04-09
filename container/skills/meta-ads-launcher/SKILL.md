---
name: meta-ads-launcher
description: "Create and launch Meta (Facebook/Instagram) ad campaigns via the Ads API. Use when: setting up a new Meta ad campaign from scratch, creating ABO ad sets with Advantage+ placements, bulk-creating PAC creatives (portrait for Stories/Reels, square for Feed), rebuilding or fixing existing ads, deleting duplicate or outdated ads. Handles full pipeline: campaign to ad sets to creatives to ads, with checkpointing, rate limit handling, and PAC image routing."
---

# Meta Ads Launcher

Config-driven launcher for Meta Ads API campaigns: campaign → ad sets → creatives → ads.

## Files
- `scripts/setup_config.py` — interactive config builder
- `scripts/meta_launcher.py` — generic launcher that consumes a config JSON
- `configs/` — saved launch configs (example included: `nightcap-mar3-2026.json`)
- `references/api-notes.md` — API gotchas and payload notes

## Workflow

### 1) Build a config
Run:
```bash
python3 scripts/setup_config.py
```

The setup asks all required launch inputs in order, including campaign metadata, IDs, targeting, versions, copy, and image hashes. It converts natural-language launch time to Unix UTC timestamp and writes JSON after a final confirmation prompt.

### 2) Launch from config
Run with unbuffered output:
```bash
python3 -u scripts/meta_launcher.py configs/<your-config>.json
```

Behavior:
- Creates campaign, ad sets, creatives, and ads
- Full checkpointing in `progress_file` (safe to rerun)
- Reuses saved creative IDs when rerunning
- Checks business usage rate limits every 10 ads
- Falls back to portrait-only creative when PAC is not applicable or fails

### 3) Save reusable launch configs
Store config files in:
- `configs/`

Use campaign-specific names, for example:
- `configs/nightcap-mar3-2026.json`

## PAC rules
PAC placement rules are hardcoded in `scripts/meta_launcher.py` and should stay fixed unless Meta API behavior changes. The launcher applies:
- Portrait rule: Facebook + Instagram + Messenger story/reels placements
- Square rule: Facebook + Instagram + Audience Network feed-style placements

## Common Errors & Fixes

| Error | Fix |
|-------|-----|
| `error_subcode: 1885878` Multiple bodies cannot be applied to rule | Add adlabels to bodies + reference in rules |
| `error_subcode: 2490266` Missing default rule in language asset feed | Triggered by `descriptions` with adlabels or `captions` — remove those fields |
| `error_subcode: 1885923` Missing default asset customisation rule | Adding `threads` platform or `threads_user_id` requires default rule — skip Threads |
| `error_subcode: 2446501` All non-default target rules must contain geolocation | Don't mix default rule + geo-based rules |
| `instagram_actor_id` errors | Use `instagram_user_id` in `object_story_spec` instead |
| Token expired | User token expires ~2h — refresh at Meta Graph API Explorer |
| `is_adset_budget_sharing_enabled` error | Set to `False` on campaign for ABO |
