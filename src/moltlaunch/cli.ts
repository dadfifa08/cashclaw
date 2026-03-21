import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Task, Bounty, WalletInfo, RegisterResult, AgentInfo } from "./types.js";

const MLTL_BIN = process.platform === "win32" ? "mltl.cmd" : "mltl";
const DEFAULT_TIMEOUT = 30_000;
const REGISTER_TIMEOUT = 120_000;
export const DEFAULT_REGISTER_SKILLS = [
  "engineering-diagnostics",
  "root-cause-analysis",
  "inspection-workflows",
  "preventive-maintenance",
  "sop-generation",
  "parts-tooling-crosswalk",
  "compliance-documentation",
] as const;
interface CliError {
  error: string;
  code?: string;
}

interface WindowsLaunchSpec {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

function quoteWindowsArg(arg: string): string {
  const escaped = arg
    .replace(/%/g, "%%")
    .replace(/(\*)"/g, "$1$1\"")
    .replace(/(\+)$/g, "$1$1");

  return `"${escaped}"`;
}

function prependWindowsPath(env: NodeJS.ProcessEnv, entry: string): void {
  for (const key of ["Path", "PATH"] as const) {
    const current = env[key];
    if (!current) {
      env[key] = entry;
      continue;
    }
    const parts = current.split(";").filter(Boolean);
    if (!parts.some((part) => part.toLowerCase() === entry.toLowerCase())) {
      env[key] = `${entry};${current}`;
    }
  }
}

function resolveWindowsCommand(command: string, env: NodeJS.ProcessEnv): string {
  const npmBinCandidates = [
    env.APPDATA ? path.join(env.APPDATA, "npm") : undefined,
    env.USERPROFILE ? path.join(env.USERPROFILE, "AppData", "Roaming", "npm") : undefined,
  ].filter((value): value is string => Boolean(value));

  for (const npmBin of npmBinCandidates) {
    if (!fs.existsSync(npmBin)) continue;
    prependWindowsPath(env, npmBin);
    const absoluteCommand = path.join(npmBin, command);
    if (fs.existsSync(absoluteCommand)) {
      return absoluteCommand;
    }
  }

  return command;
}

function buildWindowsCommand(command: string, args: string[]): string {
  const quotedArgs = args.map(quoteWindowsArg).join(" ");
  if (/[\\/: ]/.test(command)) {
    return `""${command}"${quotedArgs ? ` ${quotedArgs}` : ""}"`;
  }
  return `${command}${quotedArgs ? ` ${quotedArgs}` : ""}`;
}

function resolveWindowsLaunch(args: string[], env: NodeJS.ProcessEnv): WindowsLaunchSpec {
  const npmBinCandidates = [
    env.APPDATA ? path.join(env.APPDATA, "npm") : undefined,
    env.USERPROFILE ? path.join(env.USERPROFILE, "AppData", "Roaming", "npm") : undefined,
  ].filter((value): value is string => Boolean(value));

  for (const npmBin of npmBinCandidates) {
    if (!fs.existsSync(npmBin)) continue;
    prependWindowsPath(env, npmBin);
    const cliEntry = path.join(npmBin, "node_modules", "moltlaunch", "dist", "index.js");
    if (fs.existsSync(cliEntry)) {
      return {
        command: process.execPath,
        args: [cliEntry, ...args],
      };
    }
  }

  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `${buildWindowsCommand(resolveWindowsCommand(MLTL_BIN, env), args)}`],
    windowsVerbatimArguments: true,
  };
}

function extractCliError(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as CliError | Record<string, unknown>;
    if (parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string") {
      return parsed.error;
    }
  } catch {
    // fall through to raw stderr/stdout text
  }

  return trimmed;
}

function runCommand(args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    const child = process.platform === "win32"
      ? (() => {
          const launch = resolveWindowsLaunch(args, env);
          return spawn(launch.command, launch.args, {
            env,
            windowsHide: true,
            windowsVerbatimArguments: launch.windowsVerbatimArguments,
          });
        })()
      : spawn(MLTL_BIN, args, { env });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      reject(new Error(`mltl command timed out after ${timeout}ms`));
    }, timeout);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code === 0) {
        resolve(stdout);
        return;
      }

      const stderrMessage = extractCliError(stderr);
      const stdoutMessage = extractCliError(stdout);
      if (process.platform === "win32" && (stderrMessage ?? "").includes("is not recognized")) {
        reject(new Error("mltl CLI not found. Install it with: npm install -g moltlaunch"));
        return;
      }

      reject(new Error(stderrMessage ?? stdoutMessage ?? `mltl exited with code ${code ?? "unknown"}`));
    });
  });
}
async function mltl<T>(
  args: string[],
  timeout = DEFAULT_TIMEOUT,
): Promise<T> {
  try {
    const stdout = await runCommand([...args, "--json"], timeout);
    const parsed = JSON.parse(stdout.trim()) as T | CliError;

    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "error" in parsed &&
      typeof (parsed as CliError).error === "string"
    ) {
      throw new Error((parsed as CliError).error);
    }

    return parsed as T;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("mltl")) {
      throw err;
    }
    if (err instanceof Error) {
      if ("code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          "mltl CLI not found. Install it with: npm install -g moltlaunch",
        );
      }
      throw new Error(`mltl error: ${err.message}`);
    }
    throw err;
  }
}

