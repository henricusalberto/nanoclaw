#!/usr/bin/env python3
"""
Nightcap — Meta Ads Launch v4
- Fresh campaign + 7 ad sets (Advantage+ placements — no placement restrictions)
- 66 PAC ads: portrait for Stories/Reels, square for Feed
- Both primary texts (TEXT1 + TEXT2) via labeled asset_feed_spec
- Empty description (space override)
- Multi-advertiser ads OFF (contextual_multi_ads OPT_OUT)
- Start time: March 2, 2026 04:00 PST
- Full checkpointing — safe to re-run
"""

import requests, json, os, time

TOKEN    = "EAAW6o7oCqB8BQzWiBlUI96tBpgxXLKEgr8pjKoSZAp4zOvo6Mo8a0WeWboWPxy15roXopQrnCdMptCLlAfhewJZAqY8ah524MDvwKkykmHv2AZCoJghMdZBDYOY8DyXklht8qZAbNEjb8wJsNraYLlfNRb4ojO25pc2ZCMwno73z6Kz2Baecmt1WWysWbOVloaVDuJBnQFo4lXTd8wM2GQ14RBNrFMaGG6gCxCf3aVCFD9Exej00ZAJXMgBrZBpqYWUfUZCcDXqNpUUIqIGDmVhhFQV26fobHqA4dXxPWtgZDZD"
ACCOUNT  = "act_1400123811678069"
PAGE_ID  = "902125422992374"
IG_ID    = "17841479960010364"
PIXEL_ID = "1865987104055028"
URL      = "https://revivepluslabs.com/"
API      = "https://graph.facebook.com/v25.0"
HEADERS  = {"Authorization": f"Bearer {TOKEN}"}
PROGRESS = "/Users/kimbehnke/.openclaw/workspace/BUSINESSES/reviveplus/meta_v4_progress.json"
DELAY    = 3

# March 3, 2026 04:00 PST = 12:00 UTC
START_TIME = 1741003200

TEXT1 = (
    '"I used to plan my entire week around my social calendar. Friday night out meant Saturday recovery, '
    'which meant Sunday was slow too. Three days derailed by one night. Last weekend I went to a wedding, '
    'enjoyed myself fully, stayed out late, took Nightcap before bed, and woke up at 7am for my normal gym '
    'session. No drag, no fog, no slow start. Just got my weekend back."\n\n'
    "People are rating this a 10/10 for one simple reason: you don't have to compromise your social life. "
    "You don't have to miss out on the fun. You just mix this with water before bed. While you sleep, it "
    "supports your body's natural metabolic recovery, clears the next-day fog, and replenishes essential "
    "hydration levels fast.\n\n"
    "GET YOUR FIRST PACK FREE!\n"
    "✅ Wake up feeling like you stayed in (Or your money back)\n"
    "✅ Clear head, sharp focus, ready to execute\n"
    "✅ Hit your morning workout as planned\n"
    "✅ Never waste a weekend day again\n\n"
    "Tastes like citrus. Works whenever you take it.\n"
    "Same nights out, zero wasted mornings.\n\n"
    "⚡ Try it risk-free while it's on sale"
)
TEXT2 = (
    "GET YOUR FIRST PACK FREE!\n"
    "✅ Wake up feeling like you stayed in (Or your money back)\n"
    "✅ Clear head, sharp focus, ready to execute\n"
    "✅ Hit your morning workout as planned\n"
    "✅ Never waste a weekend day again\n\n"
    "Tastes like citrus. Works whenever you take it.\n"
    "Same nights out, zero wasted mornings.\n\n"
    "⚡ Try it risk-free while it's on sale"
)
HEADLINE = "Get Your First Pack of Nightcap FREE — While It's Still On Sale!✨"

ADSET_CONFIGS = [
    ("SP",  "Social Parent"),
    ("FIT", "Fitness"),
    ("GN",  "Girls Night"),
    ("BN",  "Boys Night"),
    ("PRO", "Professionals"),
    ("HH",  "Lifestyle"),
    ("BR",  "Broad"),
]

