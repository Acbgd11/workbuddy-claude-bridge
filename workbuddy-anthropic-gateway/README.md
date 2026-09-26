# workbuddy-anthropic-gateway

把本机已登录的 **WorkBuddy** 账号，变成一条 **Anthropic Messages API**（`/v1/messages`）的本地端点，
供 **Claude Code** 经 **cc-switch** 接入。

只做这一件事：**转录协议**。没有 WebUI、没有签到、没有账号管理界面 —— 账号直接用你现有的 WorkBuddy 登录态。

- 零 npm 依赖，Node 原生跑 TypeScript（需 Node ≥ 22.18；更旧的 22.x 要加 --experimental-strip-types 标志）
- 只监听 `127.0.0.1`
- 上游：`https://copilot.tencent.com/v2/chat/completions`（WorkBuddy 客户端同款接口）

---

## 快速开始

**双击 `start.bat`** —— 会启动服务并自动打开一个中文网页。页面上写着：

- 现在通没通（一条从 WorkBuddy 到 Claude Code 的连接线）
- 账号读到了几个、哪些文件读不了及原因
- **要填进 cc-switch 的六项配置，每项都有复制按钮**，密钥默认打码
- 一个「测一下」按钮，按下去真的发一条消息，成功就说明整条链路通了

命令行等价做法是 `node src/server.ts`，然后浏览器打开 <http://127.0.0.1:8789>。
启动后终端也会打印可用账号、密钥和模型映射，例如：

```
地址    http://127.0.0.1:8789
密钥    sk-wb-…
账号    1 个可用
        ✓ <你的账号昵称> (<uid前8位>) ← …\workbuddy-pool-01.info
        ✗ …\workbuddy-desktop.info → accessToken 不可用（$wbEncrypted 加密包装或缺失）
```

`GET http://127.0.0.1:8789/healthz` 免鉴权，返回账号、被跳过的文件与当前模型配置 —— 排障先看它。

---

## 接入 Claude Code（在 cc-switch 里加一个 provider）

cc-switch 写的就是 `~/.claude/settings.json` 的 `env` 块，填这几项：

| 键 | 值 |
|---|---|
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:8789`（**不带 `/v1`**，cc-switch 会自己拼接并折叠重复的 `/v1`） |
| `ANTHROPIC_AUTH_TOKEN` | `data/api-key.txt` 里的密钥（走 `Authorization: Bearer`） |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `glm-5.3-flash` |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | `glm-5.3-flash` |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `deepseek-v4.1-flash` |
| `ANTHROPIC_MODEL` | `glm-5.3-flash` |

网关**同时接受** `Authorization: Bearer` 和 `x-api-key`，所以你想用 `ANTHROPIC_API_KEY` 也行。

> 三个 `ANTHROPIC_DEFAULT_*_MODEL` 必须填，否则 Claude Code 会发 `claude-sonnet-4-5` 这类真实
> Anthropic 模型名过来。网关有兜底映射（见下），但显式填更可控。

---

## 配置（`config.json`）

```json
{
  "port": 8789,
  "models": {
    "default": "glm-5.3-flash",
    "map": {
      "claude-opus":   "glm-5.3-flash",
      "claude-sonnet": "glm-5.3-flash",
      "claude-haiku":  "deepseek-v4.1-flash"
    },
    "fallbackOrder": ["glm-5.3-flash", "deepseek-v4.1-flash", "hy3"]
  },
  "minMaxTokens": 8192
}
```

**模型迭代时改这里就行，不用碰代码。**

- `models.map` —— 键做**最长前缀匹配**，所以 `claude-sonnet` 能接住 `claude-sonnet-4-5`。请求的模型名不在 map 里就原样透传。
- `models.fallbackOrder` —— 上游返回 `400/402/403/404/429` 时依次换下一个模型重试；其余错误（含 5xx、网络）直接放弃。响应头 `x-wb-model-used` 标明实际用的模型。
- `models.default` —— 兜底，也是 `claude-*` 请求的落点。
- `minMaxTokens` —— **上游模型会把预算花在内部推理上**（`delta.reasoning_content` 字段）。实测把 `max_tokens` 设成 100 时，推理直接吃光预算、返回**空正文**（`stop_reason: max_tokens`）。所以客户端给的额度低于此值时会自动抬高。设为 `0` 关闭。
- `keepAliveMs` —— 上游推理期间可能几十秒不出字，网关按此间隔发 Anthropic `ping` 事件保活。
- `modelFallback` —— 设 `false` 关闭模型回退，只试请求的那一个。

另外可调：`upstream.timeoutMs`（默认 300000）、`accounts.dirs` / `accounts.extraFiles`。

---

## 账号从哪来

网关扫描 `%APPDATA%` 和 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\*.info`，
即你已有的 WorkBuddy 登录态 —— **不需要重新登录，也不用改 xdpool 插件的任何流程**。

