---
name: telegram-admin
description: Telegram group admin actions — edit topic names and emoji icons, create or delete topics, pin messages. Use when asked to rename a topic, change a topic emoji, add a new topic, or pin something in the Telegram group.
---

# Telegram Admin

Manage the Telegram supergroup via the Bot API. The bot token and group ID are read from the environment — no credentials need to be provided manually.

## Setup

```bash
BOT_TOKEN="$TELEGRAM_BOT_TOKEN"
# Extract numeric chat ID from the group JID (e.g. tg:-1003907911824:topic:6 → -1003907911824)
CHAT_ID=$(echo "$CHAT_JID" | sed 's/^tg://' | sed 's/:topic:.*//')
```

If `CHAT_JID` is not in scope, use the known group ID directly: `-1003907911824`

---

## Edit a topic (name or emoji)

```bash
curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/editForumTopic" \
  -H "Content-Type: application/json" \
  -d "{
    \"chat_id\": \"${CHAT_ID}\",
    \"message_thread_id\": <THREAD_ID>,
    \"name\": \"<NEW_NAME>\",
    \"icon_custom_emoji_id\": \"<EMOJI_ID>\"
  }"
```

- Omit `name` to keep the existing name.
- Omit `icon_custom_emoji_id` to keep the existing emoji.
- `message_thread_id` is the topic number (e.g. `6` for Pinterest, `7` for Coaching).

### Known topic IDs

| Topic | Thread ID |
|-------|-----------|
| Pinterest | 6 |
| Coaching | 7 |
| Revive Plus | 8 |
| Finance | 9 |
| Strategy | 10 |
| Planning | 11 |
| Alerts | 12 |
| Daily Briefing | 13 |
| Wiki Inbox | 14 |

For General (thread 1), use `editGeneralForumTopic` — it only supports name changes, not emoji.

---

## Create a new topic

```bash
curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/createForumTopic" \
  -H "Content-Type: application/json" \
  -d "{
    \"chat_id\": \"${CHAT_ID}\",
    \"name\": \"<TOPIC_NAME>\",
    \"icon_custom_emoji_id\": \"<EMOJI_ID>\"
  }"
```

The response includes the new `message_thread_id` — note it if you need to use it later.

---

## Delete a topic

```bash
curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/deleteForumTopic" \
  -H "Content-Type: application/json" \
  -d "{\"chat_id\": \"${CHAT_ID}\", \"message_thread_id\": <THREAD_ID>}"
```

⚠️ This deletes the topic AND all its messages. Confirm with the user before doing this.

---

## Pin a message

```bash
curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/pinChatMessage" \
  -H "Content-Type: application/json" \
  -d "{
    \"chat_id\": \"${CHAT_ID}\",
    \"message_id\": <MESSAGE_ID>,
    \"disable_notification\": true
  }"
```

---

## Unpin a message

```bash
curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/unpinChatMessage" \
  -H "Content-Type: application/json" \
  -d "{\"chat_id\": \"${CHAT_ID}\", \"message_id\": <MESSAGE_ID>}"
```

---

## Available emoji icons

Use these IDs in `icon_custom_emoji_id`:

| Emoji | ID |
|-------|----|
| 📰 | 5434144690511290129 |
| 💡 | 5312536423851630001 |
| ⚡ | 5312016608254762256 |
| ❗ | 5379748062124056162 |
| 📝 | 5373251851074415873 |
| 📆 | 5433614043006903194 |
| 📁 | 5357315181649076022 |
| 🔎 | 5309965701241379366 |
| 📣 | 5309984423003823246 |
| 🔥 | 5312241539987020022 |
| ❤️ | 5312138559556164615 |
| 📈 | 5350305691942788490 |
| 📉 | 5350713563512052787 |
| 💎 | 5309958691854754293 |
| 💰 | 5350452584119279096 |
| 💸 | 5309929258443874898 |
| 🪙 | 5377690785674175481 |
| 🎮 | 5309950797704865693 |
| 💻 | 5350554349074391003 |
| 📱 | 5409357944619802453 |
| 🏠 | 5312486108309757006 |
| 🎉 | 5310228579009699834 |
| ‼️ | 5377498341074542641 |
| 🏆 | 5312315739842026755 |
| 🏁 | 5408906741125490282 |
| 🎬 | 5368653135101310687 |
| 🎵 | 5310045076531978942 |
| 📚 | 5350481781306958339 |
| 👑 | 5357107601584693888 |
| ✈️ | 5348436127038579546 |
| 🦄 | 5413625003218313783 |
| 🛍 | 5350699789551935589 |
| 🤖 | 5309832892262654231 |
| 🎓 | 5357419403325481346 |
| 🔭 | 5368585403467048206 |
| 🔬 | 5377580546748588396 |
| 💼 | 5348227245599105972 |
| 🧪 | 5411138633765757782 |
| 💊 | 5310094636159607472 |
| 🍽 | 5350344462612570293 |
| 🎨 | 5310039132297242441 |
| 🎭 | 5350658016700013471 |
| 🔮 | 5350367161514732241 |
| ☕ | 5350392020785437399 |
| 💬 | 5417915203100613993 |
| ✍️ | 5238156910363950406 |
| ⭐ | 5235579393115438657 |
| ✅ | 5237699328843200968 |
| 🧠 | 5237889595894414384 |
| 🗳 | 5350387571199319521 |
| 🏛 | 5350548830041415279 |
| 🧮 | 5355127101970194557 |
| 🩺 | 5350307998340226571 |
| 🎩 | 5357504778685392027 |
| 🎟 | 5377624166436445368 |
| 📆 | 5433614043006903194 |
| 🏔 | 5418196338774907917 |

If you need an emoji not in this list, call `getForumTopicIconStickers` to get the full set:

```bash
curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getForumTopicIconStickers" | \
  python3 -c "import json,sys; [print(s['emoji'], s.get('custom_emoji_id','')) for s in json.load(sys.stdin).get('result',[])]"
```

---

## Checking results

All API calls return JSON with `"ok": true` on success. On failure, `"description"` explains the error. Parse with:

```bash
echo "$RESULT" | python3 -c "import json,sys; r=json.load(sys.stdin); print('OK' if r.get('ok') else r.get('description'))"
```
