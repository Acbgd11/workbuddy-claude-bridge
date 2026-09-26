import type { Config } from "./config.ts";
import type { Credential } from "./accounts.ts";

export type UpstreamResult =
  | { ok: true; response: Response }
  | { ok: false; status: number; message: string };

export function chatHeaders(cred: Credential, token: string): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "text/event-stream",
    "user-agent": "WorkBuddy",
    "x-user-id": cred.uid,
  };
  if (cred.enterpriseId) {
    headers["x-enterprise-id"] = cred.enterpriseId;
    headers["x-tenant-id"] = cred.enterpriseId;
  }
  if (cred.domain) headers["x-domain"] = cred.domain;
  return headers;
}

export function chatUrl(cfg: Config): string {
  return cfg.upstream.baseUrl.replace(/\/+$/, "") + cfg.upstream.chatPath;
}

export async function forwardChat(
  cfg: Config,
  cred: Credential,
  token: string,
  body: Record<string, unknown>,
  clientSignal?: AbortSignal,
): Promise<UpstreamResult> {
  const timeout = AbortSignal.timeout(cfg.upstream.timeoutMs);
  const signal = clientSignal ? AbortSignal.any([clientSignal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(chatUrl(cfg), {
      method: "POST",
      headers: chatHeaders(cred, token),
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    return { ok: false, status: 0, message: `上游连接失败: ${String(error)}` };
  }

  if (response.ok) return { ok: true, response };

  const text = await response.text().catch(() => "");
  return {
    ok: false,
    status: response.status,
    message: text.slice(0, 500) || `上游返回 HTTP ${response.status}`,
  };
}