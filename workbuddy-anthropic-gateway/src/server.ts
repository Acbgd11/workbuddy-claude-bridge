import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { watchFile } from "node:fs";
import { CONFIG_PATH } from "./config.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureApiKey, loadConfig } from "./config.ts";
import { AccountPool } from "./accounts.ts";
import { buildUpstreamBody, modelCandidates, type AnthropicRequest } from "./anthropic.ts";
import { forwardChat } from "./upstream.ts";
import { renderPage } from "./page.ts";
import {
  AnthropicStreamTranslator,
  createSseDecoder,
  estimateTokens,
  eventsToMessage,
  formatSseEvent,
  type AnthropicEvent,
  type UpstreamChunk,
} from "./translate.ts";

const cfg = loadConfig();
const apiKey = ensureApiKey();
const pool = new AccountPool(cfg);

/** 上游官方模型目录(5 分钟缓存),供 /v1/models 动态发现 */
const CATALOG_TTL = 5 * 60_000;
let catalogCache: { models: { id: string; name: string; credits?: string; descriptionZh?: string; maxInputTokens?: number }[]; at: number } | null = null;
async function upstreamCatalog(): Promise<{ models: { id: string; name: string; credits?: string; descriptionZh?: string; maxInputTokens?: number }[] }> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL) return catalogCache;
  const cred = pool.credentials[0];
  if (!cred) return catalogCache ?? { models: [] };
  try {
    const res = await fetch(cfg.upstream.baseUrl.replace(/\/+$/, "") + "/v2/enterprises/personal/models", {
      headers: {
        authorization: `Bearer ${pool.tokenFor(cred)}`,
        "user-agent": "WorkBuddy",
        "x-user-id": cred.uid,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as {
      data?: {
        models?: {
          id?: string;
          name?: string;
          credits?: string;
          descriptionZh?: string;
          maxInputTokens?: number;
          tags?: string[];
        }[];
      };
    };
    const models = (json.data?.models ?? [])
      .filter(
        (m) =>
          m.id &&
          m.id !== "hunyuan-image-alpha" &&
          m.id !== "default" &&
          !(m.tags ?? []).some((t) => t === "text-to-image"),
      )
      .map((m) => ({ id: m.id as string, name: m.name ?? (m.id as string), credits: m.credits, descriptionZh: m.descriptionZh, maxInputTokens: m.maxInputTokens }));
    if (models.length) catalogCache = { models, at: Date.now() };
  } catch {
    // 拉取失败沿用旧缓存
  }
  return catalogCache ?? { models: [] };
}

/**
 * 上游模型 id → 桌面端合规假名(claude-<slug>-<n>,匹配 ^claude-[a-z]+-\d+$)。
 * slug 取上游 id 的字母数字压缩;固定序号保证同一模型映射稳定。
 * 桌面端发给网关假名,网关再反查回真实 id 转发上游。
 */
const DISCOVERY_RE = /^claude-[a-z]+-\d+(?:-\d+)?$/;
function aliasFor(upstreamId: string, seq: number): string {
  // 假名必须稳定:同一真实模型 id,无论上游目录顺序怎么变、第几次发现,假名都一样。
  // 否则桌面端缓存的旧假名会失效,报 invalid_request_error(模型名路由不到)。
  // 用 id 的字符码和做序号(10-98),同 id 恒同号。
  // 用 SHA-1 前 4 字节做序号(纯函数,与调用顺序无关,重启不变)
  let h = 0; for (const ch of upstreamId) h = (h * 31 + ch.charCodeAt(0)) >>> 0; const num = (h % 9890) + 10;
  return `claude-haiku-${num}`;
}
const aliasToReal = new Map<string, string>();
const realToAlias = new Map<string, string>();

async function ensureAliases(): Promise<void> {
  const { models } = await upstreamCatalog();
  for (let i = 0; i < models.length; i++) {
    const alias = aliasFor(models[i].id, i + 1);
    aliasToReal.set(alias, models[i].id);
    realToAlias.set(models[i].id, alias);
  }
}

/** 配置热重载:改 config.json 保存即生效,无需重启(监听不依赖 cfg,永不过期) */
let reloadTimer: NodeJS.Timeout | null = null;
watchFile(CONFIG_PATH, { interval: 1000 }, () => {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    try {
      const next = loadConfig();
      Object.assign(cfg, next);
      log("配置已热重载: 模型映射 = " + JSON.stringify(next.models.map));
    } catch (error) {
      log("配置重载失败(保留旧配置): " + String(error));
    }
  }, 300);
});

