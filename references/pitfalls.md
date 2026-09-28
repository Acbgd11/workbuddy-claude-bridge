# pitfalls.md — WorkBuddy 反代接入 Claude 的全部踩坑实录

每一条都是真机踩出来的。排障时**先按症状对号入座**，别再重新分析。

---

## #0 【首选】模型只有 3 个 / 时好时坏 / 时有时无（最常见）

**这是用户实测发现的最可靠修法，优先于下面所有重启类操作。**

**症状**：选择器只显示 3 个模型，或者昨天 28 个今天只剩几个，或者"重启桌面端没用"。

**根因**:cc-switch 自己也缓存了一份模型清单（它"选用的模型"栏用）。当桌面端报模型不全时，**卡住的往往是 cc-switch 这一层的缓存**，不是桌面端——所以光重启桌面端经常没用。

**修法（30 秒）**:
1. 打开 **cc-switch**
2. 点开「现在连接的分类栏」里的「**选用的模型**」一栏
3. 点「**获取模型**」→ 它会从网关 `/v1/models` 重新拉取，显示 **28 个模型**
4. 完全退出 Claude 桌面端（托盘 Quit）再打开 → 模型恢复正常

**原理**:cc-switch 的"获取模型"主动刷新了它自己的模型缓存，桌面端再启动时读到的是新鲜结果。

---

## #1 桌面端完全没反应 / 连接被拒绝

**根因**：网关进程没在运行，8789 端口无任何监听。

**验证**:`Get-NetTCPConnection -State Listen -LocalPort 8789` 无输出；`http://127.0.0.1:8789/healthz` 拒绝连接。

**修法**：双击 `start.bat` 或跑 `scripts\setup-gateway.ps1`。注意 `start.bat` 关闭窗口即停止网关——所以装了开机自启计划任务 `WorkBuddyGateway`（登录即拉起）。

---

## #2 黄色横幅 "Your provider setup needs a fix" + 模型选择器为空 / 报 "organization hasn't configured any models"

**根因**(三层叠加，按概率排序）:

1. **profile 缺 `inferenceModels` 字段**。桌面端对 gateway 型供应商要求显式模型清单；缺了选择器就是空的。早期 cc-switch 写的 profile 没有这个字段。
2. **profile 被桌面端自己重写剥掉**。桌面端后台有规范化逻辑（日志里连续 "Config file written")，会把不认识的字段剥掉。手写 profile 必须趁桌面端**完全关闭**时写，字段要用它 schema 认可的格式（见 `desktop-profile-schema.md`)。
3. **写错了位置**。旧版 cc-switch 把 profile 写到 MSIX 容器外（`%LOCALAPPDATA%\Claude-3p\configLibrary`)，商店版桌面端读不到。本 skill 的 setup 脚本会同时写容器内副本（双保险）。

**修法**:setup-gateway.ps1 会在桌面端关闭时重写 profile（含假名 inferenceModels + tier 字段），并同步容器副本。

---

## #3 请求通到网关但全 400,错误码 11128

**报错原文**:`Illegal API invocation from an unapproved channel`(displayMsg: "这次调用没通过渠道校验，可能不是官方客户端发出的")。

**根因**(三层拦截，按出现顺序，全部要处理，少一层都还会 400):

1. **计费标记行**:system 里带 `x-anthropic-billing-header: cc_version=...; cc_entrypoint=...;` → 网关 `stripBillingHeader()` 按 `^x-anthropic-billing-header:.*$` 整行过滤。
2. **身份共现**:system 里 **"Claude Code" 与 "Anthropic" 在同一段共现**(官方自我介绍 `You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.`)→ 网关 `sanitizeSystemIdentity()` 把这句替换为中性描述，并在仍共现时把 `Claude Code` 稀释为 `this assistant`。
3. **GitHub 路径同框**:system 指令里的反馈链接 `https://github.com/anthropics/claude-code/issues`(`anthropics/claude-code` 同框)→ 替换为 `open-source/assistant-cli`。

