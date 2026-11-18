---
name: lific
description: How to work in Lific, the person's issue tracker, through its MCP tools. Covers its model (projects, issues, pages, plans, modules, labels), how to file and triage issues, and how to answer questions about the work. Use for any request about Lific issues, pages, plans or projects.
---

# Working in Lific

Lific is a personal, local issue tracker. You reach it through the `lific` MCP server's tools (`mcp__lific__*`).

## What it holds

- **Project**: has an identifier such as `RAISE`. Its issues are numbered `RAISE-12`. List projects with `list_resources(resource_type='project')`.
- **Issue**: one self-contained change. Its status is one of `backlog`, `todo`, `active`, `done` or `cancelled`. Its priority is one of `none`, `low`, `medium`, `high` or `urgent`. It can carry labels and belongs to a module.
- **Module**: a part of a project (an area, a feature). File each new issue in one. List them with `list_resources(resource_type='module', project=…)`.
- **Label**: a tag shared within a project. Reuse existing labels rather than inventing near-duplicates.
- **Link**: `blocks`, `relates_to` or `duplicate`, between two issues (`link_issues`). An issue is *workable* when it is open and nothing open blocks it.
- **Marked for a person**: an issue with `for:human` or `for:@name` is waiting on a person, not on an agent.
- **Page**: documentation or design notes, kept in folders. Long pages come back as an outline; read them by section.
- **Plan**: a nested list of steps for multi-step work (`create_plan`, `get_plan`, `update_plan_step`). A step can mirror an issue, and closing either one closes both.

## Reading

| You want | Call |
| --- | --- |
| Where a project stands: plans, blocked, workable, active, key pages | `get_briefing(project=…)` (add `since=` to see only what changed) |
| Issues by filter (status, label, module, priority, workable) | `list_issues` |
| A board, by status, priority or module | `get_board` |
| One issue with its last comments | `get_issue`, then `list_comments` for more |
| Text anywhere in issues, pages and comments | `search` |
| Who changed what, and when | `get_activity` |

Answer questions from what these return. Count, group and summarise. Don't paste raw tool output.

## Changing

- **New issue**: `create_issue` (up to 50 at once with `issues`). Use a short imperative title, a description in the person's own words plus anything they gave, a module, and a priority only when they implied one. The default status is `todo`, or `backlog` when they say "someday" or "later".
- **Small text change**: `edit_issue`, `edit_page`, `edit_comment` replace one exact string. Use `update_issue` or `update_page` only for fields such as status, priority, labels or module.
- **Many issues at once**: `bulk_update` changes every issue that matches a filter, up to 500. Say how many it changed. Before running it, read the matching issues and confirm the filter catches exactly what the person meant.
- **Comment**: `add_comment` on an issue or a page. It is written as the person; keep their voice.
- **Finishing work**: set `status='done'`. Use `cancelled` for work dropped.
- **Deleting**: `delete` is permanent. Use it only when the person says "delete" in plain words for that exact thing.

## Triage, when asked

Read the project's open issues (`list_issues` or `get_board`). Then propose rather than act: name the duplicates to close, the issues missing a module or priority, the stale `active` ones, and the blockers. Make the changes once the person agrees, or right away when they asked for them outright.

## Answering

Keep it to one to three plain lines unless you were asked for a list or a summary. Name every issue or page you touched by its identifier. If you changed nothing, say why.