# (creative_id, adset_code, identity, mau_portrait, mau_square, jan_portrait, jan_square)
CREATIVES = [
    ("1_polished",  "SP",  "Social Parent",  "67fdd017dc67f5ce38f19f993b440b00", "c853ff125697103a73299db439df73ae", "e032eaae701448b3aa7cb8d6ae96a72d", "e032eaae701448b3aa7cb8d6ae96a72d"),
    ("2_polished",  "SP",  "Social Parent",  "8ba92369fca6f00c3566649c9eee2d3c", "38bc59904be03e9f02da61f222f73915", "97e497563fb57a1289388fc7d2c3d8a8", "97e497563fb57a1289388fc7d2c3d8a8"),
    ("1_no_gem",    "SP",  "Social Parent",  "c11ba69754a0924b6c82447c0054c957", "47881ae322f1830300e459da71b8e55d", "6886658f6421549e07cb9dfeb62280f1", "6886658f6421549e07cb9dfeb62280f1"),
    ("2_no_gem",    "SP",  "Social Parent",  "ab582c47bca9312b2c5f5cad368dee78", "7d8df8c0491369178625422715b0f37a", "1950e5d6347a2087cc6970021a69f64f", "1950e5d6347a2087cc6970021a69f64f"),
    ("3_no_gem",    "FIT", "Fitness",        "b8a2df056c41d5710bfba1446af50df4", "3e15976a599fa88c3f34dfefa92400e9", "bc1fc080bfac4ef8cef92ced452d1060", "bc1fc080bfac4ef8cef92ced452d1060"),
    ("4_no_gem",    "FIT", "Fitness",        "569a148dc5d937dfd9d8db38a1cda04e", "0a5dffbe434144cac159abd4884fe07e", "dcec5524ff175990de69319e62eccac2", "dcec5524ff175990de69319e62eccac2"),
    ("workout_v1",  "FIT", "Fitness",        "cf4cdc503d548df45cc2bee58b081883", "16172b3266848b335114b9ba0ebb5bd8", "ccade6de9d1d98e508da9a3aebaab6e1", "ccade6de9d1d98e508da9a3aebaab6e1"),
    ("workout_v2",  "FIT", "Fitness",        "3b7c96b6f096f11445c95cb2bd65a1e9", "07c7ea263d380a838021290d0a22c1ee", "205029b9b41a70f00e4a8f20bdfdd3d8", "205029b9b41a70f00e4a8f20bdfdd3d8"),
    ("15_polished", "FIT", "Routine",        "a1723396d572cb500c9361ee3fb41e81", "705a9868509b056b5def13080a627dfa", "5dcb71a4829f34f17b247f60e35df3ab", "5dcb71a4829f34f17b247f60e35df3ab"),
    ("5_polished",  "GN",  "Girls Night",    "df2434b954c2fb7e0c49dc77221c287b", "217efdadf9350332e45f97c9f9604535", "171370166fbdb7ca8d6755f3a7b032c4", "171370166fbdb7ca8d6755f3a7b032c4"),
    ("5_no_gem",    "GN",  "Girls Night",    "fbabc978cc914f59051c548954ddd678", "82910a477ccc992d12f9cbb2f3b23b40", "44c1b1cf6821951f912d058af66ed2e2", "44c1b1cf6821951f912d058af66ed2e2"),
    ("8_polished",  "GN",  "Girls Night",    "5be5951ece312334a562174105f6ca06", "a288877c4d0b8b9be8c05987661b8fbc", "16f38c50c52bd71ba2b762e487244b4c", "16f38c50c52bd71ba2b762e487244b4c"),
    ("8_no_gem",    "GN",  "Girls Night",    "a9070fb4e80d756eb9ea007435a7b6e4", "83795bb2eb26345a96755fa0235b70ad", "61bb68dca4731ede2757b5817b1b178e", "61bb68dca4731ede2757b5817b1b178e"),
    ("13_polished", "GN",  "Girls Night",    "619a20acce29a06dc22edd58e2eb1471", "a41880fdfb4b11262e00ec506b3ac938", "b6a7f710b36d017506f25ef2d08f0127", "b6a7f710b36d017506f25ef2d08f0127"),
    ("7_polished",  "BN",  "Boys Night",     "b6a19e6c3c5c3433ee7351b9418a76dd", "12c22b7f8255a84870609f736aae73db", "f1eb00638d1c46abcdc429870a9a69b3", "f1eb00638d1c46abcdc429870a9a69b3"),
    ("9_polished",  "BN",  "Boys Night",     "13e19ebd8b27b9dc6bbca1394d5b280d", "f6f4ce02d5b8a3b5b8256b3fc897f772", "10f8506ad2813a923c9a6a01e7aa1d2b", "10f8506ad2813a923c9a6a01e7aa1d2b"),
    ("9_no_gem",    "BN",  "Boys Night",     "40def986f18d83ede2e4295a2b46f214", "c2e67a826ba2a6ca2a70f9c5e132e62a", "dfae6a76e4ccda4c591c22b1d9343fc0", "dfae6a76e4ccda4c591c22b1d9343fc0"),
    ("15_no_gem",   "BN",  "Boys Night",     "f1bb1e2e37712693dc2907e26d6df848", "6d3c316935198b07bc4c6f68c09a90e0", "baae9ac9b822d4a99c01d00c21fb4120", "baae9ac9b822d4a99c01d00c21fb4120"),
    ("6_no_gem",    "PRO", "Professionals",  "f0ac65fc8e6d776a616a771c3222c4ab", "938cddee9287fc3501864020e6c51f4b", "44daf0d41187aaf6f8970a3c72511071", "44daf0d41187aaf6f8970a3c72511071"),
    ("10_polished", "PRO", "Professionals",  "d8cb654fb9def286ff1cf565cb1529c3", "832d3fff133d8273a29bf692444d799e", "f350c639b2371ec190b0d3d6ecdb5593", "f350c639b2371ec190b0d3d6ecdb5593"),
    ("10_no_gem",   "PRO", "Professionals",  "f6f33c44ed2f9dfc398c94b26fecc181", "2c628d2c7c3d854928ff168b3ec84bad", "08dbacd9bfa8c777a8f043855d60848f", "08dbacd9bfa8c777a8f043855d60848f"),
    ("14_no_gem",   "PRO", "Professionals",  "77d539175ec61808e6bde9097b914fe4", "233781efc62d2dc41836d70cb155b6ac", "958d0609593b5018ea364434b022c88e", "958d0609593b5018ea364434b022c88e"),
    ("16_no_gem",   "PRO", "Professionals",  "0b9948a1f54c851f83dee415c3615f39", "21ee22e55d654e13f80877239114ff39", "ac56844c6a8dc94d1e14a602bceee3e3", "ac56844c6a8dc94d1e14a602bceee3e3"),
    ("11_polished", "HH",  "Lifestyle",      "c2acd410813eb3248c172170fbc8a1d9", "f40307b0e370f39f6dcb229fd78e3458", "2283c4f2eef5085f2dd638ed5573d6d7", "2283c4f2eef5085f2dd638ed5573d6d7"),
    ("11_no_gem",   "HH",  "Lifestyle",      "a98ba2688c3241ab7b227c07633b82ee", "121a66c93881a1e7e4a5a8ea0777a44e", "d83ec76754863639f84fd07ace2f05ef", "121a66c93881a1e7e4a5a8ea0777a44e"),
    ("17_polished", "HH",  "Lifestyle",      "5895e2bc86c4d5709fd23e756cfe3ced", "41b0ebc51bded5dd9ddf77d131c29aab", "882118bd3cae98b63b10a4b28b9a7df2", "882118bd3cae98b63b10a4b28b9a7df2"),
    ("18_polished", "HH",  "Lifestyle",      "cc8a6b81d92cb56f6f385ce721513c07", "193d1b0bd4b0b29aa619131694cb16f5", "8bc8244262b132307e53b88994c87700", "8bc8244262b132307e53b88994c87700"),
    ("19_polished", "HH",  "Lifestyle",      "2356d7d8f6ff15e4017cc005dc88cd63", "454423aa0fb77f6da209d9d4c1d35876", "f0ac0b302872fbd99af5a29711a2a304", "f0ac0b302872fbd99af5a29711a2a304"),
    ("6_polished",  "BR",  "Broad",          "d5285d88d3261183d13c7f7ef6a81785", "84ef3a81c67d7fcf15b09608a6c3495c", "68c91895b4164037d0b62460f5bd382b", "68c91895b4164037d0b62460f5bd382b"),
    ("12_polished", "BR",  "Broad",          "df8c3ada0df6140ff944affa096a8334", "d20b7f5a7100d4f895e308c104a9a802", "c6f99eca5e7a518c2a218ac9bec066ec", "c6f99eca5e7a518c2a218ac9bec066ec"),
    ("13_no_gem",   "BR",  "Broad",          "df4b77f4b9e24d40f3e7380c559c8833", "638e436a0fcf3d60f8430d396828e498", "b7498418a303ea5d8fc2e1ba1f01b0f1", "b7498418a303ea5d8fc2e1ba1f01b0f1"),
    ("14_polished", "BR",  "Broad",          "3c374f3e401ca1e37280116d623b47b8", "6657afeebf4d9ae4d527401af34bf240", "c288728626f486fb3948597056e0fc69", "c288728626f486fb3948597056e0fc69"),
    ("16_polished", "BR",  "Broad",          "1f60f6355cf355855c422e321718471f", "9779a177e4618c654bcbb85be9922f14", "b41d3fbffcc868800bc7b16ff07f8220", None),
]

