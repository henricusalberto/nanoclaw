#!/usr/bin/env python3
"""Generic config-driven Meta Ads launcher."""

import argparse
import json
import os
import time
from pathlib import Path

import requests

API = "https://graph.facebook.com/v25.0"
DELAY_SECONDS = 3

# PAC rules, proven structure, keep hardcoded
PAC_RULES = [
    {
        "customization_spec": {
            "publisher_platforms": ["facebook", "instagram", "messenger"],
            "facebook_positions": ["story", "facebook_reels"],
            "instagram_positions": ["story", "reels", "profile_reels", "ig_search"],
            "messenger_positions": ["story"],
        },
        "image_label": {"name": "label_story"},
        "title_label": {"name": "title_story"},
        "body_label": {"name": "body_story"},
    },
    {
        "customization_spec": {
            "publisher_platforms": ["facebook", "instagram", "audience_network"],
            "facebook_positions": [
                "feed",
                "marketplace",
                "right_hand_column",
                "video_feeds",
                "profile_feed",
                "search",
                "biz_disco_feed",
                "instream_video",
                "suggested_video",
                "instant_article",
                "notification",
                "facebook_reels_overlay",
            ],
            "instagram_positions": ["stream", "explore", "explore_home", "profile_feed", "shop"],
            "audience_network_positions": ["classic", "rewarded_video", "instream_video"],
        },
        "image_label": {"name": "label_feed"},
        "title_label": {"name": "title_feed"},
        "body_label": {"name": "body_feed"},
    },
]


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path, data):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def default_progress_path(config_path, config):
    progress_file = config.get("progress_file", "meta_progress.json")
    if os.path.isabs(progress_file):
        return progress_file
    return str(Path(config_path).parent / progress_file)


def load_progress(path):
    if os.path.exists(path):
        return load_json(path)
    return {
        "campaign_id": None,
        "adset_ids": {},
        "creative_ids": {},
        "done_ads": [],
    }


def validate_config(config):
    required = ["meta", "campaign", "adsets", "targeting", "copy", "versions", "creatives"]
    missing = [k for k in required if k not in config]
    if missing:
        raise ValueError(f"Missing top-level keys: {', '.join(missing)}")

    for key in ["token", "account_id", "page_id", "ig_user_id", "pixel_id"]:
        if not config["meta"].get(key):
            raise ValueError(f"meta.{key} is required")

    texts = config["copy"].get("texts", [])
    if not texts:
        raise ValueError("copy.texts must contain at least 1 text")


def check_rate_limit(headers, account_id):
    r = requests.get(f"{API}/{account_id}?fields=name", headers=headers)
    usage_raw = r.headers.get("x-business-use-case-usage", "{}")
    try:
        parsed = json.loads(usage_raw)
        for _, items in parsed.items():
            for item in items:
                eta = item.get("estimated_time_to_regain_access", 0)
                total = item.get("total_time", 0)
                calls = item.get("call_count", 0)
                print(f"  📊 calls={calls}% time={total}% eta={eta}min", flush=True)
                if eta and eta > 0:
                    wait = (eta + 2) * 60
                    print(f"  ⏳ Rate limited, waiting {eta + 2} minutes...", flush=True)
                    time.sleep(wait)
    except Exception:
        pass


def api_post(headers, endpoint, payload, retries=3):
    for _ in range(retries):
        r = requests.post(f"{API}/{endpoint}", headers=headers, json=payload)
        data = r.json()
        if "error" in data:
            msg = str(data["error"].get("message", ""))
            if "too many calls" in msg.lower():
                print("  ⏳ Rate limit hit, waiting 5 minutes...", flush=True)
                time.sleep(300)
                continue
            return None, data["error"]
        return data.get("id"), None
    return None, "Max retries exceeded"


