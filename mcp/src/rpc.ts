/**
 * MCP protocol engine — stateless Streamable HTTP (one POST in, one JSON out).
 * Handles initialize / ping / tools/list / tools/call. Tool failures come back
 * as `isError` results rather than protocol errors, so the model can read the
 * reason and self-correct.
 */
import { TOOL_DEFS, callTool, hasTool, ToolError } from "./tools.js";

const PREFERRED_VERSION = "2025-06-18";
const SUPPORTED = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];

const INSTRUCTIONS =
  "Reconcile what Renato ate against what he paid. This connector links meals in DAP Fitness to " +
  "transactions and receipt lines in DAP Finance, and answers what any meal, day or meal type actually cost.\n\n" +
  "ALWAYS REPORT COVERAGE WITH COST. Coverage is the share of logged food actually traced to money. " +
  "A month total drawn from 45% coverage is not a total, and presenting it as one is the single worst " +
  "thing you can do with this data. Say '$412 traced so far, 61% of what he ate' — never just '$412'.\n\n" +
  "TWO MECHANISMS, DELIBERATELY DIFFERENT. Eating out is one meal to one charge — matched on date, " +
  "merchant and how uniquely the pair fit. Groceries are FIFO inventory: a receipt line becomes a cost " +
  "lot, and each meal draws grams from the oldest open lot of that food. If a meal looks uncosted, check " +
  "list_pantry_lots before assuming the data is missing — the food may simply not be resolved to a lot yet.\n\n" +
  "PROPOSE AND COMMIT ARE SEPARATE. list_proposed_links shows what the matcher believes and why. " +
  "confirm_cost_link is the only tool that finalizes one. Show him the proposal, the confidence and the " +
  "evidence, and get an explicit yes before confirming. Never batch-confirm a queue because the scores " +
  "look high.\n\n" +
  "REJECTING IS AS USEFUL AS CONFIRMING. A rejection is stored as a negative label; without it the " +
  "matcher re-proposes the same wrong pair forever. If he says a match is wrong, call reject_cost_link " +
  "rather than just moving on.\n\n" +
  "WHEN NOTHING MATCHES. Prefer link_transaction_to_meal when a real charge exists — it keeps the trail " +
  "back to the bank. set_manual_meal_cost is for cash and other people's cards only. Do not invent a " +
  "cost to make coverage look better; an honest gap is the point of the gap.\n\n" +
  "STALE DATA. This app mirrors both sources rather than reading them live. If the numbers look behind, " +
  "call sync_and_match — it pulls both sides and proposes new links, which still need reviewing.\n\n" +
  "ANYTHING ELSE. describe_schema then run_sql runs arbitrary read-only SELECTs over the whole reconciliation " +
  "ledger. Prefer one aggregate query over many small calls.";

function result(id: unknown, r: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result: r };
}
function error(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}
const isNotification = (m: Record<string, unknown>) => m && m.method != null && m.id === undefined;

export async function handleRpc(message: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  if (isNotification(message)) return null; // acknowledged (202), never answered
  const id = message.id ?? null;
  const method = typeof message.method === "string" ? message.method : "";
  if (!method) return error(id, -32600, "Missing method.");
  const params = (message.params && typeof message.params === "object" ? message.params : {}) as Record<
    string,
    unknown
  >;

  switch (method) {
    case "initialize": {
      const req = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const version = SUPPORTED.includes(req) ? req : PREFERRED_VERSION;
      return result(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "food-cost", title: "Food Cost", version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, { tools: TOOL_DEFS });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<
        string,
        unknown
      >;
      if (!name) return error(id, -32602, "Missing tool name.");
      if (!hasTool(name)) return error(id, -32602, `Unknown tool: ${name}`);
      try {
        const data = await callTool(name, args);
        return result(id, {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          structuredContent: data,
          isError: false,
        });
      } catch (e) {
        const msg = e instanceof ToolError ? e.message : "The tool failed unexpectedly (server-side).";
        if (!(e instanceof ToolError)) console.error(`[food-cost-mcp] tool ${name}:`, e);
        return result(id, { content: [{ type: "text", text: msg }], isError: true });
      }
    }
    default:
      return error(id, -32601, `Method not found: ${method}`);
  }
}
