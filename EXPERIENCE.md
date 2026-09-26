# EXPERIENCE.md — 一手经验与踩坑心得

> 这份文件不是操作手册（操作流程见 `SKILL.md`），而是**作者在真机上被打了两天之后，回过头来想说的话**。
>
> 里面每一条都来自实际故障，不是从文档抄的。如果你遇到相似现象，这里的判断往往比搜索引擎更快。

---

## 一、模型身份：为什么它总说自己是 Claude，以及怎么修

**现象**：接入成功后一切正常，但问 AI「你是什么模型」，它会说自己是 Claude Opus / Claude Sonnet，对不上实际后端。

**很多人以为**这是 Claude Code 客户端"嘴硬"。**不是。** 真正的原因是链条上有两层：

1. Claude Code 会在 system 提示里发一句官方自我介绍：`You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.`
2. **网关为了绕开上游的渠道校验，必须把这句改掉**（否则触发 11128，见下节）——改成了一个没有任何身份的 `You are an AI coding assistant.`

模型被剥夺了全部身份信息，只能凭训练记忆瞎猜，所以答案随机：这次说 Opus，下次说别的。

**修法（已内置在网关 `src/anthropic.ts`）**：把那个中性描述替换成**带真实模型名的自我介绍**，例如：

```
You are glm-5.3-flash, a large language model.
If the user asks which model or version you are, answer truthfully with exactly: glm-5.3-flash.
Never claim to be a Claude model or made by Anthropic.
```

网关在 `sanitizeSystemIdentity(text, realModel)` 里注入真实上游模型名（那个值本来就是现成的，就是日志里 `model=` 后面的字符串）。改完重启网关，再问「你是什么模型」，它就能如实回答。

**要点**：新注入的文案**不能**同时包含 `Claude Code` 和 `Anthropic` 两个词，否则会重新触发 11128（见下节）。改这个函数后一定要跑一次真实请求验证 HTTP 200。

---

## 二、渠道校验 11128：最隐蔽的一层坑

**报错原文**：`{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}`（HTTP 400）。

**这不是凭据问题、不是网络问题、不是积分问题。** 是上游腾讯在识别「这个请求是不是官方客户端发的」，发现不是就拦掉。

**触发条件（关键认知：单独出现都放行，共现才触发）**：

| 层 | 触发内容 | 位置 | 网关对策 |
|---|---|---|---|
| ① | `x-anthropic-billing-header: cc_version=...; cc_entrypoint=...` | system 文本 | `stripBillingHeader()` 整行删除 |
| ② | `Claude Code` 与 `Anthropic` **在同一段共现** | system 文本 | `sanitizeSystemIdentity()` 中性化 |
| ③ | `github.com/anthropics/claude-code/...` 路径同框 | system 文本 | 替换为无害 URL |

**最重要的一条结论**：判断只发生在 **system 文本**里。工具描述、工具名、用户消息里的这些词**不算数**——实测在工具描述里放 `Claude Code` 不会触发。所以净化只需要处理 system，不要多此一举去改用户的对话内容。

**排障方法**：设环境变量 `WB_DUMP=1` 启动网关，它会把请求落盘到 `data/dump/`，直接看发给上游的 system 字段到底剩了什么。

---

## 三、反代会让积分消耗变多吗？（实测调查结论）

网上有人说：同一个问题在 WorkBuddy 客户端里花 5-6 积分，反代接入 Claude Code 后花得更多。**这个说法方向是对的，但原因不是"反代被惩罚"。**

上游的模型清单里带**计费倍率**（例如 `glm-5.3-flash x0.06`、`deepseek-v4.1-flash x0.11`、`kimi-k3-1 x1.62`）。积分 = token 量 × 倍率。差异出在 **token 量**上：

- **官方 WorkBuddy 客户端**（它的内核本身就是 CodeBuddy CLI）启动时会给工具标 `"defer_loading": true`，**按需加载工具**——不用的工具描述根本不进请求
- **Claude Code 反代**没有这个机制，它每次都把**全部工具描述**塞进请求。实测一次真实请求：system 3.2 万字符 + **工具描述 11.4 万字符** + 历史消息 32.8 万字符 ≈ 15.8 万 input token