export async function walletShow(): Promise<WalletInfo> {
  return mltl<WalletInfo>(["wallet", "show"]);
}

export async function walletImport(key: string): Promise<WalletInfo> {
  return mltl<WalletInfo>(["wallet", "import", "--key", key]);
}

export interface RegisterOpts {
  name: string;
  description: string;
  skills?: string[];
  price: string;
  symbol?: string;
  token?: string;
  image?: string;
  website?: string;
}

export function normalizeRegisterSkills(skills: string[] | undefined): string[] {
  const normalized = (skills ?? [])
    .map((skill) => skill.trim().toLowerCase())
    .map((skill) => skill.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter(Boolean);

  if (normalized.length === 0) {
    return [...DEFAULT_REGISTER_SKILLS];
  }

  return [...new Set(normalized)];
}

export async function registerAgent(opts: RegisterOpts): Promise<RegisterResult> {
  const skills = normalizeRegisterSkills(opts.skills);
  const args = [
    "register",
    "--name", opts.name,
    "--description", opts.description,
    "--skills", skills.join(","),
    "--price", opts.price,
  ];
  if (opts.symbol) {
    args.push("--symbol", opts.symbol);
  }
  if (opts.token) {
    args.push("--token", opts.token);
  }
  if (opts.image) {
    args.push("--image", opts.image);
  }
  if (opts.website) {
    args.push("--website", opts.website);
  }
  return mltl<RegisterResult>(args, REGISTER_TIMEOUT);
}

export async function getAgentByWallet(address: string): Promise<AgentInfo | null> {
  try {
    const res = await fetch(
      `https://api.moltlaunch.com/api/agents/by-wallet/${address}`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { agents: Record<string, unknown>[] };
    const raw = data.agents[0];
    if (!raw) return null;
    return {
      agentId: String(raw.id ?? raw.agentId ?? ""),
      name: String(raw.name ?? ""),
      description: String(raw.description ?? ""),
      skills: Array.isArray(raw.skills) ? raw.skills as string[] : [],
      priceEth: String(raw.priceWei ?? raw.priceEth ?? "0"),
      owner: String(raw.owner ?? ""),
      flaunchToken: raw.flaunchToken ? String(raw.flaunchToken) : undefined,
      reputation: typeof raw.reputation === "object" && raw.reputation !== null
        ? (raw.reputation as { count?: number }).count
        : undefined,
    };
  } catch {
    return null;
  }
}

export async function getInbox(agentId?: string): Promise<Task[]> {
  const args = ["inbox"];
  if (agentId) args.push("--agent", agentId);
  const result = await mltl<{ tasks: Task[] }>(args);
  return result.tasks;
}

export async function getTask(taskId: string): Promise<Task> {
  const result = await mltl<{ task: Task }>(["view", "--task", taskId]);
  return result.task;
}

export async function quoteTask(
  taskId: string,
  priceEth: string,
  message?: string,
): Promise<void> {
  const args = ["quote", "--task", taskId, "--price", priceEth];
  if (message) args.push("--message", message);
  await mltl<unknown>(args);
}

export async function declineTask(
  taskId: string,
  reason?: string,
): Promise<void> {
  const args = ["decline", "--task", taskId];
  if (reason) args.push("--reason", reason);
  await mltl<unknown>(args);
}

export async function submitWork(
  taskId: string,
  result: string,
): Promise<void> {
  await mltl<unknown>(["submit", "--task", taskId, "--result", result]);
}

export async function sendMessage(
  taskId: string,
  content: string,
): Promise<void> {
  await mltl<unknown>(["message", "--task", taskId, "--content", content]);
}

export async function getBounties(): Promise<Bounty[]> {
  const result = await mltl<{ bounties: Bounty[] }>(["bounty", "browse"]);
  return result.bounties;
}

export async function claimBounty(
  taskId: string,
  message?: string,
): Promise<void> {
  const args = ["bounty", "claim", "--task", taskId];
  if (message) args.push("--message", message);
  await mltl<unknown>(args);
}

