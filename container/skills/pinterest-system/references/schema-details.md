# Database Schema
-- Pinterest Batch Intelligence System - Schema

CREATE TABLE IF NOT EXISTS fact_ads_daily (
    date TEXT NOT NULL,
    advertiser_id TEXT,
    advertiser_name TEXT,
    currency TEXT DEFAULT 'EUR',
    campaign_id TEXT,
    campaign_name TEXT,
    adgroup_id TEXT,
    adgroup_name TEXT,
    ad_id TEXT NOT NULL,
    ad_name TEXT,
    destination_url TEXT,
    destination_url_normalized TEXT,
    spend_eur REAL DEFAULT 0,
    impressions INTEGER DEFAULT 0,
    outbound_clicks INTEGER DEFAULT 0,
    cpm REAL,
    ctr REAL,
    cpc REAL,
    checkout_conversions INTEGER DEFAULT 0,
    checkout_value_eur REAL DEFAULT 0,
    roas_checkout REAL,
    PRIMARY KEY (date, ad_id)
);

CREATE TABLE IF NOT EXISTS store_research (
    store_key TEXT PRIMARY KEY,
    store_url TEXT,
    pinterest_url TEXT,
    minea_url TEXT,
    niche TEXT,
    keyword TEXT,
    country TEXT,
    monthly_visitors INTEGER,
    monthly_pin_views INTEGER,
    products_on_store INTEGER,
    found_date TEXT,
    researcher TEXT,
    reasoning TEXT,
    batch_1_result TEXT,
    batch_2_result TEXT,
    batch_3_result TEXT,
    batch_4_result TEXT
);

CREATE TABLE IF NOT EXISTS product_tests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_key TEXT,
    competitor_url TEXT,
    batch_number INTEGER,
    status TEXT,
    product_name TEXT,
    launch_date TEXT,
    competitor_product_url TEXT,
    our_store_url TEXT,
    our_store_url_normalized TEXT,
    creatives_url TEXT,
    selling_price REAL,
    euro_selling_price REAL,
    cogs REAL,
    be_cpa REAL,
    be_roas REAL,
    cog_plus_20pct REAL,
    profit_20pct REAL,
    target_roas_20pct REAL,
    campaign_name TEXT,
    ad_name TEXT,
    results TEXT,
    next_step TEXT,
    note_1 TEXT,
    note_2 TEXT,
    note_3 TEXT,
    UNIQUE(store_key, batch_number, ad_name)
);

CREATE TABLE IF NOT EXISTS scaling (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scaling_number INTEGER,
    status TEXT,
    scale_date TEXT,
    product_name TEXT,
    launch_date TEXT,
    competitor_url TEXT,
    our_store_url TEXT,
    creatives_url TEXT,
    selling_price REAL,
    cogs REAL,
    be_cpa REAL,
    be_roas REAL,
    cog_plus_20pct REAL,
    profit_20pct REAL,
    target_roas_20pct REAL,
    campaign_name TEXT,
    results TEXT,
    notes TEXT,
    page_optimized TEXT,
    offer_optimized TEXT,
    reviews TEXT
);

CREATE TABLE IF NOT EXISTS budget_snapshot_campaign (
    snapshot_date TEXT NOT NULL,
    advertiser_id TEXT,
    campaign_id TEXT NOT NULL,
    campaign_name TEXT,
    daily_budget REAL,
    campaign_status TEXT,
    PRIMARY KEY (snapshot_date, campaign_id)
);

CREATE TABLE IF NOT EXISTS inferred_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    entity_type TEXT NOT NULL,  -- campaign / ad / product / store
    entity_id TEXT NOT NULL,
    action_type TEXT NOT NULL,  -- launch / pause / kill / revive / scale_up / scale_down / spend_hog_detected / batch_advance_recommended
    magnitude REAL,
    confidence REAL,
    evidence_json TEXT
);

CREATE TABLE IF NOT EXISTS event_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER REFERENCES inferred_events(event_id),
    evaluation_window_days INTEGER,
    delta_roas REAL,
    delta_profit REAL,
    delta_ctr REAL,
    delta_cpm REAL,
    verdict TEXT,
    confidence REAL
);

CREATE TABLE IF NOT EXISTS discovered_patterns (
    pattern_id INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern_type TEXT,
    scope TEXT,
    metrics_involved TEXT,
    effect_size REAL,
    confidence REAL,
    examples_json TEXT,
    discovered_date TEXT
);

-- Indexes for common joins
CREATE INDEX IF NOT EXISTS idx_fact_ads_destination ON fact_ads_daily(destination_url_normalized);
CREATE INDEX IF NOT EXISTS idx_fact_ads_campaign ON fact_ads_daily(campaign_name);
CREATE INDEX IF NOT EXISTS idx_fact_ads_date ON fact_ads_daily(date);
CREATE INDEX IF NOT EXISTS idx_product_tests_store ON product_tests(store_key);
CREATE INDEX IF NOT EXISTS idx_product_tests_url ON product_tests(our_store_url_normalized);
CREATE INDEX IF NOT EXISTS idx_product_tests_campaign ON product_tests(campaign_name);