# PAC placement rules — v12 proven structure
PAC_RULES = [
    {
        # Portrait: full-screen vertical placements
        "customization_spec": {
            "publisher_platforms": ["facebook", "instagram", "messenger"],
            "facebook_positions":  ["story", "facebook_reels"],
            "instagram_positions": ["story", "reels", "profile_reels", "ig_search"],
            "messenger_positions": ["story"]
        },
        "image_label": {"name": "label_story"},
        "title_label": {"name": "title_story"},
        "body_label":  {"name": "body_story"}
    },
    {
        # Square: feed + overlay placements
        "customization_spec": {
            "publisher_platforms":        ["facebook", "instagram", "audience_network"],
            "facebook_positions":         ["feed", "marketplace", "right_hand_column", "video_feeds",
                                           "profile_feed", "search", "biz_disco_feed", "instream_video",
                                           "suggested_video", "instant_article", "notification",
                                           "facebook_reels_overlay"],
            "instagram_positions":        ["stream", "explore", "explore_home", "profile_feed", "shop"],
            "audience_network_positions": ["classic", "rewarded_video", "instream_video"]
        },
        "image_label": {"name": "label_feed"},
        "title_label": {"name": "title_feed"},
        "body_label":  {"name": "body_feed"}
    }
]

# ─── HELPERS ─────────────────────────────────────────────────────────────────