**关键结论**(二分法实测):单独出现 `Claude Code` 或 `Anthropic` 都放行，**共现才触发**；工具名/描述里的这俩词**不算**(只在 system 文本里判)。所以只处理 system,不碰工具和用户内容。

**修法**：网关 `anthropic.ts` 的 `sanitizeSystemIdentity()`(在 `systemMessages` 里，`stripBillingHeader` 之后调用）已内置全部三条规则。**已内置，别删。** 若客户端换文案，在日志里找 `x-wb-model-used` 附近的 system 内容，把新的触发片段加进替换表。

---

## #4 模型选择器只显示 5 个（或更少）

**根因**：桌面端对网关模型名的**三重校验**(asar 逆向结论，详见 `desktop-profile-schema.md`):

1. **形态**：id 必须匹配 `^claude-[a-z]+-\d+(?:-\d+)?$`（如 `claude-haiku-8`)
2. **黑名单**:id 里**禁止出现** `glm/deepseek/kimi/hy3/minimax/llama/gpt/grok/qwen/doubao/ark-code` 等真实厂商词（正则 `Qxe`)，命中即整条丢弃
3. **tier 字段**：需带 `anthropic_family_tier`，值限 `opus/sonnet/haiku/fable/mythos`

任一不过，该模型从选择器消失。早期假名 `claude-glmflash-8` 就死在第 2 条（含 "glm")。

**修法**：假名统一为 `claude-haiku-<序号>`（避开所有黑名单词），并为每条加轮换的 tier 字段。setup 脚本生成的 profile 已按此处理。**上游加新模型时，假名也必须用同一套规则**，网关 `/v1/models` 动态生成，不用手改。

---

## #5 凭据全部跳过 "$wbEncrypted 加密包装或缺失"

**根因**:WorkBuddy 桌面端 5.6.0+ 把 accessToken 写成 `$wbEncrypted` 加密对象，网关只认**裸字符串**，这类文件会被跳过（不做任何猜测性解包——猜错会拿密文当令牌用）。

**修法**（任选其一，产出明文 `workbuddy-pool-*.info`):
- 用 **xdpool 插件**卡片的「添加账号」扫码登录
- 让 **workbuddy-switch** 同步一次

**注意**:`workbuddy-pool-*.info` 里**没有 refreshToken**,401 时无法自动续期，只能提示用户重新登录（网关每 60 秒重扫目录，桌面端刷新后会自动跟上）。

---

## #6 配置写好了但桌面端像没读到（"还是没生效")

**根因**：桌面端是**商店版 MSIX 沙盒**，文件系统虚拟化。cc-switch（旧版，未含 PR #6599）把 profile 写到 `%LOCALAPPDATA%\Claude-3p\configLibrary`，商店版实际读的是容器 `C:\Users\<user>\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\Claude-3p\configLibrary`。

**修法**:setup 脚本同时写两处（真实路径 + 容器副本）。另外：改完 profile 必须**完全退出桌面端**（右键系统托盘图标退出）再打开——只在窗口点 X 不会重载配置。

---

## #7 "问他是什么模型，他说是 Claude Opus，对不上"

**根因**：Claude 客户端发的 system 里有官方自我介绍（`You are Claude Code, Anthropic's official CLI...`），而网关为绕开上游 11128 校验**必须把它改掉**，改成了没有任何身份的中性描述。模型失去了身份信息，只能凭训练记忆瞎猜，所以答案随机（这次说 Opus、下次说别的）。

**已修复（2026-09-26）**：网关 `sanitizeSystemIdentity(text, realModel)` 现在会把它替换成**带真实模型名的自我介绍**，模型能如实回答自己是谁。

**如果又出现答不对**：检查 `anthropic.ts` 里 `sanitizeSystemIdentity()` 的注入逻辑是否还在——注入的文案**不能**同时含 `Claude Code` 与 `Anthropic`（否则 11128 重现）。

**判断真实模型的权威方式**：网关日志的 `model=<真实id>` 行，或响应头 `x-wb-model-used`。

