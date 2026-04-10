---
name: sunsama
description: Manage Sunsama tasks, daily planning, calendar events, channels, and time tracking via the official Sunsama MCP server. Use whenever the user wants to plan their day, add/complete/move tasks, check what's on today/tomorrow, or interact with their Sunsama workspace.
---

# Sunsama

The user manages their day in Sunsama. Tasks are exposed as MCP tools under the `mcp__sunsama__*` namespace via the official remote MCP server at `https://api.sunsama.com/mcp`. Authentication is handled by a bearer token injected at container start — you don't need to do anything to authenticate.

If `mcp__sunsama__*` tools are not visible in your tool list, the bearer token is missing or invalid. Tell the user to check `~/.openclaw/workspace/secrets/sunsama.env`.

## When to use

Use Sunsama tools whenever the user mentions:
- "today" / "tomorrow" / "this week" in the context of planning
- adding, completing, moving, or rescheduling a task
- their day, daily planning, or what's on their plate
- channels, projects, or recurring tasks in Sunsama
- time tracking, time spent, focus sessions

Sunsama is the user's primary task system. Prefer it over Todoist for everyday work unless the user explicitly says "todoist".

## Discovering the tools

The MCP server exposes its tool list dynamically. Don't assume tool names — call your tool listing capability or look for tools matching `mcp__sunsama__*` and read their descriptions. Common verbs you can expect:

- list / get tasks (today, backlog, by date, by channel)
- create task
- complete / uncomplete task
- update task (rename, reschedule, move channel, set duration)
- delete task
- list channels / projects
- list streams
- get/update day plan

Always inspect the actual tool schemas before calling — the API evolves.

## Coexistence with Todoist

The user has both Sunsama and Todoist set up. Default to Sunsama. Only use Todoist (`td` CLI) when:
- the user explicitly names Todoist
- the user references something that's clearly already in Todoist (e.g. an existing project name, a Todoist URL)

Never silently sync between them.

## Output style

When listing tasks back to the user in chat, keep it tight: title + due/scheduled date + channel if non-obvious. Don't dump JSON. The user is on a phone most of the time.

## Authentication / setup notes (for debugging only)

- Token file: `~/.openclaw/workspace/secrets/sunsama.env` on the host (key: `SUNSAMA_BEARER_TOKEN`)
- Injected into the container as the `SUNSAMA_BEARER_TOKEN` env var
- The agent runner registers the MCP server only if that env var is set, so a missing token simply hides the tools rather than crashing the container
- Tokens are long-lived bearer JWTs from Sunsama; if they ever rotate them, regenerate via Sunsama settings and overwrite the env file
