/**
 * CBrowser MCP Tools - Advanced Interaction Tools
 *
 * hover, type_text, press_key, handle_dialog, upload_file, drag
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

import { z } from "zod";
import type { McpServer, ToolRegistrationContext } from "../types.js";

/**
 * Register advanced interaction tools (6 tools)
 */
export function registerAdvancedInteractionTools(
  server: McpServer,
  { getBrowser, getBrowserByToken }: ToolRegistrationContext
): void {

  // ── hover ──
  server.registerTool("hover", {
    title: "Hover Over Element",
    description: "Hover over an element to trigger tooltips, dropdowns, or hover states. Uses CSS selector or smart selector.",
    inputSchema: {
      selector: z.string().describe("CSS selector or text description of the element to hover"),
      _browserToken: z.string().optional().describe("Browser session token"),
    },
    annotations: { title: "Hover", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ selector, _browserToken }) => {
    let b, token;
    if (getBrowserByToken) { const r = await getBrowserByToken(_browserToken); b = r.browser; token = r.token; }
    else { b = await getBrowser(); }
    const result = await b.hover(selector);
    return { content: [{ type: "text" as const, text: JSON.stringify({ ...result, _browserToken: token }, null, 2) }] };
  });

  // ── type_text ──
  server.registerTool("type_text", {
    title: "Type Text (Keyboard)",
    description: "Type text character by character using keyboard events. Unlike 'fill', this triggers keydown/keypress/keyup events for each character. Use for inputs that need real keyboard events (autocomplete, search-as-you-type, game inputs).",
    inputSchema: {
      text: z.string().describe("Text to type"),
      delay: z.number().optional().default(50).describe("Delay between keystrokes in ms (default 50)"),
      _browserToken: z.string().optional().describe("Browser session token"),
    },
    annotations: { title: "Type Text", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ text, delay, _browserToken }) => {
    let b, token;
    if (getBrowserByToken) { const r = await getBrowserByToken(_browserToken); b = r.browser; token = r.token; }
    else { b = await getBrowser(); }
    const page = await b.getPage();
    await page.keyboard.type(text, { delay: delay || 50 });
    return { content: [{ type: "text" as const, text: JSON.stringify({ typed: text, characters: text.length, _browserToken: token }, null, 2) }] };
  });

  // ── press_key ──
  server.registerTool("press_key", {
    title: "Press Key",
    description: "Press a keyboard key (Enter, Tab, Escape, ArrowDown, Backspace, etc). Supports modifier combos: 'Control+a', 'Shift+Enter', 'Meta+c'. Full list: https://developer.mozilla.org/en-US/docs/Web/API/UI_Events/Keyboard_event_key_values",
    inputSchema: {
      key: z.string().describe("Key to press (e.g., 'Enter', 'Tab', 'Escape', 'ArrowDown', 'Control+a', 'Meta+c')"),
      _browserToken: z.string().optional().describe("Browser session token"),
    },
    annotations: { title: "Press Key", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ key, _browserToken }) => {
    let b, token;
    if (getBrowserByToken) { const r = await getBrowserByToken(_browserToken); b = r.browser; token = r.token; }
    else { b = await getBrowser(); }
    const page = await b.getPage();
    await page.keyboard.press(key);
    return { content: [{ type: "text" as const, text: JSON.stringify({ pressed: key, _browserToken: token }, null, 2) }] };
  });

  // ── handle_dialog ──
  server.registerTool("handle_dialog", {
    title: "Handle JavaScript Dialog",
    description: "Set how to handle the next JavaScript dialog (alert, confirm, prompt). Call BEFORE the action that triggers the dialog. For prompts, provide the text to enter.",
    inputSchema: {
      action: z.enum(["accept", "dismiss"]).describe("Accept or dismiss the dialog"),
      promptText: z.string().optional().describe("Text to enter for prompt() dialogs"),
      _browserToken: z.string().optional().describe("Browser session token"),
    },
    annotations: { title: "Handle Dialog", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ action, promptText, _browserToken }) => {
    let b, token;
    if (getBrowserByToken) { const r = await getBrowserByToken(_browserToken); b = r.browser; token = r.token; }
    else { b = await getBrowser(); }
    const page = await b.getPage();

    // Set up a one-time dialog handler
    const dialogPromise = new Promise<{ type: string; message: string }>((resolve) => {
      page.once("dialog", async (dialog) => {
        const info = { type: dialog.type(), message: dialog.message() };
        if (action === "accept") {
          await dialog.accept(promptText);
        } else {
          await dialog.dismiss();
        }
        resolve(info);
      });
    });

    // Wait briefly for the dialog (it may already be pending)
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000));
    const result = await Promise.race([dialogPromise, timeout]);

    if (result) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ handled: true, dialogType: result.type, message: result.message, action, _browserToken: token }, null, 2) }] };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify({ handled: false, message: "No dialog appeared within 5 seconds. Call this BEFORE the action that triggers the dialog.", _browserToken: token }, null, 2) }] };
  });

  // ── upload_file ──
  server.registerTool("upload_file", {
    title: "Upload File",
    description: "Upload file(s) to a file input element. Works with <input type='file'> elements.",
    inputSchema: {
      selector: z.string().describe("CSS selector for the file input element"),
      filePaths: z.array(z.string()).describe("Array of absolute file paths to upload"),
      _browserToken: z.string().optional().describe("Browser session token"),
    },
    annotations: { title: "Upload File", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ selector, filePaths, _browserToken }) => {
    let b, token;
    if (getBrowserByToken) { const r = await getBrowserByToken(_browserToken); b = r.browser; token = r.token; }
    else { b = await getBrowser(); }
    const page = await b.getPage();
    await page.locator(selector).setInputFiles(filePaths);
    return { content: [{ type: "text" as const, text: JSON.stringify({ uploaded: filePaths, selector, _browserToken: token }, null, 2) }] };
  });

  // ── drag ──
  server.registerTool("drag", {
    title: "Drag and Drop",
    description: "Drag an element to a target location. Simulates mouse press, move, and release.",
    inputSchema: {
      source: z.string().describe("CSS selector for the element to drag"),
      target: z.string().describe("CSS selector for the drop target"),
      _browserToken: z.string().optional().describe("Browser session token"),
    },
    annotations: { title: "Drag and Drop", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ source, target, _browserToken }) => {
    let b, token;
    if (getBrowserByToken) { const r = await getBrowserByToken(_browserToken); b = r.browser; token = r.token; }
    else { b = await getBrowser(); }
    const page = await b.getPage();
    await page.dragAndDrop(source, target);
    return { content: [{ type: "text" as const, text: JSON.stringify({ dragged: source, droppedOn: target, _browserToken: token }, null, 2) }] };
  });
}