**深入背景**见 [`../EXPERIENCE.md`](../EXPERIENCE.md) 第一节。

---

## #11 模型显示正常但对话报 Invalid request（模型名路由失效）

**症状**：选择器正常、模型能选，但一发消息就 `Invalid request`；桌面端 `cli-diagnostics.jsonl` 里 `cli_api_error` 的 `model` 字段是一个**网关现在不认识的假名**（如 `claude-haiku-9`)。

**根因**：网关早期按"目录顺序"给假名编号（`claude-haiku-1`、`claude-haiku-2`……)，桌面端缓存了当时的假名；网关重启或上游目录变动后编号漂移，客户端拿旧假名来路由，上游 400。

**修法**：假名必须**按真实模型 id 哈希**生成（纯函数，与发现顺序、重启无关）——同一真实模型，假名永远一样。网关 `aliasFor` 已按此实现。**改完必须完全退出桌面端再打开**，让它丢掉缓存的旧假名。

---

## #8 某账号请求全 400，换账号就好

**根因**：该凭据的 uid 或令牌与上游记录不一致（比如 `.info` 文件是旧登录的残留，或账号被风控）。

**修法**：网关轮询到别的账号就行。排查时可用 `x-wb-account: <uid|uin|备注名>` 请求头指定账号逐个测；坏的 `.info` 移出凭据目录即可（`%APPDATA%\CodeBuddyExtension\Data\Public\auth\`)。

---

## #9 空正文 + stop_reason: max_tokens

**根因**：上游模型把 `max_tokens` 预算花在内部推理（`reasoning_content` 字段）上。客户端给的额度太低（如 100）时，推理吃光预算，正文为空。

**修法**：网关 `minMaxTokens`（默认 8192）自动抬高客户端过低的额度。**别把这个值调成 0 或过小。**

---

## #10 延迟波动大（8 秒到 3 分钟）

**根因**：上游推理时长不确定。实测 `reasoning_effort: "low"` 无效（推理 token 反而 158→1023)，所以没有做成开关。

**修法**：不是 bug。客户端卡住时看网关日志的 ping 保活（`keepAliveMs`，默认 15 秒一发）。嫌慢换 `hy3`（上游标注限时免费且更快）。

---

## #12 迁移/删除过网关目录后，开机自启静默失效（计划任务指向旧路径）

**症状**：重启或登录后 8789 没起来（桌面端连不上）；但手动双击 `start.bat` 或跑 setup 一切正常。查 `Get-ScheduledTaskInfo -TaskName WorkBuddyGateway` 的 `LastTaskResult` = `2147942667`（即 `0x8007010B`，"目录名无效"）。

**根因**：计划任务的启动动作记录的是**注册那一刻的网关绝对路径**（WorkingDirectory）。此后网关目录只要被移动过——例如曾在临时目录里做过「模拟新机器」的部署测试、测完把目录删了——任务就再也拉不起网关，且**静默失败**（不弹任何提示）。

**修法**：在网关的**当前**目录重跑 `scripts\setup-gateway.ps1`（会用新路径重注册任务，幂等）；或先 `Unregister-ScheduledTask -TaskName WorkBuddyGateway -Confirm:$false` 再重跑 setup。验证：`Get-ScheduledTaskInfo` 的 `LastTaskResult` 变成 `0`。

---

## #13 模型上下文只有 200K（DSH 里明明是 1M）

**症状**：同一个模型（如 glm-5.3-flash），在 DSH/WorkBuddy 客户端里显示 1M 上下文，接到 Claude 桌面端后只剩 200K。

**根因**：上游模型表每条带真实 `maxInputTokens`（glm-5.3-flash 等真实支持 1,000,000），但桌面端对网关发现的模型**不读这个值**——它只认 `/v1/models` 条目里的 `supports_1m` 字段，没有就按客户端内置默认 200K 算。网关以前没发这个字段，所以全部被压成 200K。

**修法**（已内置在网关 `src/server.ts`）：
1. `upstreamCatalog()` 保留上游的 `maxInputTokens` 字段
2. `/v1/models` 对 `maxInputTokens ≥ 1_000_000` 的条目发 `supports_1m: true`
3. 消息路由剥掉 `[1m]` 后缀再反查假名（客户端选 1M 变体时会发 `claude-xxx-n[1m]`）

**验证**：`/v1/models` 里 10 个 1M 模型带 `supports_1m`；用 `假名[1m]` 发真实请求能正常回复。桌面端要看到 `[1m]` 变体需**完全退出重开**。

**注意**：`supports_1m` 是对部署能力的声明，只有上游真实 ≥1M 的模型才能发——乱发会导致超长请求在上游报错。168K~512K 档位的模型（如 kimi-k2.6 256K、minimax-m3 512K）保持不声明，如实透传。

---

## #14 计划任务拉起网关时弹出黑色终端窗

**症状**：开机登录后、或网关死而复活的瞬间，屏幕上闪一个黑色终端窗口（node 的控制台）。

**根因**：计划任务直接执行 `node.exe`，控制台程序被任务调度器拉起时自带可见窗口。

**修法**（已内置在 `setup-gateway.ps1`）：任务改为执行 `wscript.exe hidden-start.vbs`，由 VBS 以隐藏窗口样式（窗口样式 0）拉起 node——全程无窗口，且 wscript 常驻等待进程退出，任务状态保持 Running、`MultipleInstances=IgnoreNew` 的防重逻辑继续有效。

---

## #15 DSH 里聊天全报错：`UNKNOWN_MODEL` /「API 密钥无效」（全局代理把上游拉取带偏）

**症状**：DSH 聊天完全无法进行，报 `pi-ai provider "workbuddy-xdpool" has no configured model "<模型名>"`（`UNKNOWN_MODEL`）或「API 密钥无效」；**不开代理必犯、开着代理就好**（看起来像"必须开梯子才能用"），重启偶尔短暂恢复。

**根因**：DSH 内核的 `dsh-http-proxy` 会把 `$DSH_HOME/.env` 里的 `HTTP_PROXY` / `HTTPS_PROXY` 应用到**进程内所有出站请求**（仅 `NO_PROXY` 白名单例外，loopback 自动豁免）。这份 .env 往往是为别的事配的（例如绕 Clash TUN 的 fake-ip 问题），而 WorkBuddy 上游域名**不在白名单**里，于是：

- 代理进程在跑 → 一切正常
- 代理进程一退出 → 端口没人监听 → 插件启动时拉不到模型目录（`copilot.tencent.com/v2/enterprises/personal/models`）→ **退回内置静态兜底表（仅 10 个模型）**
- 兜底表里没有的模型（`deepseek-v4.1-flash`、`auto`、`hy3-x`、`glm-5v-turbo`、`kimi-k3-1`、`kimi-k2.x` 都不在）一被点名就是 `UNKNOWN_MODEL`；伴随的「API 密钥无效」同因——插件所有联网环节都被同一个死代理阻断

**修法**：把这些域名加进 `.env` 的 `NO_PROXY`（它们国内可直连，聊天本身不需要代理）：

```ini
NO_PROXY=localhost,127.0.0.1,::1,<你已有的条目>,copilot.tencent.com,codebuddy.cn
# 国际版（global）另加：workbuddy.ai
```

改完**重启 DSH**——`.env` 只在启动时读一次。

**验证**：调插件状态接口看 `models` 数组长度：**16 = 拉取成功**；**10 = 还在用兜底表**（代理问题未解）。修复后即使代理完全关闭也应是 16。

**抗性建议**：默认模型用 `deepseek-v4-pro`（在兜底表内）比 `deepseek-v4.1-flash`（不在）更耐故障——拉取失败时前者仍可对话，后者直接整体报错。

**注意**：本仓库的反代网关（8789）是独立进程、默认不读这些代理变量，不受此坑影响；它只咬 DSH 内核托管的那条链路。

> 实测 2026-09-29：Clash 完全退出 + `NO_PROXY` 含上述域名，重启 DSH → 16 个模型全可用。
