Set up a recurring job (id: openheard-feedback-triage) that runs every day at 09:00 America/Los_Angeles, starting tomorrow.

Context: I run three product feedback boards on openheard (open-source Canny alternative). Each has its own MCP server, and each is already in your vault as a custom connector:
- AIVA Claims — https://feedback.aivaclaims.com/api/mcp
- Improve Bay Area — https://feedback.improvebayarea.com/api/mcp
- Improve Cortland — https://feedback.improvecortland.com/api/mcp
Tools on each: list_posts, get_post, create_post, set_status, add_comment, list_statuses, list_boards, list_changelog, draft_changelog, publish_changelog. Rate limit 60 req/min per key — stay well under it.

Each run, for each of the three boards:
1. list_posts sort=new (last 24h) and list_posts sort=top limit=10.
2. For every NEW post since the last run: read it (get_post), classify it (feature request / bug / question / spam-or-offtopic), and flag duplicates of existing posts.
3. Recommend — do NOT apply — status changes (e.g. "move #12 to Under review", "merge #14 into #3", "close #9 as spam") and, when 2+ posts are Shipped and not yet in a changelog, offer a draft changelog title + body via draft_changelog ONLY as a draft (never publish_changelog, never set_status, never add_comment on your own — those need my explicit approval in this chat).
4. Post ONE digest to me in this main chat: per board, a short list of new posts (id, title, votes, your classification), the top-5 by votes, your recommended actions, and any drafts you created. Skip a board entirely if nothing changed. If a connector errors (401/403/429/5xx), report the exact status and stop retrying that board for the run.

Stop condition: none — keep running daily until I tell you to stop.