def create_creative(headers, config, ad_name, portrait_hash, square_hash, account_id):
    copy_cfg = config["copy"]
    texts = copy_cfg["texts"]
    headline = copy_cfg["headline"]
    url = copy_cfg["url"]
    page_id = config["meta"]["page_id"]
    ig_user_id = config["meta"]["ig_user_id"]

    use_pac = bool(portrait_hash and square_hash and portrait_hash != square_hash)

    if use_pac:
        bodies = []
        for text in texts:
            bodies.append({
                "text": text,
                "adlabels": [{"name": "body_story"}, {"name": "body_feed"}],
            })

        payload = {
            "name": f"{ad_name} Creative",
            "object_story_spec": {"page_id": page_id, "instagram_user_id": ig_user_id},
            "contextual_multi_ads": {"enroll_status": "OPT_OUT"},
            "asset_feed_spec": {
                "optimization_type": "REGULAR",
                "ad_formats": ["SINGLE_IMAGE"],
                "images": [
                    {"hash": portrait_hash, "adlabels": [{"name": "label_story"}]},
                    {"hash": square_hash, "adlabels": [{"name": "label_feed"}]},
                ],
                "bodies": bodies,
                "titles": [
                    {
                        "text": headline,
                        "adlabels": [{"name": "title_story"}, {"name": "title_feed"}],
                    }
                ],
                "descriptions": [{"text": " "}],
                "link_urls": [{"website_url": url}],
                "call_to_action_types": ["SHOP_NOW"],
                "asset_customization_rules": PAC_RULES,
            },
        }
        cid, err = api_post(headers, f"{account_id}/adcreatives", payload)
        if cid:
            return cid, None, "PAC"
        print(f"    ⚠️ PAC failed ({err}), falling back to portrait-only", flush=True)

    # Portrait-only: single body text, clean link_data format
    payload = {
        "name": f"{ad_name} Creative",
        "object_story_spec": {
            "page_id": page_id,
            "instagram_user_id": ig_user_id,
            "link_data": {
                "link": url,
                "image_hash": portrait_hash,
                "message": texts[0],
                "name": headline,
                "description": " ",
                "call_to_action": {"type": "SHOP_NOW"},
            },
        },
        "contextual_multi_ads": {"enroll_status": "OPT_OUT"},
    }
    cid, err = api_post(headers, f"{account_id}/adcreatives", payload)
    return cid, err, "portrait-only"


