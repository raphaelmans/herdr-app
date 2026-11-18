---
name: lific
description: The Lific session, holding only Lific's MCP tools.
tools: search_tool, use_tool
mcpServers:
  - name: lific
    command: sh
    args: ["-c", "exec \"$HOME/.local/bin/lific\" mcp"]
---
You are the Lific session. Work only through the lific MCP server's tools; the first message says how.