def load_progress():
    if os.path.exists(PROGRESS):
        with open(PROGRESS) as f:
            return json.load(f)
    return {"campaign_id": None, "adset_ids": {}, "done_ads": []}

def save_progress(p):
    with open(PROGRESS, "w") as f:
        json.dump(p, f, indent=2)

def check_rate_limit():
    r = requests.get(f"{API}/{ACCOUNT}?fields=name", headers=HEADERS)
    usage_raw = r.headers.get("x-business-use-case-usage", "{}")
    try:
        data = json.loads(usage_raw)
        for _, items in data.items():
            for item in items:
                eta = item.get("estimated_time_to_regain_access", 0)
                tt  = item.get("total_time", 0)
                cc  = item.get("call_count", 0)
                print(f"  📊 calls={cc}% time={tt}% eta={eta}min")
                if eta > 0:
                    wait = (eta + 2) * 60
                    print(f"  ⏳ Rate limited. Waiting {eta+2} minutes...")
                    time.sleep(wait)
    except:
        pass

def api_post(endpoint, payload, retries=3):
    for attempt in range(retries):
        r = requests.post(f"{API}/{endpoint}", headers=HEADERS, json=payload)
        data = r.json()
        if "error" in data:
            msg = data["error"]["message"]
            if "too many calls" in msg.lower():
                print(f"  ⏳ Rate limit hit, waiting 5 minutes...")
                time.sleep(300)
                continue
            return None, data["error"]
        return data.get("id"), None
    return None, "Max retries exceeded"

