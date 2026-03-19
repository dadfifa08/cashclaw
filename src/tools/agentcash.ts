import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, ToolResult } from "./types.js";
import { getConfigDir, type AgentCashAccessClass } from "../config.js";
import { readProtectedJson, writeProtectedJson } from "../security/secure_store.js";

const execFileAsync = promisify(execFile);

const FETCH_TIMEOUT = 60_000;
const BALANCE_TIMEOUT = 15_000;

interface AgentCashEndpointPolicy {
  prefix: string;
  priceUsd: number;
  accessClass: AgentCashAccessClass;
  label: string;
}

const ENDPOINT_POLICIES: AgentCashEndpointPolicy[] = [
  { prefix: "https://stableenrich.dev/exa/search", priceUsd: 0.01, accessClass: "research", label: "Exa search" },
  { prefix: "https://stableenrich.dev/exa/contents", priceUsd: 0.02, accessClass: "research", label: "Exa contents" },
  { prefix: "https://stableenrich.dev/firecrawl/scrape", priceUsd: 0.02, accessClass: "research", label: "Firecrawl scrape" },
  { prefix: "https://stableenrich.dev/firecrawl/search", priceUsd: 0.01, accessClass: "research", label: "Firecrawl search" },
  { prefix: "https://stableenrich.dev/grok/search", priceUsd: 0.02, accessClass: "social", label: "Grok search" },
  { prefix: "https://stableenrich.dev/apollo/people/search", priceUsd: 0.03, accessClass: "research", label: "Apollo people" },
  { prefix: "https://stableenrich.dev/apollo/organizations/search", priceUsd: 0.03, accessClass: "research", label: "Apollo organizations" },
  { prefix: "https://twit.sh/api/user", priceUsd: 0.005, accessClass: "social", label: "Twit user" },
  { prefix: "https://twit.sh/api/tweet", priceUsd: 0.005, accessClass: "social", label: "Twit tweet" },
  { prefix: "https://twit.sh/api/search", priceUsd: 0.01, accessClass: "social", label: "Twit search" },
  { prefix: "https://twit.sh/api/user/tweets", priceUsd: 0.01, accessClass: "social", label: "Twit user tweets" },
  { prefix: "https://stablestudio.dev/gpt-image", priceUsd: 0.05, accessClass: "media", label: "GPT image" },
  { prefix: "https://stablestudio.dev/flux", priceUsd: 0.03, accessClass: "media", label: "Flux image" },
  { prefix: "https://stableupload.dev/upload", priceUsd: 0.01, accessClass: "media", label: "Upload" },
  { prefix: "https://stableemail.dev/send", priceUsd: 0.01, accessClass: "outbound", label: "Email" },
];

function getSpendPath(): string {
  return path.join(getConfigDir(), "security", "agentcash-spend.json");
}

function loadSpendLedger(): Record<string, number> {
  return readProtectedJson<Record<string, number>>(getSpendPath(), {});
}

function storeSpend(taskId: string, amountUsd: number): void {
  const ledger = loadSpendLedger();
  ledger[taskId] = (ledger[taskId] ?? 0) + amountUsd;
  writeProtectedJson(getSpendPath(), ledger);
}

function getTaskSpend(taskId: string): number {
  return loadSpendLedger()[taskId] ?? 0;
}

function classifyEndpoint(url: string): AgentCashEndpointPolicy | null {
  return ENDPOINT_POLICIES.find((entry) => url.startsWith(entry.prefix)) ?? null;
}

async function runAgentCash<T>(args: string[], timeout: number): Promise<T> {
  try {
    const { stdout } = await execFileAsync("npx", ["agentcash", ...args], {
      timeout,
      env: { ...process.env },
    });
    return JSON.parse(stdout.trim()) as T;
  } catch (err) {
    if (err instanceof Error) {
      if ("code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("agentcash CLI not found. Install with: npm install -g agentcash");
      }
      throw new Error(`agentcash error: ${err.message}`);
    }
    throw err;
  }
}

export const agentcashFetch: Tool = {
  definition: {
    name: "agentcash_fetch",
    description:
      "Make a paid API call via AgentCash. Constructs a request to an external API endpoint " +
      "(web search, scraping, image gen, social data, email, etc). The URL, method, and body " +
      "should match the endpoint catalog in your instructions. Costs USDC per call.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "Full API endpoint URL (e.g. https://stableenrich.dev/exa/search)",
        },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "DELETE"],
          description: "HTTP method. Defaults to POST if body is provided, GET otherwise.",
        },
        body: {
          type: "object",
          description: "JSON request body for POST/PUT requests.",
        },
      },
      required: ["url"],
    },
  },
  async execute(input, ctx): Promise<ToolResult> {
    const url = input.url as string;
    if (!url) return { success: false, data: "Missing required field: url" };

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { success: false, data: `Invalid URL: ${url}` };
    }

    const endpoint = classifyEndpoint(parsed.toString());
    if (!endpoint) {
      return { success: false, data: `Blocked: endpoint ${parsed.origin}${parsed.pathname} is not in the approved catalog` };
    }

    const allowedClasses = ctx.config.security.agentCashPolicy.allowedClasses;
    if (!allowedClasses.includes(endpoint.accessClass)) {
      return { success: false, data: `Blocked: ${endpoint.accessClass} AgentCash calls are disabled by policy` };
    }

    if (endpoint.priceUsd > ctx.config.security.agentCashPolicy.maxUsdPerCall) {
      return { success: false, data: `Blocked: ${endpoint.label} exceeds the per-call cap of $${ctx.config.security.agentCashPolicy.maxUsdPerCall.toFixed(2)}` };
    }

    const spent = getTaskSpend(ctx.taskId);
    if (spent + endpoint.priceUsd > ctx.config.security.agentCashPolicy.maxUsdPerTask) {
      return { success: false, data: `Blocked: task spend cap exceeded ($${(spent + endpoint.priceUsd).toFixed(2)} > $${ctx.config.security.agentCashPolicy.maxUsdPerTask.toFixed(2)})` };
    }

    const method = input.method as string | undefined;
    const body = input.body as Record<string, unknown> | undefined;
    const args = ["fetch", parsed.toString()];
    if (method) {
      args.push("-m", method);
    }
    if (body) {
      args.push("-b", JSON.stringify(body));
    }
    args.push("--format", "json");

    try {
      const result = await runAgentCash<unknown>(args, FETCH_TIMEOUT);
      storeSpend(ctx.taskId, endpoint.priceUsd);
      ctx.recordAudit?.({
        category: "agentcash",
        action: "fetch",
        outcome: "success",
        message: `AgentCash request completed: ${endpoint.label}`,
        metadata: {
          taskId: ctx.taskId,
          url: parsed.toString(),
          priceUsd: endpoint.priceUsd,
          accessClass: endpoint.accessClass,
        },
      });
      return { success: true, data: JSON.stringify(result, null, 2) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, data: msg };
    }
  },
};

export interface AgentCashWalletInfo {
  address: string;
  balance: string;
  network: string;
}

export const agentcashBalance: Tool = {
  definition: {
    name: "agentcash_balance",
    description:
      "Check your AgentCash USDC balance. Use before making expensive API calls " +
      "to ensure sufficient funds.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  async execute(_input, _ctx): Promise<ToolResult> {
    try {
      const result = await runAgentCash<AgentCashWalletInfo>(
        ["wallet", "info", "--format", "json"],
        BALANCE_TIMEOUT,
      );
      return {
        success: true,
        data: JSON.stringify({
          address: result.address,
          balanceUSDC: result.balance,
          network: result.network,
        }),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, data: msg };
    }
  },
};
