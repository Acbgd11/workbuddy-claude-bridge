import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));

export const ROOT = resolve(here, "..");
export const DATA_DIR = join(ROOT, "data");
export const CONFIG_PATH = join(ROOT, "config.json");

export type ModelsConfig = {
  default: string;
  map: Record<string, string>;
  fallbackOrder: string[];
};

export type UpstreamConfig = {
  baseUrl: string;
  chatPath: string;
  refreshPath: string;
  timeoutMs: number;
};

export type AccountsConfig = {
  dirs: string[];
  extraFiles: string[];
};

export type Config = {
  port: number;
  host: string;
  models: ModelsConfig;
  upstream: UpstreamConfig;
  accounts: AccountsConfig;
  modelFallback: boolean;
  keepAliveMs: number;
  minMaxTokens: number;
};

/** 展开 %APPDATA% 这类 Windows 环境变量，以及开头的 ~ */
export function expandEnv(input: string): string {
  let out = input;
  const tilde = out.match(/^~(?=[\\/]|$)/);
  if (tilde && process.env.USERPROFILE) {
    out = process.env.USERPROFILE + out.slice(1);
  }
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, name: string) => {
    const v = process.env[name] ?? process.env[name.toUpperCase()];
    return v ?? whole;
  });
  return out;
}

const DEFAULTS: Config = {
  port: 8789,
  host: "127.0.0.1",
  models: {
    default: "glm-5.3-flash",
    map: {
      "claude-opus": "glm-5.3-flash",
      "claude-sonnet": "glm-5.3-flash",
      "claude-haiku": "deepseek-v4.1-flash",
    },
    fallbackOrder: ["glm-5.3-flash", "deepseek-v4.1-flash", "hy3"],
  },
  upstream: {
    baseUrl: "https://copilot.tencent.com",
    chatPath: "/v2/chat/completions",
    refreshPath: "/v2/plugin/auth/token/refresh",
    timeoutMs: 300_000,
  },
  accounts: {
    dirs: [
      "%APPDATA%/CodeBuddyExtension/Data/Public/auth",
      "%LOCALAPPDATA%/CodeBuddyExtension/Data/Public/auth",
    ],
    extraFiles: [],
  },
  modelFallback: true,
  keepAliveMs: 15_000,
  minMaxTokens: 8192,
};

function pick<T>(value: T | undefined, fallback: T): T {
  return value === undefined || value === null ? fallback : value;
}

export function loadConfig(): Config {
  let raw: Partial<Config> = {};
  if (existsSync(CONFIG_PATH)) {
    raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8").replace(/^﻿/, "")) as Partial<Config>;
  }

  const models = raw.models ?? ({} as Partial<ModelsConfig>);
  const upstream = raw.upstream ?? ({} as Partial<UpstreamConfig>);
  const accounts = raw.accounts ?? ({} as Partial<AccountsConfig>);

  return {
    port: pick(raw.port, DEFAULTS.port),
    host: pick(raw.host, DEFAULTS.host),
    models: {
      default: pick(models.default, DEFAULTS.models.default),
      map: pick(models.map, DEFAULTS.models.map),
      fallbackOrder: pick(models.fallbackOrder, DEFAULTS.models.fallbackOrder),
    },
    upstream: {
      baseUrl: pick(upstream.baseUrl, DEFAULTS.upstream.baseUrl),
      chatPath: pick(upstream.chatPath, DEFAULTS.upstream.chatPath),
      refreshPath: pick(upstream.refreshPath, DEFAULTS.upstream.refreshPath),
      timeoutMs: pick(upstream.timeoutMs, DEFAULTS.upstream.timeoutMs),
    },
    accounts: {
      dirs: pick(accounts.dirs, DEFAULTS.accounts.dirs).map(expandEnv),
      extraFiles: pick(accounts.extraFiles, DEFAULTS.accounts.extraFiles).map(expandEnv),
    },
    modelFallback: pick(raw.modelFallback, DEFAULTS.modelFallback),
    keepAliveMs: pick(raw.keepAliveMs, DEFAULTS.keepAliveMs),
    minMaxTokens: pick(raw.minMaxTokens, DEFAULTS.minMaxTokens),
  };
}

const API_KEY_PATH = () => join(DATA_DIR, "api-key.txt");

/** 首次运行自动生成网关密钥；同时接受 Authorization: Bearer 与 x-api-key */
export function ensureApiKey(): string {
  mkdirSync(DATA_DIR, { recursive: true });
  const p = API_KEY_PATH();
  if (existsSync(p)) {
    const existing = readFileSync(p, "utf8").trim();
    if (existing) return existing;
  }
  const key = "sk-wb-" + randomBytes(24).toString("hex");
  writeFileSync(p, key + "\n", "utf8");
  return key;
}