def create_pac_creative(name, portrait_h, square_h):
    """
    PAC creative v12 structure:
    - Both TEXT1 + TEXT2 via labeled bodies (Meta A/B tests them)
    - Portrait image for Stories/Reels
    - Square image for Feed/Marketplace/etc
    - Empty description (space override suppresses OG tag)
    - Multi-advertiser ads OFF
    Falls back to portrait-only if portrait_h == square_h or square_h is None.
    """
    use_pac = portrait_h and square_h and portrait_h != square_h

    if use_pac:
        payload = {
            "name": name,
            "object_story_spec": {"page_id": PAGE_ID, "instagram_user_id": IG_ID},
            "contextual_multi_ads": {"enroll_status": "OPT_OUT"},
            "asset_feed_spec": {
                "optimization_type": "REGULAR",
                "ad_formats": ["SINGLE_IMAGE"],
                "images": [
                    {"hash": portrait_h, "adlabels": [{"name": "label_story"}]},
                    {"hash": square_h,   "adlabels": [{"name": "label_feed"}]}
                ],
                "bodies": [
                    {"text": TEXT1, "adlabels": [{"name": "body_story"}, {"name": "body_feed"}]},
                    {"text": TEXT2, "adlabels": [{"name": "body_story"}, {"name": "body_feed"}]}
                ],
                "titles":       [{"text": HEADLINE, "adlabels": [{"name": "title_story"}, {"name": "title_feed"}]}],
                "descriptions": [{"text": " "}],
                "link_urls":    [{"website_url": URL}],
                "call_to_action_types": ["SHOP_NOW"],
                "asset_customization_rules": PAC_RULES
            }
        }
        cid, err = api_post(f"{ACCOUNT}/adcreatives", payload)
        if cid:
            return cid, None, "PAC"
        # Fall through to portrait-only on failure
        print(f"    ⚠️  PAC failed ({err}), falling back to portrait-only")

    # Portrait-only fallback
    payload = {
        "name": name,
        "object_story_spec": {
            "page_id": PAGE_ID,
            "instagram_user_id": IG_ID,
            "link_data": {
                "link": URL,
                "image_hash": portrait_h,
                "message": TEXT1,
                "name": HEADLINE,
                "description": " ",
                "call_to_action": {"type": "SHOP_NOW"}
            }
        },
        "contextual_multi_ads": {"enroll_status": "OPT_OUT"}
    }
    cid, err = api_post(f"{ACCOUNT}/adcreatives", payload)
    return cid, err, "portrait-only"

# ─── MAIN ─────────────────────────────────────────────────────────────────────

