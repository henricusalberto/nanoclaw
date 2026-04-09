#!/usr/bin/env python3
"""
Experiment Pre-Diagnosis: Pull all data before deciding what to test.

Usage:
  python diagnose.py <product_handle> [--days 7] [--campaign-id <id>] [--ad-account <id>]

Example:
  python diagnose.py silkpores --days 7 --campaign-id 626757091046 --ad-account 549769316006

Outputs a decision brief: funnel metrics, Pinterest performance, demographics.
"""

import sys
import os
import sqlite3
import json
import argparse
from datetime import datetime, timedelta

# Pinterest system paths
PINTEREST_CODE = os.path.expanduser("~/.openclaw/workspace/BUSINESSES/pinterest-store/code")
DB_PATH = os.path.join(PINTEREST_CODE, "data/pinterest.db")
sys.path.insert(0, PINTEREST_CODE)


def get_pinterest_metrics(campaign_id, days):
    conn = sqlite3.connect(DB_PATH)
    row = conn.execute("""
        SELECT
            ROUND(SUM(spend), 2) as spend,
            SUM(impressions) as impressions,
            SUM(outbound_clicks) as clicks,
            ROUND(SUM(outbound_clicks) * 100.0 / NULLIF(SUM(impressions), 0), 2) as ctr,
            ROUND(SUM(spend) / NULLIF(SUM(outbound_clicks), 0), 2) as cpc,
            ROUND(AVG(cpm), 2) as cpm,
            ROUND(SUM(conv_checkout), 0) as orders,
            ROUND(SUM(order_value_checkout), 2) as revenue,
            ROUND(SUM(order_value_checkout) / NULLIF(SUM(spend), 0), 2) as roas
        FROM campaign_daily
        WHERE campaign_id = ?
        AND date >= date('now', ? || ' days')
    """, (campaign_id, f"-{days}")).fetchone()
    conn.close()
    if not row or row[0] is None:
        return None
    return {
        "spend": row[0],
        "impressions": row[1],
        "clicks": row[2],
        "ctr_pct": row[3],
        "cpc": row[4],
        "cpm": row[5],
        "orders_pinterest": int(row[6] or 0),
        "revenue_pinterest": row[7],
        "roas_pinterest": row[8],
    }


def get_shopify_funnel(product_handle, days):
    conn = sqlite3.connect(DB_PATH)
    row = conn.execute("""
        SELECT
            SUM(sessions) as sessions,
            SUM(atc) as atc,
            SUM(reached_checkout) as checkouts,
            ROUND(AVG(cvr) * 100, 2) as cvr_pct,
            ROUND(AVG(bounce_rate) * 100, 2) as bounce_pct,
            ROUND(SUM(atc) * 100.0 / NULLIF(SUM(sessions), 0), 2) as atc_rate_pct,
            ROUND(SUM(reached_checkout) * 100.0 / NULLIF(SUM(sessions), 0), 2) as checkout_rate_pct
        FROM shopify_funnel_daily
        WHERE product_url LIKE ?
        AND date >= date('now', ? || ' days')
    """, (f"%{product_handle}%", f"-{days}")).fetchone()
    conn.close()
    if not row or row[0] is None:
        return None
    return {
        "sessions": row[0],
        "atc": row[1],
        "checkouts": row[2],
        "cvr_pct": row[3],
        "bounce_pct": row[4],
        "atc_rate_pct": row[5],
        "checkout_rate_pct": row[6],
    }


def get_shopify_orders(product_handle, days):
    conn = sqlite3.connect(DB_PATH)
    row = conn.execute("""
        SELECT
            COUNT(*) as orders,
            ROUND(SUM(total_price), 2) as revenue,
            ROUND(AVG(total_price), 2) as aov,
            SUM(CASE WHEN customer_order_seq > 1 THEN 1 ELSE 0 END) as repeat_orders
        FROM shopify_orders
        WHERE product_url_normalized LIKE ?
        AND date >= date('now', ? || ' days')
    """, (f"%{product_handle}%", f"-{days}")).fetchone()
    conn.close()
    if not row or row[0] == 0:
        return None
    return {
        "orders": row[0],
        "revenue": row[1],
        "aov": row[2],
        "repeat_orders": row[3] or 0,
    }


