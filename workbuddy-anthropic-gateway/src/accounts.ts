import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";

export type Credential = {
  uid: string;
  uin: string | null;
  nickname: string | null;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  refreshExpiresAt: number | null;
  lastRefreshTime: number | null;
  domain: string | null;
  enterpriseId: string | null;
  sourcePath: string;
};

export type SkippedFile = { path: string; reason: string };

function isEncrypted(v: unknown): boolean {
  if (typeof v === "string") return v.includes("wbEncrypted");
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return Object.keys(v as object).some((k) => k.toLowerCase().includes("encrypted"));
  }
  return false;
}

/** 令牌只接受裸字符串。加密包装一律判为不可用，不做任何猜测性解包。 */
function tokenString(v: unknown): string | null {
  if (isEncrypted(v)) return null;
  if (typeof v === "string") return v.trim() || null;
  return null;
}

/** 展示用字段可以宽松些：字符串、数字、或包了一层的对象。 */
function displayString(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const k of ["nickname", "name", "value", "text", "uid", "uin"]) {
      const inner = displayString(o[k]);
      if (inner) return inner;
    }
  }
  return null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function parseInfo(text: string, sourcePath: string): { credential: Credential | null; reason: string } {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text.replace(/^﻿/, "")) as Record<string, unknown>;
  } catch {
    return { credential: null, reason: "JSON 解析失败" };
  }

  const account = (json.account ?? {}) as Record<string, unknown>;
  const nestedAuth = json.auth as Record<string, unknown> | undefined;
  const auth = nestedAuth && Object.keys(nestedAuth).length > 0 ? nestedAuth : json;

  const accessToken = tokenString(auth.accessToken);
  if (!accessToken) {
    return { credential: null, reason: "accessToken 不可用（$wbEncrypted 加密包装或缺失）" };
  }

  const uid =
    displayString(account.uid) ?? displayString(auth.uid) ?? displayString(account.uin) ?? displayString(auth.uin);
  if (!uid) return { credential: null, reason: "缺少 uid" };

  const refreshExpiresAt = num(auth.refreshExpiresAt);
  if (refreshExpiresAt !== null && refreshExpiresAt < Date.now()) {
    return { credential: null, reason: "refreshToken 已过期" };
  }

  return {
    credential: {
      uid,
      uin: displayString(account.uin),
      nickname: displayString(account.nickname),
      accessToken,
      refreshToken: tokenString(auth.refreshToken),
      expiresAt: num(auth.expiresAt),
      refreshExpiresAt,
      lastRefreshTime: num(auth.lastRefreshTime),
      domain: displayString(auth.domain),
      enterpriseId: displayString(account.enterpriseId) ?? displayString(auth.enterpriseId),
      sourcePath,
    },
    reason: "",
  };
}

/** 越大越新鲜。用于同一 uid 多份凭据之间取舍。 */
function freshness(c: Credential): number {
  return c.lastRefreshTime ?? c.expiresAt ?? 0;
}

/** 有 refreshToken 的凭据更耐用，优先于单纯的新鲜度。 */
function score(c: Credential): number {
  return (c.refreshToken ? 1e15 : 0) + freshness(c);
}

const RESCAN_TTL_MS = 60_000;

export class AccountPool {
  cfg: Config;
  credentials: Credential[] = [];
  skipped: SkippedFile[] = [];
  /** 本进程内刷新出来的新令牌，键为 uid；重启后失效，靠重新扫描补上。 */
  refreshed: Map<string, string> = new Map();
  cursor = 0;
  scannedAt = 0;

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  scan(force = false): void {
    if (!force && Date.now() - this.scannedAt < RESCAN_TTL_MS) return;

    const byUid = new Map<string, Credential>();
    const skipped: SkippedFile[] = [];

    const files: string[] = [...this.cfg.accounts.extraFiles];
    for (const dir of this.cfg.accounts.dirs) {
      if (!existsSync(dir)) continue;
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".info")) continue;
        files.push(join(dir, name));
      }
    }

    for (const file of files) {
      if (!existsSync(file)) {
        skipped.push({ path: file, reason: "文件不存在" });
        continue;
      }
      let text: string;
      try {
        if (!statSync(file).isFile()) continue;
        text = readFileSync(file, "utf8");
      } catch (error) {
        skipped.push({ path: file, reason: `读取失败: ${String(error)}` });
        continue;
      }

      const { credential, reason } = parseInfo(text, file);
      if (!credential) {
        skipped.push({ path: file, reason });
        continue;
      }

      const existing = byUid.get(credential.uid);
      if (!existing || score(credential) > score(existing)) {
        byUid.set(credential.uid, credential);
      }
    }

    this.credentials = [...byUid.values()];
    this.skipped = skipped;
    this.scannedAt = Date.now();
  }

  tokenFor(cred: Credential): string {
    return this.refreshed.get(cred.uid) ?? cred.accessToken;
  }

  /** preferred 可以是 uid、uin 或备注名（大小写不敏感）；否则按顺序轮询。 */
  pick(preferred?: string | null): Credential | null {
    this.scan();
    const list = this.credentials;
    if (list.length === 0) return null;

    if (preferred) {
      const needle = preferred.trim().toLowerCase();
      const hit = list.find(
        (c) =>
          c.uid.toLowerCase() === needle ||
          (c.uin ?? "").toLowerCase() === needle ||
          (c.nickname ?? "").toLowerCase() === needle,
      );
      if (hit) return hit;
    }

    const chosen = list[this.cursor % list.length];
    this.cursor = (this.cursor + 1) % Math.max(list.length, 1);
    return chosen;
  }

  label(cred: Credential): string {
    return cred.nickname ?? cred.uin ?? cred.uid.slice(0, 8);
  }

  /** 刷新令牌。成功则记录到内存覆盖层并返回新凭据。 */
  async refresh(cred: Credential): Promise<Credential | null> {
    const refreshToken = cred.refreshToken;
    if (!refreshToken) return null;

    const base = this.cfg.upstream.baseUrl.replace(/\/+$/, "");
    const url = base + this.cfg.upstream.refreshPath;

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "x-refresh-token": refreshToken,
          "x-auth-refresh-source": "plugin",
          "user-agent": "WorkBuddy",
        },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return null;
    }
    if (!res.ok) return null;

    let body: Record<string, unknown>;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      return null;
    }

    const code = num(body.code);
    if (code !== null && code !== 0 && code !== 200) return null;

    const data = (body.data ?? body) as Record<string, unknown>;
    const next = tokenString(data.accessToken);
    if (!next) return null;

    this.refreshed.set(cred.uid, next);
    return {
      ...cred,
      accessToken: next,
      refreshToken: tokenString(data.refreshToken) ?? cred.refreshToken,
      expiresAt: num(data.expiresAt) ?? cred.expiresAt,
    };
  }
}