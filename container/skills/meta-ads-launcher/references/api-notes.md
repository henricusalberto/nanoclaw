# Meta Ads API — Proven Patterns & Gotchas

## Authentication
- User tokens expire every ~2 hours. System user tokens last longer but may lack some permissions.
- Required permissions: `ads_management`, `pages_read_engagement`
- For Threads ads: also needs `threads_business_basic`

## Campaign Creation
- Always include `is_adset_budget_sharing_enabled: False` for ABO (ad-set budget)
- Objectives: `OUTCOME_SALES`, `OUTCOME_TRAFFIC`, `OUTCOME_LEADS`, etc.

## Ad Set
- **Advantage+ placements**: omit `publisher_platforms` and positions from targeting entirely
- `instagram_actor_id` on ad sets is **deprecated** — do not use
- `start_time` is Unix timestamp (UTC)

## Creatives — PAC (Placement Asset Customization)
- Use `asset_feed_spec` with `optimization_type: "REGULAR"` and `ad_formats: ["SINGLE_IMAGE"]`
- Use `instagram_user_id` in `object_story_spec` (NOT `instagram_actor_id` — deprecated in v22.0)
- Portrait image (1152x2048) for Stories/Reels, square (2048x2048) for Feed

### Working PAC structure (v12 — proven)
```json
{
  "object_story_spec": {"page_id": "...", "instagram_user_id": "..."},
  "contextual_multi_ads": {"enroll_status": "OPT_OUT"},
  "asset_feed_spec": {
    "optimization_type": "REGULAR",
    "ad_formats": ["SINGLE_IMAGE"],
    "images": [
      {"hash": "<portrait_hash>", "adlabels": [{"name": "label_story"}]},
      {"hash": "<square_hash>",   "adlabels": [{"name": "label_feed"}]}
    ],
    "bodies": [
      {"text": "<TEXT1>", "adlabels": [{"name": "body_story"}, {"name": "body_feed"}]},
      {"text": "<TEXT2>", "adlabels": [{"name": "body_story"}, {"name": "body_feed"}]}
    ],
    "titles":       [{"text": "<HEADLINE>", "adlabels": [{"name": "title_story"}, {"name": "title_feed"}]}],
    "descriptions": [{"text": " "}],
    "link_urls":    [{"website_url": "https://..."}],
    "call_to_action_types": ["SHOP_NOW"],
    "asset_customization_rules": [
      {
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
  }
}
```

### PAC Rules
- `descriptions: [{"text": " "}]` — space overrides OG meta description from website
- `contextual_multi_ads: {"enroll_status": "OPT_OUT"}` — turns off multi-advertiser ads
- Both TEXT1 and TEXT2 in `bodies` array with **same adlabels** → Meta A/B tests them
- PAC falls back to portrait-only if portrait hash == square hash (no distinct square)
- Adding `descriptions` with adlabels or `captions` triggers "language asset feed" error — avoid
- Adding `threads_user_id` or `threads` to publisher_platforms requires a default rule (which conflicts with geo-targeting) — skip Threads for now

### Valid Facebook positions (for PAC rules)
feed, marketplace, right_hand_column, video_feeds, profile_feed, search, biz_disco_feed,
instream_video, suggested_video, instant_article, notification, facebook_reels_overlay,
story, facebook_reels, profile_reels

### Valid Instagram positions
stream, story, reels, reels_overlay, explore, explore_home, ig_search, shop,
profile_feed, profile_reels, effect_tray

### Valid Messenger positions
story

### Valid Audience Network positions
classic, rewarded_video, instream_video

## Multi-Advertiser Ads
- Set `contextual_multi_ads: {"enroll_status": "OPT_OUT"}` on the creative
- `degrees_of_freedom_spec` with `standard_enhancements` is deprecated
- `multi_advertisers_ads` in `degrees_of_freedom_spec` is also deprecated

## Threads Ads
- Requires Instagram-backed Threads account: POST `/<IG_USER_ID>/instagram_backed_threads_user`
- Add `threads_user_id` to `object_story_spec`
- BUT: combining `threads_user_id` with PAC placement rules requires a default rule which
  conflicts with geo-based rules — currently unsupported cleanly

## Image Hashes
- Upload images via `/{ad_account}/adimages` 
- Images are identified by hash — same file uploaded twice gets same hash
- Portrait: 1152x2048 (9:16), Square: 2048x2048 (1:1)
- Match portrait↔square by filename (same name, different dimensions)

## Rate Limits
- Dev tier: 300 calls/hour
- Standard Access: 3,000 calls/hour (requires App Review)
- Check `x-business-use-case-usage` header for current usage
- On 429: wait 5 minutes and retry

## Checkpointing
- Always save progress to a JSON file after each successful API call
- Script should be safe to re-run (skip already-created items)
- Progress file schema: `{"campaign_id": "...", "adset_ids": {...}, "done_ads": [...]}`
