# Claude Desktop compatibility

Claude Desktop exposes Tyrant as an MCP server and can use static project instructions, but this adapter does not claim automatic per-prompt preflight. Claude Desktop does not provide the `UserPromptSubmit` hook used by Claude Code. Use Tyrant's MCP tools explicitly there until the host exposes a supported pre-model hook.
