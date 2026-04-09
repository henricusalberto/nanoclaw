#!/usr/bin/env python3
"""Interactive builder for Meta launcher config.json."""

import json
from datetime import timezone
from pathlib import Path

from dateutil import parser as date_parser


def ask(prompt, default=None, required=True):
    suffix = f" [{default}]" if default is not None else ""
    while True:
        v = input(f"{prompt}{suffix}: ").strip()
        if not v and default is not None:
            return str(default)
        if v:
            return v
        if not required:
            return ""
        print("Value required.")


def ask_int(prompt, default=None):
    while True:
        v = ask(prompt, default=default)
        try:
            return int(v)
        except ValueError:
            print("Please enter a valid integer.")


def ask_float(prompt, default=None):
    while True:
        v = ask(prompt, default=default)
        try:
            return float(v)
        except ValueError:
            print("Please enter a valid number.")


def ask_multiline(prompt):
    print(f"{prompt} (finish with blank line):")
    lines = []
    while True:
        line = input()
        if line == "":
            break
        lines.append(line)
    return "\n".join(lines).strip()


def parse_timestamp(natural_text):
    dt = date_parser.parse(natural_text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.astimezone(timezone.utc).timestamp())


def main():
    print("Meta config setup")
    print("=" * 40)

    campaign_name = ask("1) Campaign name")
    token = ask("2) Meta token")
    account_id = ask("3) Ad account ID (e.g. act_123...)")
    page_id = ask("4) Page ID")
    ig_user_id = ask("5) Instagram User ID")
    pixel_id = ask("6) Pixel ID")
    url = ask("7) Landing page URL")
    objective = ask("8) Campaign objective", default="OUTCOME_SALES")

    while True:
        natural_dt = ask("9) Launch date/time (e.g. March 3 2026 04:00 PST)")
        try:
            start_time = parse_timestamp(natural_dt)
            break
        except Exception as e:
            print(f"Could not parse date/time: {e}")

    budget_usd = ask_float("10) Ad set daily budget in USD", default="25")
    budget_cents = int(round(budget_usd * 100))

    adsets = []
    adset_count = ask_int("11) How many ad sets?")
    for i in range(adset_count):
        print(f"  Ad set {i + 1}/{adset_count}")
        code = ask("    code (e.g. SP)")
        name = ask("    full name (e.g. Social Parent)")
        adsets.append({"code": code, "name": name, "daily_budget_cents": budget_cents})

    age_min = ask_int("12) Targeting age min", default="18")
    countries_raw = ask("12) Countries comma-separated", default="US")
    countries = [c.strip().upper() for c in countries_raw.split(",") if c.strip()]

    versions = []
    version_count = ask_int("13) How many ad versions?")
    for i in range(version_count):
        versions.append(ask(f"    Version {i + 1} name"))

    texts = []
    text_count = ask_int("14) How many primary texts? (1 or 2)", default="2")
    if text_count < 1:
        text_count = 1
    if text_count > 2:
        text_count = 2
    for i in range(text_count):
        texts.append(ask_multiline(f"    Primary text {i + 1}"))

    headline = ask("15) Headline")

    creatives = []
    creative_count = ask_int("16) How many creatives?")
    for i in range(creative_count):
        print(f"  Creative {i + 1}/{creative_count}")
        cid = ask("    Creative ID")
        adset_code = ask("    Ad set code")
        identity = ask("    Identity label")

        images = {}
        for version in versions:
            print(f"    Version '{version}' image hashes")
            portrait = ask("      portrait hash")
            square = ask("      square hash (Enter = use portrait)", required=False)
            square_value = square if square else portrait
            images[version] = {"portrait": portrait, "square": square_value}

        creatives.append(
            {
                "id": cid,
                "adset_code": adset_code,
                "identity": identity,
                "images": images,
            }
        )

    output_name = ask("17) Output filename", default="config.json")

    config = {
        "meta": {
            "token": token,
            "account_id": account_id,
            "page_id": page_id,
            "ig_user_id": ig_user_id,
            "pixel_id": pixel_id,
        },
        "campaign": {
            "name": campaign_name,
            "objective": objective,
            "start_time": start_time,
        },
        "adsets": adsets,
        "targeting": {
            "age_min": age_min,
            "countries": countries,
            "location_types": ["home", "recent"],
        },
        "copy": {
            "headline": headline,
            "texts": texts,
            "url": url,
        },
        "versions": versions,
        "creatives": creatives,
        "progress_file": "meta_progress.json",
    }

    print("\nSummary")
    print("=" * 40)
    print(json.dumps(config, indent=2, ensure_ascii=False))

    confirm = ask("Save this config? (y/n)", default="n").lower()
    if confirm != "y":
        print("Canceled, config not saved.")
        return

    output_path = Path(output_name).expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"Saved config to: {output_path}")


if __name__ == "__main__":
    main()
