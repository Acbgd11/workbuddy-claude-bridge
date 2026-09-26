import { randomBytes } from "node:crypto";

export type AnthropicEvent = { event: string; data: Record<string, unknown> };

type ToolCallDelta = { index?: number; id?: string; function?: { name?: string; arguments?: string } };

export type UpstreamChunk = {
  id?: string;
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  choices?: {
    delta?: { content?: string | null; tool_calls?: ToolCallDelta[] };
    finish_reason?: string | null;
  }[];
};

/** 把上游 SSE 文本切成一条条 data 载荷，兼容 \n\n 与 \r\n\r\n 两种分隔。 */
export function createSseDecoder() {
  let buffer = "";
  return function feed(chunk: string): string[] {
    buffer = (buffer + chunk).replace(/\r\n/g, "\n");
    const out: string[] = [];
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data:")) out.push(trimmed.slice(5).trim());
      }
    }
    return out;
  };
}

export function formatSseEvent(event: AnthropicEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

function mapStopReason(reason: string | null | undefined): string {
  switch (reason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    default:
      return "end_turn";
  }
}

type PendingTool = { id: string | null; name: string | null; args: string; blockIndex: number | null };

/**
 * 把 OpenAI 的 chat.completion.chunk 流翻译成 Anthropic 的事件序列。
 * 上游会把文本和 tool_calls 混在同一个 delta 里，而 Anthropic 要求块与块之间
 * 必须先 stop 再 start，所以这里是有状态的。
 */
export class AnthropicStreamTranslator {
  messageId: string;
  model: string;
  inputTokens: number;
  started = false;
  nextIndex = 0;
  openIndex: number | null = null;
  openType: "text" | "tool_use" | null = null;
  pending: Map<number, PendingTool> = new Map();
  stopReason: string | null = null;
  outputTokens = 0;
  reportedInputTokens: number | null = null;

  constructor(model: string, inputTokens = 0) {
    this.messageId = "msg_" + randomBytes(12).toString("hex");
    this.model = model;
    this.inputTokens = inputTokens;
  }

  ensureStarted(out: AnthropicEvent[]): void {
    if (this.started) return;
    this.started = true;
    out.push({
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: this.messageId,
          type: "message",
          role: "assistant",
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: this.inputTokens, output_tokens: 0 },
        },
      },
    });
  }

  closeBlock(out: AnthropicEvent[]): void {
    if (this.openIndex === null) return;
    out.push({ event: "content_block_stop", data: { type: "content_block_stop", index: this.openIndex } });
    this.openIndex = null;
    this.openType = null;
  }

  openBlock(out: AnthropicEvent[], block: Record<string, unknown>): number {
    const index = this.nextIndex++;
    this.openIndex = index;
    this.openType = block.type as "text" | "tool_use";
    out.push({ event: "content_block_start", data: { type: "content_block_start", index, content_block: block } });
    return index;
  }

  pushText(out: AnthropicEvent[], text: string): void {
    if (this.openType !== "text") {
      this.closeBlock(out);
      this.openBlock(out, { type: "text", text: "" });
    }
    out.push({
      event: "content_block_delta",
      data: { type: "content_block_delta", index: this.openIndex, delta: { type: "text_delta", text } },
    });
  }

  openToolBlock(out: AnthropicEvent[], entry: PendingTool): void {
    this.closeBlock(out);
    const index = this.nextIndex;
    entry.blockIndex = this.openBlock(out, {
      type: "tool_use",
      id: entry.id ?? `toolu_${index}`,
      name: entry.name ?? "",
      input: {},
    });
    if (entry.args) {
      out.push({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: entry.blockIndex,
          delta: { type: "input_json_delta", partial_json: entry.args },
        },
      });
      entry.args = "";
    }
  }

  pushToolDelta(out: AnthropicEvent[], call: ToolCallDelta): void {
    const key = call.index ?? 0;
    let entry = this.pending.get(key);
    if (!entry) {
      entry = { id: null, name: null, args: "", blockIndex: null };
      this.pending.set(key, entry);
    }
    if (call.id) entry.id = call.id;
    if (call.function?.name) entry.name = (entry.name ?? "") + call.function.name;

    const fragment = call.function?.arguments ?? "";

    if (entry.blockIndex === null) {
      // name 尚未到达时不能开块 —— Anthropic 的 content_block_start 必须带上 name
      entry.args += fragment;
      if (entry.name) this.openToolBlock(out, entry);
      return;
    }
    if (fragment) {
      out.push({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: entry.blockIndex,
          delta: { type: "input_json_delta", partial_json: fragment },
        },
      });
    }
  }

  push(chunk: UpstreamChunk): AnthropicEvent[] {
    const out: AnthropicEvent[] = [];

    if (typeof chunk.model === "string" && chunk.model) this.model = chunk.model;
    if (chunk.usage) {
      if (typeof chunk.usage.prompt_tokens === "number") this.reportedInputTokens = chunk.usage.prompt_tokens;
      if (typeof chunk.usage.completion_tokens === "number") this.outputTokens = chunk.usage.completion_tokens;
    }

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;
      if (delta) {
        const text = delta.content;
        if (typeof text === "string" && text.length > 0) {
          this.ensureStarted(out);
          this.pushText(out, text);
        }
        for (const call of delta.tool_calls ?? []) {
          this.ensureStarted(out);
          this.pushToolDelta(out, call);
        }
      }
      if (choice.finish_reason) this.stopReason = choice.finish_reason;
    }

    return out;
  }

  finish(): AnthropicEvent[] {
    const out: AnthropicEvent[] = [];
    this.ensureStarted(out);

    // 收尾时还没开块的 tool call：有 name 就补开，没 name 就丢弃
    // （无名的 tool_use 会让客户端的工具调度器直接报错，不如不发出）
    for (const entry of this.pending.values()) {
      if (entry.blockIndex === null && entry.name) this.openToolBlock(out, entry);
    }

    this.closeBlock(out);

    out.push({
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: mapStopReason(this.stopReason), stop_sequence: null },
        usage: {
          output_tokens: this.outputTokens,
          input_tokens: this.reportedInputTokens ?? this.inputTokens,
        },
      },
    });
    out.push({ event: "message_stop", data: { type: "message_stop" } });
    return out;
  }
}

