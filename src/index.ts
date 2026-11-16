import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createTyrantServer } from "./mcp/server";

serveStdio(() => createTyrantServer(), {
  legacy: "serve",
  onerror: (error) => console.error(`[tyrant:mcp] ${error.message}`),
});