def get_demographics(ad_account_id):
    try:
        from pinterest.ingest.pinterest_api import api_get
        r, _ = api_get(f"/ad_accounts/{ad_account_id}/audience_insights", {
            "audience_insight_type": "YOUR_TOTAL_AUDIENCE",
        })
        demo = r.get("demographics", {})
        ages = {a["key"]: round(a["ratio"] * 100, 1) for a in demo.get("ages", [])}
        genders = {g["key"]: round(g["ratio"] * 100, 1) for g in demo.get("genders", [])}
        devices = {d["name"]: round(d["ratio"] * 100, 1) for d in demo.get("devices", [])}
        return {"ages": ages, "genders": genders, "devices": devices}
    except Exception as e:
        return {"error": str(e)}


def diagnose_funnel(pinterest, shopify_funnel, shopify_orders):
    """Identify the weakest point in the funnel."""
    issues = []

    if shopify_funnel:
        bounce = shopify_funnel.get("bounce_pct", 0)
        cvr = shopify_funnel.get("cvr_pct", 0)
        atc = shopify_funnel.get("atc_rate_pct", 0)
        checkout = shopify_funnel.get("checkout_rate_pct", 0)

        if bounce > 80:
            issues.append(f"🔴 Bounce rate {bounce}% — page fails to hook visitors immediately (hero, headline, above-fold)")
        elif bounce > 65:
            issues.append(f"🟡 Bounce rate {bounce}% — above average, above-fold needs review")

        if atc < 5:
            issues.append(f"🔴 ATC rate {atc}% — very low, product page not convincing (images, copy, price, social proof)")
        elif atc < 8:
            issues.append(f"🟡 ATC rate {atc}% — below benchmark (~8-10%), page persuasion needs work")

        if checkout > 0 and cvr < 1.5:
            issues.append(f"🔴 CVR {cvr}% — checkout drop-off high, friction in checkout flow")
        elif cvr < 2.5:
            issues.append(f"🟡 CVR {cvr}% — below strong benchmark (~3%), room to improve")

        # Funnel drop-off diagnosis
        if atc > 0 and checkout > 0:
            atc_to_checkout = round(checkout / atc * 100, 0) if atc else 0
            if atc_to_checkout < 50:
                issues.append(f"🔴 Only {atc_to_checkout}% of ATC reach checkout — cart abandonment is killing conversions")

    if pinterest:
        ctr = pinterest.get("ctr_pct", 0)
        roas = pinterest.get("roas_pinterest", 0)
        if ctr < 0.5:
            issues.append(f"🔴 CTR {ctr}% — creative/pin not stopping the scroll, test new hooks")
        elif ctr < 1.5:
            issues.append(f"🟡 CTR {ctr}% — average, creative improvement likely worth testing")
        if roas and roas < 2.0:
            issues.append(f"🔴 ROAS {roas}x — below break-even threshold")
        elif roas and roas < 3.0:
            issues.append(f"🟡 ROAS {roas}x — profitable but below scale threshold (3x)")

    # Highest leverage recommendation
    if issues:
        # Prioritize: bounce > atc > cvr > creative
        primary = None
        if any("Bounce" in i for i in issues):
            primary = "PAGE — Fix above-fold: headline, hero image, immediate value prop"
        elif any("ATC" in i for i in issues):
            primary = "PAGE — Improve product page persuasion: images, description, social proof, price anchor"
        elif any("CVR" in i for i in issues):
            primary = "CHECKOUT — Reduce cart abandonment: trust badges, urgency, simplified checkout"
        elif any("CTR" in i for i in issues):
            primary = "CREATIVE — Test new pin hooks, angles, or formats"
        else:
            primary = "SCALE — Funnel looks healthy, test budget increases"
        return {"issues": issues, "primary_leverage": primary}

    return {"issues": ["✅ No obvious funnel issues detected"], "primary_leverage": "SCALE or test new creatives"}


