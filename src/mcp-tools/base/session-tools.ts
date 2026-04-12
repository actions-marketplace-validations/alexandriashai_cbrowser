/**
 * CBrowser MCP Tools - Session Tools
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { z } from "zod";
import type { McpServer, ToolRegistrationContext } from "../types.js";

/**
 * Register session tools (4 tools: save_session, load_session, list_sessions, delete_session)
 */
export function registerSessionTools(
  server: McpServer,
  { getBrowser }: ToolRegistrationContext
): void {
  server.registerTool("save_session", {
    title: "Save Browser Session",
    description: "Save browser session (cookies, storage) for later use",
    inputSchema: {
      name: z.string().describe("Name for the saved session"),
    },
    annotations: {
      title: "Save Browser Session",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ name }) => {
      const b = await getBrowser();
      await b.saveSession(name);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: true, sessionName: name }, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool("load_session", {
    title: "Load Browser Session",
    description: "Load a previously saved session",
    inputSchema: {
      name: z.string().describe("Name of the session to load"),
    },
    annotations: {
      title: "Load Browser Session",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ name }) => {
      const b = await getBrowser();
      const result = await b.loadSession(name);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool("list_sessions", {
    title: "List Saved Sessions",
    description: "List all saved sessions with metadata (name, domain, cookies count, localStorage keys, created date, size)",
    inputSchema: {},
    annotations: {
      title: "List Saved Sessions",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async () => {
      const b = await getBrowser();
      const sessions = b.listSessionsDetailed();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ sessions }, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool("delete_session", {
    title: "Delete Saved Session",
    description: "Delete a saved session by name",
    inputSchema: {
      name: z.string().describe("Name of the session to delete"),
    },
    annotations: {
      title: "Delete Saved Session",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ name }) => {
      const b = await getBrowser();
      const deleted = b.deleteSession(name);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: deleted, name, message: deleted ? `Session '${name}' deleted` : `Session '${name}' not found` }),
          },
        ],
      };
    }
  );
}
