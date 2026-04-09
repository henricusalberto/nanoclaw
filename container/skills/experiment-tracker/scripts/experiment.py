#!/usr/bin/env python3
"""
Experiment Tracker CLI
Usage:
  python experiment.py list [--business <name>] [--status running|concluded|paused]
  python experiment.py get <id>
  python experiment.py add <json_string>
  python experiment.py update <id> <json_patch_string>
  python experiment.py conclude <id> <result> <learning>
  python experiment.py next-id
"""

import json
import sys
import os
from datetime import date

DATA_FILE = os.path.join(os.path.dirname(__file__), "../data/experiments.json")
LEARNINGS_FILE = os.path.join(os.path.dirname(__file__), "../data/learnings.md")


def load():
    with open(DATA_FILE) as f:
        return json.load(f)


def save(data):
    with open(DATA_FILE, "w") as f:
        json.dump(data, f, indent=2)


def next_id(data):
    if not data["experiments"]:
        return "EXP-001"
    nums = [int(e["id"].split("-")[1]) for e in data["experiments"]]
    return f"EXP-{max(nums)+1:03d}"


def cmd_list(args):
    data = load()
    exps = data["experiments"]
    # filters
    for arg in args:
        if arg.startswith("--business="):
            b = arg.split("=", 1)[1]
            exps = [e for e in exps if e.get("business", "").lower() == b.lower()]
        elif arg.startswith("--status="):
            s = arg.split("=", 1)[1]
            exps = [e for e in exps if e.get("status", "").lower() == s.lower()]

    if not exps:
        print("No experiments found.")
        return

    print(f"{'ID':<10} {'Status':<12} {'Business':<12} {'Variable':<30} {'Started':<12}")
    print("-" * 80)
    for e in exps:
        print(f"{e['id']:<10} {e['status']:<12} {e.get('business','?'):<12} {e.get('variable','?')[:28]:<30} {e.get('start_date','?'):<12}")


def cmd_get(exp_id):
    data = load()
    for e in data["experiments"]:
        if e["id"] == exp_id:
            print(json.dumps(e, indent=2))
            return
    print(f"Experiment {exp_id} not found.")
    sys.exit(1)


def cmd_add(json_str):
    data = load()
    exp = json.loads(json_str)
    exp["id"] = next_id(data)
    exp.setdefault("status", "running")
    exp.setdefault("start_date", str(date.today()))
    data["experiments"].append(exp)
    save(data)
    print(f"Added {exp['id']}")


def cmd_update(exp_id, patch_str):
    data = load()
    patch = json.loads(patch_str)
    for e in data["experiments"]:
        if e["id"] == exp_id:
            e.update(patch)
            save(data)
            print(f"Updated {exp_id}")
            return
    print(f"Experiment {exp_id} not found.")
    sys.exit(1)


def cmd_conclude(exp_id, result, learning):
    data = load()
    for e in data["experiments"]:
        if e["id"] == exp_id:
            e["status"] = "concluded"
            e["end_date"] = str(date.today())
            e["result"] = result
            e["learning"] = learning
            save(data)
            # append to learnings file
            business = e.get("business", "General / Business").title()
            section_map = {
                "Pinterest": "## Pinterest",
                "Revive Plus": "## Revive Plus",
                "Revive": "## Revive Plus",
            }
            section = section_map.get(business, "## General / Business")
            entry = f"\n### {e['id']} — {e.get('variable','?')} ({e['end_date']})\n**Hypothesis:** {e.get('hypothesis','?')}\n**Result:** {result}\n**Learning:** {learning}\n"
            with open(LEARNINGS_FILE, "r") as f:
                content = f.read()
            if section in content:
                content = content.replace(section, section + "\n" + entry, 1)
            else:
                content += f"\n{section}{entry}"
            with open(LEARNINGS_FILE, "w") as f:
                f.write(content)
            print(f"Concluded {exp_id}. Learning appended to learnings.md.")
            return
    print(f"Experiment {exp_id} not found.")
    sys.exit(1)


def cmd_next_id():
    data = load()
    print(next_id(data))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]
    rest = sys.argv[2:]

    if cmd == "list":
        cmd_list(rest)
    elif cmd == "get" and rest:
        cmd_get(rest[0])
    elif cmd == "add" and rest:
        cmd_add(rest[0])
    elif cmd == "update" and len(rest) >= 2:
        cmd_update(rest[0], rest[1])
    elif cmd == "conclude" and len(rest) >= 3:
        cmd_conclude(rest[0], rest[1], rest[2])
    elif cmd == "next-id":
        cmd_next_id()
    else:
        print(__doc__)
        sys.exit(1)