/** 这些状态码说明「换个模型可能就好了」；其余（含 5xx、网络错误）直接放弃。 */
const FALLBACK_STATUSES = new Set([400, 402, 403, 404, 429]);
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** 诊断:WB_DUMP=1 时把请求落盘 data/dump;WB_DUMP=all 时连成功请求也存。 */
const DUMP = process.env.WB_DUMP ?? "";
const dumpDir = join(process.cwd(), "data", "dump");
let dumpSeq = 0;
function dumpPair(tag: string, anthropicBody: unknown, upstreamBody: unknown, upstreamModel?: string): void {
  if (!DUMP) return;
  try {
    mkdirSync(dumpDir, { recursive: true });
    const id = `${Date.now()}-${++dumpSeq}-${tag}`;
    writeFileSync(join(dumpDir, `${id}.anthropic.json`), JSON.stringify(anthropicBody, null, 2));
    writeFileSync(join(dumpDir, `${id}.upstream.json`), JSON.stringify(upstreamBody, null, 2));
    if (upstreamModel) writeFileSync(join(dumpDir, `${id}.meta.txt`), `model=${upstreamModel}\n`);
  } catch {
    // 落盘失败不影响主流程
  }
}

function log(...args: unknown[]): void {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function errorType(status: number): string {
  switch (status) {
    case 400:
      return "invalid_request_error";
    case 401:
      return "authentication_error";
    case 403:
      return "permission_error";
    case 404:
      return "not_found_error";
    case 429:
      return "rate_limit_error";
    case 529:
      return "overloaded_error";
    default:
      return "api_error";
  }
}

function clientStatus(status: number): number {
  if (status === 0) return 502;
  if (status === 402) return 429; // 积分耗尽，Anthropic 侧没有对应码
  if (status < 400 || status > 599) return 502;
  return status;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { type: "error", error: { type: errorType(status), message } });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("请求体超过 32MB 上限"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** 同时接受 Authorization: Bearer 与 x-api-key —— cc-switch 按 env 键名决定用哪个。 */
function extractKey(req: IncomingMessage): string | null {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, "").trim();
  }
  const header = req.headers["x-api-key"];
  if (typeof header === "string" && header.trim()) return header.trim();
  return null;
}

function describeSkipped(): string {
  if (pool.skipped.length === 0) return " 凭据目录里没有 .info 文件。";
  return (
    " 跳过的文件：" +
    pool.skipped.map((s) => `\n  - ${s.path} → ${s.reason}`).join("") +
    "\n提示：桌面端 5.6.0+ 会把令牌写成 $wbEncrypted 加密包装，读不了属正常。" +
    "用 xdpool 插件的「添加账号」扫码登录，或让 workbuddy-switch 同步一次，会生成明文的 workbuddy-pool-*.info。"
  );
}

async function serveSuccess(
  res: ServerResponse,
  upstream: Response,
  model: string,
  payload: AnthropicRequest,
  wantsStream: boolean,
): Promise<void> {
  const body = upstream.body;
  if (!body) {
    sendError(res, 502, "上游没有返回响应体");
    return;
  }

  const inputEstimate =
    estimateTokens(payload.messages) + estimateTokens(payload.system) + estimateTokens(payload.tools);
  const translator = new AnthropicStreamTranslator(model, inputEstimate);
  const decoder = createSseDecoder();
  const textDecoder = new TextDecoder();
  const reader = (body as ReadableStream<Uint8Array>).getReader();

  const pump = async (sink: (event: AnthropicEvent) => void): Promise<void> => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const data of decoder(textDecoder.decode(value, { stream: true }))) {
          if (data === "[DONE]") continue;
          let chunk: UpstreamChunk;
          try {
            chunk = JSON.parse(data) as UpstreamChunk;
          } catch {
            continue;
          }
          for (const event of translator.push(chunk)) sink(event);
        }
      }
      for (const event of translator.finish()) sink(event);
    } finally {
      try {
        await reader.cancel();
      } catch {
        // 上游已关闭
      }
    }
  };

  if (wantsStream) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-wb-model-used": model,
    });

    const keepAlive = setInterval(() => {
      if (!res.writableEnded) res.write('event: ping\ndata: {"type":"ping"}\n\n');
    }, cfg.keepAliveMs);

    try {
      await pump((event) => res.write(formatSseEvent(event)));
    } catch (error) {
      log("流式转发中断:", String(error));
    } finally {
      clearInterval(keepAlive);
      if (!res.writableEnded) res.end();
    }
    return;
  }

  const events: AnthropicEvent[] = [];
  try {
    await pump((event) => events.push(event));
  } catch (error) {
    sendError(res, 502, `读取上游流失败: ${String(error)}`);
    return;
  }

  try {
    res.setHeader("x-wb-model-used", model);
    sendJson(res, 200, eventsToMessage(events));
  } catch (error) {
    sendError(res, 500, `聚合响应失败: ${String(error)}`);
  }
}