工具描述一个人就占了请求的 1/3 以上。**这就是"反代积分更多"的主要来源**——不是链路被区别对待，而是请求体本身更胖。

**能优化吗？** 上游客端 JSON 里有 `DeferToolLoading` 和 `RequestBodyGzip` 两个官方优化开关，反代链路没用上。理论上可以在网关加"工具描述裁剪/延迟加载"，但那是较大的改造，收益与风险要自行评估。

**另外一个真相**：反代和官方客户端**走的是同一条上游链路**（都是 `copilot.tencent.com`、同一套凭据）。所谓"反代是旁路、会被限速"的猜测不成立。

---

## 四、推理档位（low / medium / high）：看似支持，实则做不成

**现象**：在 Claude Code 里调推理档位，感觉没反应。

**调查结论（12 组直连上游的隔离实验）**：

- 上游元数据里**写着** `supportedEfforts: ["low", "high", "max"]`，看起来支持三档
- 但实测：`low` 和 `high` 的行为**完全一样**——上游只区分"**参数在不在**"，不区分具体档位
- 更麻烦的是，效果方向**随模型反转**：
  - `glm-5.3-flash`：不发参数 → 正常思考（~1400 推理字符）；**发任意档位 → 思考完全关闭**（推理 0 字符，耗时 11.8s → 3.7s）
  - `deepseek-v4.1-flash`：不发 → 不思考；**发任意档位 → 反而开启思考**

**所以**：接档位只能做成"思考开/关"的二值开关，做不到真正的分级，而且两个主力模型行为相反。**除非有明确需求，不建议接**——加一根新线的复杂度，换来的只是"某个模型快 3 秒"，不划算。嫌慢直接换更快的模型（如 `hy3`）。

---

## 五、排查心法（比具体修法更重要）

1. **先看证据，再改代码。** 网关设 `WB_DUMP=1` 后，`data/dump/` 里的 `.anthropic.json`（客户端发来的）和 `.upstream.json`（网关转发的）成对出现，两者一对比就知道网关在哪一步改坏了东西。别凭印象改。
2. **改网关最敏感的是 `sanitizeSystemIdentity()` 和 `stripBillingHeader()`。** 这两个函数直接决定 11128 拦不拦你。改这两个之前先备份 `anthropic.ts`，改完**必须**跑一条真实请求确认 HTTP 200。
3. **"没生效"九成是没重启/没退出。** 改 profile 必须**完全退出桌面端**（右键托盘 Quit，不是点窗口的 X）；改网关代码必须重启网关进程。这两件事各解决一半的"改了半天没用"。
4. **隔离实验是关键习惯。** 想验证上游行为（比如档位、延迟、计费），写个**独立脚本直连上游**，不要拿线上网关当试验台。脚本只读凭据、不改网关状态，测完就删——这样无论结论如何都不会污染那条已调通的主链路。
5. **上游延迟天然波动（8 秒 ~ 3 分钟）。** 这不是故障。看网关的 ping 保活（`keepAliveMs`，默认 15 秒一发）能确认链路还活着。

---

## 六、自动化里那些真正省事的做法

- **开机自启用计划任务**（`scripts/setup-gateway.ps1` 已注册 `WorkBuddyGateway`），比"开机手动双击 start.bat"可靠得多
- **但计划任务记录的是注册那一刻的绝对路径。** 一旦网关目录被移动/删除（比如在临时目录里做过部署测试后删掉），任务会**静默失败**——不弹任何提示，你只会发现"今天连不上了"。查 `Get-ScheduledTaskInfo` 的 `LastTaskResult`，若是 `2147942667`（`0x8007010B`，"目录名无效"）就是这个问题，在**当前**目录重跑 setup 脚本即可
- **网关资源占用极低**（约 60-90 MB 内存、空闲 CPU 近 0、只监听 127.0.0.1），可以常开，不必开开关关
- **改网关配置不用重启**：`config.json` 有热重载（保存即生效）。但改**代码**必须重启
- **凭据文件**：网关只认明文的 `workbuddy-pool-*.info` / `workbuddy-scan-*.info`；桌面端 5.6+ 写的 `$wbEncrypted` 加密包装会被跳过（这是设计，不是 bug——不猜密码是对的）