/** 把事件序列折叠成一条非流式的 message 响应。 */
export function eventsToMessage(events: AnthropicEvent[]): Record<string, unknown> {
  let message: Record<string, unknown> = {};
  const blocks: (Record<string, unknown> | undefined)[] = [];
  const rawArgs: string[] = [];

  for (const event of events) {
    const data = event.data as Record<string, any>;
    if (event.event === "message_start") {
      message = { ...(data.message as Record<string, unknown>) };
    } else if (event.event === "content_block_start") {
      blocks[data.index as number] = { ...(data.content_block as Record<string, unknown>) };
    } else if (event.event === "content_block_delta") {
      const block = blocks[data.index as number];
      if (!block) continue;
      const delta = data.delta as Record<string, any>;
      if (delta.type === "text_delta") {
        block.text = String(block.text ?? "") + String(delta.text ?? "");
      } else if (delta.type === "input_json_delta") {
        const i = data.index as number;
        rawArgs[i] = (rawArgs[i] ?? "") + String(delta.partial_json ?? "");
      }
    } else if (event.event === "message_delta") {
      const delta = data.delta as Record<string, unknown>;
      message.stop_reason = delta.stop_reason ?? null;
      message.stop_sequence = delta.stop_sequence ?? null;
      message.usage = { ...(message.usage as object), ...(data.usage as object) };
    }
  }

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block || block.type !== "tool_use") continue;
    const json = rawArgs[i] ?? "";
    try {
      block.input = json ? JSON.parse(json) : {};
    } catch {
      block.input = {};
    }
  }

  message.content = blocks.filter(Boolean);
  if (!message.type) message.type = "message";
  if (!message.role) message.role = "assistant";
  return message;
}

/** 粗略 token 估算：中日韩字符按 ~0.75 字/token，其余按 ~4 字符/token。 */
export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  if (!text) return 0;
  let wide = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) > 0x2e80) wide++;
  }
  const narrow = text.length - wide;
  return Math.ceil(wide * 0.75 + narrow / 4);
}