async function handleMessages(req: IncomingMessage, res: ServerResponse, raw: string): Promise<void> {
  let payload: AnthropicRequest;
  try {
    payload = JSON.parse(raw) as AnthropicRequest;
  } catch {
    sendError(res, 400, "请求体不是合法 JSON");
    return;
  }
  if (!Array.isArray(payload.messages)) {
    sendError(res, 400, "缺少 messages 数组");
    return;
  }

  const requestedRaw = typeof payload.model === "string" && payload.model ? payload.model : cfg.models.default;
  // 桌面端动态发现发的假名(claude-xxx-n)→ 反查真实上游模型;1M 变体带 [1m] 后缀,先剥掉
  const requested = aliasToReal.get(requestedRaw.replace(/\[1m\]$/i, "")) ?? requestedRaw.replace(/\[1m\]$/i, "");
  // [临时排障] 记录 system 标记(只看是什么触发了 11128,排完删)
  try {
    const sys = payload.system;
    const sysText = typeof sys === 'string' ? sys : (Array.isArray(sys) ? sys.map(b => (b && b.text) || '').join('|') : '');
    if (/billing|cc_version|entrypoint|x-anthropic/i.test(sysText)) log(`   [标记] system 含: ${sysText.slice(0, 200)}`);
  } catch {}
  const wantsStream = payload.stream === true;
  if (requested !== requestedRaw) log(`   假名 ${requestedRaw} → ${requested}`);
  const preferredHeader = req.headers["x-wb-account"];
  const preferred = typeof preferredHeader === "string" ? preferredHeader : null;

  const cred = pool.pick(preferred);
  if (!cred) {
    sendError(res, 503, "本机没有可用的 WorkBuddy 账号。" + describeSkipped());
    return;
  }
  log(`→ ${wantsStream ? "流式" : "非流式"} model=${requested} account=${pool.label(cred)}`);

  const candidates = modelCandidates(requested, cfg);
  let lastStatus = 0;
  let lastMessage = "";
  let usedModel = candidates[0];

  for (const model of candidates) {
    usedModel = model;
    const body = buildUpstreamBody(payload, cfg, model);
    if (DUMP && (model === candidates[0] || DUMP === "all")) dumpPair("req", payload, body, model);

    const abort = new AbortController();
    const onClose = () => abort.abort();
    req.on("close", onClose);

    let result = await forwardChat(cfg, cred, pool.tokenFor(cred), body, abort.signal);
    let tokenExpired = false;

    if (!result.ok && result.status === 401) {
      tokenExpired = true;
      const refreshed = await pool.refresh(cred);
      if (refreshed) {
        log(`   ${pool.label(cred)} 令牌已刷新，重试`);
        result = await forwardChat(cfg, refreshed, pool.tokenFor(refreshed), body, abort.signal);
      }
    }

    req.off("close", onClose);

    if (result.ok) {
      await serveSuccess(res, result.response, model, payload, wantsStream);
      return;
    }

    lastStatus = result.status;
    lastMessage = result.message;

    if (tokenExpired && result.status === 401) {
      sendError(
        res,
        401,
        `账号「${pool.label(cred)}」登录态已失效且刷新失败。请在 WorkBuddy 桌面端重新登录，或用 xdpool 插件扫码添加账号。`,
      );
      return;
    }

    if (!cfg.modelFallback || !FALLBACK_STATUSES.has(result.status)) {
      log(`   ${model} 失败 HTTP ${result.status}，放弃`);
      sendError(res, clientStatus(result.status), lastMessage);
      return;
    }

    log(`   ${model} 不可用（HTTP ${result.status}），尝试下一个模型`);
  }

  sendError(res, clientStatus(lastStatus), `所有候选模型均不可用，最后一个错误：${lastMessage || "未知"}（最后尝试 ${usedModel}）`);
}