def main():
    parser = argparse.ArgumentParser(description="Launch Meta campaign from config JSON")
    parser.add_argument("config", help="Path to config JSON, e.g. config.json")
    args = parser.parse_args()

    config = load_json(args.config)
    validate_config(config)

    progress_path = default_progress_path(args.config, config)
    progress = load_progress(progress_path)
    done_ads = set(progress.get("done_ads", []))

    meta = config["meta"]
    campaign_cfg = config["campaign"]
    account_id = meta["account_id"]
    headers = {"Authorization": f"Bearer {meta['token']}"}

    print(f"🚀 Launching campaign from {args.config}", flush=True)
    check_rate_limit(headers, account_id)

    if not progress.get("campaign_id"):
        print("\n📣 Creating campaign...", flush=True)
        cid, err = api_post(
            headers,
            f"{account_id}/campaigns",
            {
                "name": campaign_cfg["name"],
                "objective": campaign_cfg.get("objective", "OUTCOME_SALES"),
                "status": "PAUSED",
                "special_ad_categories": [],
                "is_adset_budget_sharing_enabled": False,
            },
        )
        if not cid:
            print(f"  ❌ Campaign failed: {err}", flush=True)
            return
        progress["campaign_id"] = cid
        write_json(progress_path, progress)
        print(f"  ✅ Campaign: {cid}", flush=True)
        time.sleep(DELAY_SECONDS)
    else:
        print(f"\n✓ Campaign exists: {progress['campaign_id']}", flush=True)

    campaign_id = progress["campaign_id"]

    print("\n📦 Creating ad sets...", flush=True)
    for adset in config["adsets"]:
        code = adset["code"]
        if code in progress.get("adset_ids", {}):
            print(f"  ✓ {code}: {progress['adset_ids'][code]}", flush=True)
            continue

        asid, err = api_post(
            headers,
            f"{account_id}/adsets",
            {
                "name": f"{code} — {adset['name']}",
                "campaign_id": campaign_id,
                "daily_budget": adset["daily_budget_cents"],
                "billing_event": "IMPRESSIONS",
                "optimization_goal": "OFFSITE_CONVERSIONS",
                "bid_strategy": "LOWEST_COST_WITHOUT_CAP",
                "promoted_object": {
                    "pixel_id": meta["pixel_id"],
                    "custom_event_type": "PURCHASE",
                },
                "start_time": campaign_cfg["start_time"],
                "status": "PAUSED",
                "targeting": {
                    "age_min": config["targeting"].get("age_min", 18),
                    "geo_locations": {
                        "countries": config["targeting"].get("countries", ["US"]),
                        "location_types": config["targeting"].get("location_types", ["home", "recent"]),
                    },
                },
            },
        )
        if not asid:
            print(f"  ❌ {code} failed: {err}", flush=True)
            return

        progress.setdefault("adset_ids", {})[code] = asid
        write_json(progress_path, progress)
        print(f"  ✅ {code}: {asid}", flush=True)
        time.sleep(DELAY_SECONDS)

    print("\n🎨 Creating creatives + ads...", flush=True)
    created = 0
    skipped = 0
    failed = 0
    processed_ads = 0

    for creative in config["creatives"]:
        adset_code = creative["adset_code"]
        identity = creative["identity"]
        creative_id = creative["id"]
        adset_id = progress["adset_ids"].get(adset_code)

        if not adset_id:
            print(f"  ❌ Missing adset for code {adset_code}", flush=True)
            failed += len(config["versions"])
            continue

        for version in config["versions"]:
            version_images = creative["images"].get(version, {})
            portrait_hash = version_images.get("portrait")
            square_hash = version_images.get("square")

            ad_name = f"{creative_id} - {version} - {adset_code} - {identity}"
            if ad_name in done_ads:
                skipped += 1
                processed_ads += 1
                if processed_ads % 10 == 0:
                    check_rate_limit(headers, account_id)
                continue

            if not portrait_hash:
                print(f"  ❌ {ad_name}: missing portrait hash", flush=True)
                failed += 1
                processed_ads += 1
                continue

            print(f"  → {ad_name}", flush=True)

            creative_cache = progress.setdefault("creative_ids", {})
            creative_key = ad_name
            creative_api_id = creative_cache.get(creative_key)
            mode = "cached"

            if not creative_api_id:
                creative_api_id, err, mode = create_creative(
                    headers, config, ad_name, portrait_hash, square_hash, account_id
                )
                time.sleep(DELAY_SECONDS)
                if not creative_api_id:
                    print(f"    ❌ Creative failed: {err}", flush=True)
                    failed += 1
                    processed_ads += 1
                    if processed_ads % 10 == 0:
                        check_rate_limit(headers, account_id)
                    continue

                creative_cache[creative_key] = creative_api_id
                write_json(progress_path, progress)

            ad_id, err = api_post(
                headers,
                f"{account_id}/ads",
                {
                    "name": ad_name,
                    "adset_id": adset_id,
                    "creative": {"creative_id": creative_api_id},
                    "status": "PAUSED",
                },
            )
            time.sleep(DELAY_SECONDS)

            if ad_id:
                print(f"    ✅ [{mode}] {ad_id}", flush=True)
                done_ads.add(ad_name)
                progress["done_ads"] = sorted(done_ads)
                write_json(progress_path, progress)
                created += 1
            else:
                print(f"    ❌ Ad failed: {err}", flush=True)
                failed += 1

            processed_ads += 1
            if processed_ads % 10 == 0:
                check_rate_limit(headers, account_id)

    print("\n" + "=" * 56, flush=True)
    print(f"✅ Created:  {created}", flush=True)
    print(f"⏭️  Skipped: {skipped}", flush=True)
    print(f"❌ Failed:  {failed}", flush=True)
    print(f"Campaign:   {campaign_id}", flush=True)
    print(f"Progress:   {progress_path}", flush=True)
    print("=" * 56, flush=True)


if __name__ == "__main__":
    main()