def main():
    progress = load_progress()
    done_ads = set(progress.get("done_ads", []))

    print("\n🚀 Nightcap Launch v4 — PAC v12 (portrait Stories + square Feed, both texts)")
    check_rate_limit()

    # ── Step 1: Campaign ──────────────────────────────────────────────────────
    if not progress.get("campaign_id"):
        print("\n📣 Creating campaign...")
        cid, err = api_post(f"{ACCOUNT}/campaigns", {
            "name": "Nightcap — Launch v4 Mar 3 2026",
            "objective": "OUTCOME_SALES",
            "status": "PAUSED",
            "special_ad_categories": [],
            "is_adset_budget_sharing_enabled": False
        })
        if not cid:
            print(f"  ❌ Campaign failed: {err}")
            return
        progress["campaign_id"] = cid
        save_progress(progress)
        print(f"  ✅ Campaign: {cid}")
        time.sleep(DELAY)
    else:
        print(f"\n✓ Campaign: {progress['campaign_id']}")

    CAMPAIGN_ID = progress["campaign_id"]

    # ── Step 2: Ad Sets ───────────────────────────────────────────────────────
    print("\n📦 Creating ad sets...")
    for code, name in ADSET_CONFIGS:
        if code in progress.get("adset_ids", {}):
            print(f"  ✓ {code}: {progress['adset_ids'][code]}")
            continue

        asid, err = api_post(f"{ACCOUNT}/adsets", {
            "name": f"{code} — {name}",
            "campaign_id": CAMPAIGN_ID,
            "daily_budget": 2500,
            "billing_event": "IMPRESSIONS",
            "optimization_goal": "OFFSITE_CONVERSIONS",
            "bid_strategy": "LOWEST_COST_WITHOUT_CAP",
            "promoted_object": {"pixel_id": PIXEL_ID, "custom_event_type": "PURCHASE"},
            "start_time": START_TIME,
            "status": "PAUSED",
            "targeting": {
                "age_min": 18,
                "geo_locations": {"countries": ["US"], "location_types": ["home", "recent"]}
            }
        })
        if not asid:
            print(f"  ❌ {code} failed: {err}")
            return
        progress["adset_ids"][code] = asid
        save_progress(progress)
        print(f"  ✅ {code}: {asid}")
        time.sleep(DELAY)

    # ── Step 3: Ads ───────────────────────────────────────────────────────────
    print("\n🎨 Creating ads...")
    created = skipped = failed = 0

    for creative_id, adset_code, identity, mau_p, mau_sq, jan_p, jan_sq in CREATIVES:
        adset_id = progress["adset_ids"].get(adset_code)

        for version, portrait_h, square_h in [("Mau", mau_p, mau_sq), ("Janus", jan_p, jan_sq)]:
            ad_name = f"{creative_id} - {version} - {adset_code} - {identity}"

            if ad_name in done_ads:
                skipped += 1
                continue

            print(f"  → {ad_name}")

            cid, err, mode = create_pac_creative(ad_name + " Creative", portrait_h, square_h)
            time.sleep(DELAY)

            if not cid:
                print(f"    ❌ Creative failed: {err}")
                failed += 1
                continue

            ad_id, err2 = api_post(f"{ACCOUNT}/ads", {
                "name": ad_name,
                "adset_id": adset_id,
                "creative": {"creative_id": cid},
                "status": "PAUSED"
            })
            time.sleep(DELAY)

            if ad_id:
                print(f"    ✅ [{mode}] {ad_id}")
                done_ads.add(ad_name)
                progress["done_ads"] = list(done_ads)
                save_progress(progress)
                created += 1
            else:
                print(f"    ❌ Ad failed: {err2}")
                failed += 1

        # Rate limit checkpoint every 10 creatives
        if (created + skipped) % 10 == 0 and (created + skipped) > 0:
            check_rate_limit()

    print(f"\n{'='*52}")
    print(f"✅ Created:  {created}")
    print(f"⏭️  Skipped: {skipped}")
    print(f"❌ Failed:  {failed}")
    print(f"Campaign:   {CAMPAIGN_ID}")
    print(f"Launch:     Mar 3 2026 04:00 PST")
    print(f"{'='*52}")

if __name__ == "__main__":
    main()