**只认明文令牌。** `accessToken` 必须是裸字符串；桌面端 5.6.0+ 会把令牌包成 `$wbEncrypted` 对象，
这类文件会被跳过并在启动日志里列出原因（不做任何猜测性解包 —— 猜错会拿到密文当令牌用）。

要产出可用的明文凭据，任选其一：

- 用 **xdpool 插件卡片里的「添加账号」**扫码登录 → 写出 `workbuddy-scan-<id>.info`
- 让 **workbuddy-switch** 同步一次 → 写出 `workbuddy-pool-*.info`（同步成功后就会生成这种明文凭据）

多账号按顺序轮询，可用请求头 `x-wb-account: <uid|uin|备注名>` 指定。

> `workbuddy-pool-*.info` 里**没有 refreshToken**，所以网关无法为它续期。
> 令牌失效时（401）会提示你重新登录；网关每 60 秒重扫一次目录，桌面端/switch 刷新后会自动跟上。

---

## 已验证行为

| 场景 | 结果 |
|---|---|
| 非流式 `/v1/messages` | ✅ 聚合成标准 message 对象 |
| 流式 `/v1/messages` | ✅ `message_start → content_block_start/delta/stop → message_delta → message_stop` |
| **工具调用** | ✅ `tool_use` 块 + `input_json_delta` 增量 + `stop_reason: "tool_use"` |
| 多模态图片 | ✅ `{type:"image",source:{...}}` → OpenAI `image_url` |
| 鉴权 | ✅ 缺密钥/错密钥均 401 |
| `/v1/messages/count_tokens` | ✅ 粗略估算（CJK 按 ~0.75 字/token，其余 ~4 字符/token） |
| `/v1/models` | ✅ 返回配置里的模型 |

工具的转换细节：Anthropic 的 `tools[].input_schema` 直接当 OpenAI 的 `function.parameters`；
`tool_choice` 的 `auto/any/{tool}` 映射为 `auto/required/{function}`，`none` 则整个丢掉 `tools`；
`tool_result` 拆成独立的 `role:"tool"` 消息并排在同条 user 文本之前，`is_error` 加 `Error:` 前缀
（OpenAI 没有对应字段，不加前缀模型会当成功结果用）。

---

## 已知特性与坑

- **延迟波动大。** 同一条请求实测 8 秒到 3 分钟以上都有，取决于模型当次愿意推理多久。
  我验证过 `reasoning_effort: "low"`，**没有帮助**（11.3s 对 8.0s，推理 token 反而 158 → 1023），
  所以没有把它做成开关。嫌慢就换 `models.default`（`hy3` 按上游说明实测免费且更快）。
- **推理内容被丢弃。** 上游的 `delta.reasoning_content` 不转成 Anthropic 的 `thinking` 块 ——
  真实的 thinking 块需要 `signature` 字段，伪造它会冒让 Claude Code 解析失败的风险。所以只取 `content`。
- **图片**：网关自身不做本地路径 → base64 转换，只做协议转换。Claude Code 发的是 base64 块，能直接用。
- **端口**：默认 8789，避开了 cc-switch 自己的代理（15721）和 codex 网关（53682）。
- **凭据不回写**：401 后刷新出的新令牌只存在内存里，不覆盖桌面 App 的文件；重启后靠重扫目录。

---

## 排障

先看 `http://127.0.0.1:8789/healthz`，它会列出每个凭据文件是被采用还是被跳过、以及原因。

| 现象 | 原因 |
|---|---|
| 启动日志显示 `0 个可用` | 所有 `.info` 都是 `$wbEncrypted`。用 xdpool 扫码加号，或让 switch 同步一次 |
| 返回 401 | 网关密钥不对（见 `data/api-key.txt`） |
| 返回 503 | 没有可用账号，看启动日志的跳过原因 |
| 空正文 + `stop_reason: max_tokens` | 推理吃光了预算。检查 `minMaxTokens` 是否被调成 0 或过低 |
| 返回 429 | 上游 402（积分耗尽）被映射过来的，或真的限流 |
| 卡住不动 | 模型在推理。网关每隔 `keepAliveMs` 发 `ping` 保活，等着就行 |

---

## 目录

```
src/config.ts     配置加载、密钥生成、%VAR% 展开
src/accounts.ts   *.info 扫描/解析/轮询、令牌刷新
src/anthropic.ts  Anthropic 请求 → OpenAI 请求
src/translate.ts  OpenAI SSE → Anthropic 事件（流式状态机 + 非流式聚合）
src/upstream.ts   转发到 copilot.tencent.com
src/server.ts     HTTP 服务、鉴权、路由、模型回退
src/page.ts       那个中文网页（单文件内嵌 HTML/CSS/JS，不依赖外网）
```

页面本身只用到两个接口：`GET /healthz` 取状态（免鉴权），`POST /api/test` 跑测试（免鉴权，
因为只监听回环地址 —— 能访问它就能读到 `data/api-key.txt`，没有额外的权限边界）。

---

## 免责

非官方工具，仅供本机自有账号的客户端适配。请遵守腾讯服务条款，因使用导致的账号风险自负。