function friendlyReason(status: number, message: string): string {
  if (status === 0) return "连不上腾讯的服务器。检查一下网络，或者你是不是开着代理？";
  if (status === 401) return "账号的登录态过期了。去 WorkBuddy 桌面端重新登录一次，然后刷新这个页面。";
  if (status === 402) return "这个账号的积分用完了。换一个账号，或者等积分恢复。";
  if (status === 403) return "账号没有权限使用这个模型。";
  if (status === 404) return "上游说这个模型不存在。检查 config.json 里的模型名。";
  if (status === 429) return "上游在限流，等一会儿再点一次。";
  if (status >= 500) return `腾讯那边出错了（HTTP ${status}），等一会儿再试。`;
  return `上游返回 HTTP ${status}：${message.slice(0, 200)}`;
}

/** 页面上的「测一下」按钮。只监听回环地址，所以不再单独鉴权。 */
async function handleTest(res: ServerResponse): Promise<void> {
  const cred = pool.pick(null);
  if (!cred) {
    sendJson(res, 200, { ok: false, reason: "没有可用的 WorkBuddy 账号。" });
    return;
  }

  const payload: AnthropicRequest = {
    model: cfg.models.default,
    max_tokens: 300,
    messages: [{ role: "user", content: "用一句话打个招呼，证明你在正常工作。" }],
  };

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);

  try {
    for (const model of modelCandidates(payload.model, cfg)) {
      const result = await forwardChat(
        cfg,
        cred,
        pool.tokenFor(cred),
        buildUpstreamBody(payload, cfg, model),
        controller.signal,
      );

      if (!result.ok) {
        if (cfg.modelFallback && FALLBACK_STATUSES.has(result.status)) continue;
        sendJson(res, 200, { ok: false, reason: friendlyReason(result.status, result.message) });
        return;
      }

      const events: AnthropicEvent[] = [];
      const translator = new AnthropicStreamTranslator(model, 0);
      const decoder = createSseDecoder();
      const textDecoder = new TextDecoder();
      const reader = (result.response.body as ReadableStream<Uint8Array>).getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const data of decoder(textDecoder.decode(value, { stream: true }))) {
          if (data === "[DONE]") continue;
          try {
            for (const event of translator.push(JSON.parse(data) as UpstreamChunk)) events.push(event);
          } catch {
            // 分片不完整，跳过
          }
        }
      }
      for (const event of translator.finish()) events.push(event);

      const message = eventsToMessage(events) as {
        model?: string;
        content?: { type: string; text?: string }[];
      };
      const text = (message.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("")
        .trim();

      sendJson(res, 200, { ok: true, text, model: message.model ?? model, ms: Date.now() - started });
      return;
    }

    sendJson(res, 200, { ok: false, reason: "所有候选模型都没成功，检查 config.json 里的模型名对不对。" });
  } catch (error) {
    sendJson(res, 200, {
      ok: false,
      reason: controller.signal.aborted
        ? "等了两分钟还没回。这个模型这次想得太久了，可以再点一次，或者换个更快的模型。"
        : `测试出错：${String(error)}`,
    });
  } finally {
    clearTimeout(timer);
  }
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", `http://${cfg.host}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";

    try {
      if (method === "GET" && path === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(renderPage(cfg, apiKey));
        return;
      }

      if (method === "GET" && path === "/healthz") {
        pool.scan(true);
        sendJson(res, 200, {
          ok: true,
          endpoint: `http://${cfg.host}:${cfg.port}`,
          accounts: pool.credentials.map((c) => ({
            label: pool.label(c),
            uid: c.uid.slice(0, 8),
            hasRefreshToken: Boolean(c.refreshToken),
            expiresAt: c.expiresAt,
            source: c.sourcePath,
          })),
          skippedFiles: pool.skipped,
          models: cfg.models,
        });
        return;
      }

      if (method === "POST" && path === "/api/test") {
        await handleTest(res);
        return;
      }

      if (path.startsWith("/v1/")) {
        const provided = extractKey(req);
        if (provided !== apiKey) {
          sendError(res, 401, "API key 无效或缺失。密钥见 data/api-key.txt。");
          return;
        }
      }

      if (method === "POST" && path === "/v1/messages") {
        await handleMessages(req, res, await readBody(req));
        return;
      }

      if (method === "POST" && path === "/v1/messages/count_tokens") {
        let payload: AnthropicRequest;
        try {
          payload = JSON.parse(await readBody(req)) as AnthropicRequest;
        } catch {
          sendError(res, 400, "请求体不是合法 JSON");
          return;
        }
        const inputTokens =
          estimateTokens(payload.messages) + estimateTokens(payload.system) + estimateTokens(payload.tools);
        sendJson(res, 200, { input_tokens: inputTokens });
        return;
      }

      if (method === "GET" && path === "/v1/models") {
        await ensureAliases();
        const { models } = await upstreamCatalog();
        // 一级选择器只显示前 5 个(客户端 UI 固定),把最常用的排前面,其余进 More models
        const FEATURED = ["glm-5.3-flash", "deepseek-v4.1-flash", "kimi-k3-1", "glm-5.3", "hy3"];
        const ordered = [
          ...FEATURED.map((id) => models.find((m) => m.id === id)).filter(Boolean),
          ...models.filter((m) => !FEATURED.includes(m.id)),
        ] as typeof models;
        const rows = ordered.map((m, i) => {
          const alias = realToAlias.get(m.id) ?? m.id;
          const credit = m.credits ? m.credits.replace(/\s*credits?/i, "").trim() : "";
          // tier 与假名序号同源轮换(序号 i → tier i%5),与 aliasFor 的 seq 对齐
          const TIERS = ["opus", "sonnet", "haiku", "fable", "mythos"] as const;
          const tier = TIERS[(i + 1) % TIERS.length];
          // 上游表 maxInputTokens ≥ 1M 时声明 supports_1m,客户端才会生成 1M 上下文变体(默认按 200K)
          const supports1m = typeof m.maxInputTokens === "number" && m.maxInputTokens >= 1_000_000;
          return {
            type: "model",
            id: alias,
            display_name: m.id + (credit ? ` (${credit})` : ""),
            anthropic_family_tier: tier,
            ...(supports1m ? { supports_1m: true } : {}),
            created_at: new Date(0).toISOString(),
          };
        });
        log(`← /v1/models 发现请求: 返回 ${rows.length} 个模型 (catalog=${models.length})`);
        sendJson(res, 200, {
          data: rows.length ? rows : [{ type: "model", id: cfg.models.default, display_name: cfg.models.default, created_at: new Date(0).toISOString() }],
          has_more: false,
          first_id: rows[0]?.id ?? cfg.models.default,
          last_id: rows.at(-1)?.id ?? cfg.models.default,
        });
        return;
      }

      sendError(res, 404, `未知路由 ${method} ${path}`);
    } catch (error) {
      log("请求处理异常:", String(error));
      sendError(res, 500, `网关内部错误: ${String(error)}`);
    }
  })();
});

server.on("error", (error) => {
  log(`无法监听 ${cfg.host}:${cfg.port} —— ${String(error)}`);
  process.exit(1);
});

server.listen(cfg.port, cfg.host, () => {
  pool.scan(true);

  log("WorkBuddy → Anthropic 网关已启动");
  log(`  地址    http://${cfg.host}:${cfg.port}`);
  log(`  密钥    ${apiKey}`);
  log(`  密钥文件 data/api-key.txt`);
  log(`  模型    默认 ${cfg.models.default}，回退链 ${(cfg.models.fallbackOrder ?? []).join(" → ")}`);
  log(`  账号    ${pool.credentials.length} 个可用`);
  for (const cred of pool.credentials) {
    log(`          ✓ ${pool.label(cred)} (${cred.uid.slice(0, 8)}) ← ${cred.sourcePath}`);
  }
  for (const skip of pool.skipped) {
    log(`          ✗ ${skip.path} → ${skip.reason}`);
  }
  if (pool.credentials.length === 0) log(describeSkipped());
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log("正在退出");
    server.close(() => process.exit(0));
  });
}