def format_brief(product_handle, days, pinterest, shopify_funnel, shopify_orders, demographics, diagnosis):
    lines = []
    lines.append(f"\n{'='*60}")
    lines.append(f"  DIAGNOSIS BRIEF — {product_handle.upper()}  ({days}d window)")
    lines.append(f"{'='*60}")

    # Pinterest performance
    lines.append("\n📌 PINTEREST PERFORMANCE")
    if pinterest:
        lines.append(f"  Spend:       €{pinterest['spend']}")
        lines.append(f"  Impressions: {pinterest['impressions']:,}")
        lines.append(f"  Clicks:      {pinterest['clicks']:,}")
        lines.append(f"  CTR:         {pinterest['ctr_pct']}%")
        lines.append(f"  CPC:         €{pinterest['cpc']}")
        lines.append(f"  CPM:         €{pinterest['cpm']}")
        lines.append(f"  Orders (pin): {pinterest['orders_pinterest']}")
        lines.append(f"  ROAS (pin):  {pinterest['roas_pinterest']}x")
    else:
        lines.append("  No Pinterest data found for this campaign.")

    # Shopify funnel
    lines.append("\n🛒 SHOPIFY FUNNEL")
    if shopify_funnel:
        lines.append(f"  Sessions:    {shopify_funnel['sessions']:,}")
        lines.append(f"  Bounce rate: {shopify_funnel['bounce_pct']}%")
        lines.append(f"  ATC rate:    {shopify_funnel['atc_rate_pct']}%  ({shopify_funnel['atc']} adds)")
        lines.append(f"  Checkout:    {shopify_funnel['checkout_rate_pct']}%  ({shopify_funnel['checkouts']} reached)")
        lines.append(f"  CVR:         {shopify_funnel['cvr_pct']}%")
    else:
        lines.append("  No Shopify funnel data found.")

    if shopify_orders:
        lines.append(f"\n💰 SHOPIFY ORDERS")
        lines.append(f"  Orders:      {shopify_orders['orders']}")
        lines.append(f"  Revenue:     ${shopify_orders['revenue']}")
        lines.append(f"  AOV:         ${shopify_orders['aov']}")
        lines.append(f"  Repeat:      {shopify_orders['repeat_orders']}")

    # Demographics
    lines.append("\n👥 AUDIENCE DEMOGRAPHICS (account-level)")
    if demographics and "error" not in demographics:
        ages = demographics.get("ages", {})
        genders = demographics.get("genders", {})
        devices = demographics.get("devices", {})

        age_sorted = sorted(ages.items(), key=lambda x: -x[1])
        lines.append(f"  Top ages:    " + " | ".join([f"{a}: {p}%" for a, p in age_sorted[:4]]))

        gender_sorted = sorted(genders.items(), key=lambda x: -x[1])
        lines.append(f"  Gender:      " + " | ".join([f"{g}: {p}%" for g, p in gender_sorted]))

        device_sorted = sorted(devices.items(), key=lambda x: -x[1])
        lines.append(f"  Devices:     " + " | ".join([f"{d}: {p}%" for d, p in device_sorted[:3]]))
    else:
        lines.append(f"  Error fetching demographics: {demographics.get('error', 'unknown')}")

    # Funnel diagnosis
    lines.append("\n🔍 FUNNEL DIAGNOSIS")
    for issue in diagnosis["issues"]:
        lines.append(f"  {issue}")

    lines.append(f"\n⚡ HIGHEST LEVERAGE:")
    lines.append(f"  → {diagnosis['primary_leverage']}")
    lines.append(f"\n{'='*60}\n")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("product_handle", help="Product handle, e.g. 'silkpores'")
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--campaign-id", default=None)
    parser.add_argument("--ad-account", default="549769316006")
    args = parser.parse_args()

    print(f"Pulling data for '{args.product_handle}' ({args.days}d)...")

    pinterest = get_pinterest_metrics(args.campaign_id, args.days) if args.campaign_id else None
    shopify_funnel = get_shopify_funnel(args.product_handle, args.days)
    shopify_orders = get_shopify_orders(args.product_handle, args.days)
    demographics = get_demographics(args.ad_account)
    diagnosis = diagnose_funnel(pinterest, shopify_funnel, shopify_orders)

    brief = format_brief(
        args.product_handle, args.days,
        pinterest, shopify_funnel, shopify_orders,
        demographics, diagnosis
    )
    print(brief)

    # Save to file for reference
    out_path = os.path.join(os.path.dirname(__file__), f"../data/diagnose_{args.product_handle}_{args.days}d.txt")
    with open(out_path, "w") as f:
        f.write(brief)
    print(f"Saved to: {out_path}")


if __name__ == "__main__":
    main()
