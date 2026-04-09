---
name: coaching-system
description: "Coaching business operations — student management, call prep, progress tracking, and session summaries. Use when: preparing for a coaching call, reviewing a student's history, summarizing a call transcript, looking up student progress, updating student profiles, or any coaching-related question."
---

# Coaching System

## Directory Layout
```
~/workspace/BUSINESSES/coaching/
├── README.md                      ← Business overview, revenue, team
├── master-knowledge.md            ← Synthesized coaching frameworks from 249 calls across 54 students
├── meetings/                      ← Internal team meetings (Bram, Darren, etc.)
├── students/
│   ├── <name>/
│   │   ├── profile.md             ← Status, start/end date, goals, progress, notes
│   │   └── calls/
│   │       ├── YYYY-MM-DD.md      ← Fathom transcript + summary + action items (auto-ingested)
│   │       └── YYYY-MM-DDb.md     ← Second call same day (suffix b)
│   └── ...
```

**Auto-Ingestion Pipeline:**
- Fathom → auto-summarized every 30 min via cron (`fathom_process.py --poll`)
- Call summaries auto-added to student profiles
- New framework insights surface-threaded into `master-knowledge.md` (manual, weekly or per session)

## Student Profile Format
```markdown
# Student: <Name>

**Status:** 🟢 Active / 🔴 Inactive / ✅ Completed
**Start:** DD Mon YYYY
**End:** DD Mon YYYY
**Email:** student@email.com

## Goals
- Goal 1
- Goal 2

## Progress
- Date: milestone/update

## Notes
- General observations
```

## Call Transcript Format
Fathom auto-generates:
- Summary with timestamped sections
- Action items
- Full transcript with speaker labels and timestamps

## Master-Knowledge Briefing

Before deep work on student strategy or pattern identification:
1. **Quick ref:** Read `master-knowledge.md` → Table of Contents → relevant section
2. **Context:** Understand the framework being taught to that student (testing, scaling, delegation, etc.)
3. **Patterns:** Recognize where student sits in the coaching spectrum (early action, mid-scaling anxiety, late-stage delegation)
4. **Coaching angle:** Apply known patterns to diagnose friction and craft better interventions

This replaces the need to read 249 individual call summaries.

## Pre-Call Brief (generate before a coaching call)
When preparing for a call with student X:
1. Read `students/<name>/profile.md`
2. Read the last 2-3 call transcripts (sorted by date, most recent first)
3. Generate a brief:
   - Student status + time remaining in traject
   - Key goals and current progress
   - Action items from last call (were they completed?)
   - Suggested topics for this call
   - Any patterns or concerns from recent sessions

## Post-Call Update
After a call transcript is available:
1. Read the transcript
2. Update `profile.md` → Progress section with key outcomes
3. Extract concrete action items
4. Flag if student is at risk (missed goals, disengaged, behind schedule)
5. After saving the share summary, run:
   ```
   python ~/workspace/scripts/create_summary_gdoc.py <path-to-share.md>
   ```
   Include the returned Google Doc URL in the Telegram notification so Maurizio can share it directly.

## Student Lookup
To find a student: `ls ~/workspace/BUSINESSES/coaching/students/`
All ~40 student directories use first name (lowercase, hyphenated for multi-word).

## Business Context
- ~60 students total since Aug 2024
- 1 call/week per student
- Discord support 3x/day
- Trajects: €4K solo, €8K with Bram
- Commission: 8.75%
- Team: Pim (closer), setter, Darren (ops), Maurizio (head coach)

## Key Metrics to Track
- Active students count
- Calls completed this week
- Students at risk (no call in 2+ weeks)
- Commission MTD vs target
