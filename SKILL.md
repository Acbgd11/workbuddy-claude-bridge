---
name: workbuddy-claude-bridge
description: 把 WorkBuddy(腾讯 CodeBuddy)账号接入 Claude Code / Claude 桌面端的全流程安装向导。从"电脑里只有 WorkBuddy + DSH"的空白状态开始,以对话形式一步步引导用户装好 xdpool/workbuddy-switch、启动反代网关、配置 cc-switch/桌面端 profile,并把已知的全部踩坑(11128 计费标记、桌面端模型名三重校验、profile 被重写、凭据加密包装等)内置成排障速查。用户提到 WorkBuddy 反代、Claude 接入报错、给朋友的电脑部署接入流程时,必须用这个 skill 主导全过程。
---

# workbuddy-claude-bridge

把 WorkBuddy 账号变成 Claude Code / Claude 桌面端可用模型的**安装向导 skill**。

## 这个 skill 是什么

不是一段代码,而是一套**可对话的安装流程**——你(执行这个 skill 的 AI)照着下面的阶段走,用户只看对话框。最终产出：朋友的电脑上,Claude 桌面端选择器里出现全部 WorkBuddy 模型,随便选。

## 前置假设(目标电脑的起点)

- Windows 10/11
- 已安装 **WorkBuddy 桌面端**并已登录
- 已安装 **DeepSeek Harness(DSH)**
- **没有** xdpool 插件、**没有** workbuddy-switch、**没有** Node（或版本太旧、直接跑不了 .ts）
- 目标是 **Claude 桌面端**(Windows Store 版,走 3P gateway 模式)；终端 CLI(Claude Code)是顺带支持

## 最终架构(先给用户画一张图)

```
Claude 桌面端 / Claude Code
      │  ANTHROPIC_BASE_URL=http://127.0.0.1:8789
      ▼
workbuddy-anthropic-gateway  (Node 直接运行 TypeScript,零 npm 依赖;需 22.18+)
      │  读 WorkBuddy 明文凭据 → 转发上游
      ▼
https://copilot.tencent.com  (WorkBuddy 客户端同款接口)
```

凭据从哪来？两条路，用户**二选一**:

| 路线 | 工具 | 特点 |
|---|---|---|
| A | **xdpool 插件**(DSH 插件) | 在 DSH 里点「添加账号」扫码,即出明文凭据；登录方便 |
| B | **workbuddy-switch**(独立 APP) | 桌面 APP，积分图表好看，同步一次也出明文凭据 |

---

# 流程：按阶段走，每步确认再进行下一步

## 阶段 0：环境体检(30 秒)

先跑 `scripts/doctor.ps1`，它会自动探测并输出一张体检表。逐项跟用户念结果，**缺什么再补什么，不要一次性让用户装三样**:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\doctor.ps1
```

体检项（脚本会自动给 ✅/❌):
1. WorkBuddy 已登录（看 WorkBuddy 桌面端进程是否在跑）
2. Node 能直接跑 .ts（脚本实测；不足就提示装新 LTS）
3. 明文凭据存在（扫 `%APPDATA%` / `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-pool-*.info`)
4. xdpool 插件已装（看 `DSH-Home\.workbuddy-xdpool` 目录）— **只在用户没凭据时才需要**
5. workbuddy-switch 已装（看 `com.wbswitch.app` 或常见路径）— **与 4 二选一**

**对话模板**（照着说，别让用户自己猜）:
> "先帮你体检一下电脑。结果：[X 有、Y 缺]。好消息是基础都在，只需要补一个 [凭据来源]。你想用 A(DSH 里的 xdpool 插件）还是 B（单独的 workbuddy-switch APP)？A 登录更方便，B 的积分图表更好看。"

## 阶段 1：装凭据来源（只在阶段 0 显示缺凭据时）

**用户选 A(xdpool)**:
1. 引导用户在 DSH 的插件市场装 `workbuddy-xdpool`（若找不到，给官方仓库地址，见 `references/download-links.md`)
2. 装好后在插件卡片点「添加账号」→ 扫码登录
3. 验证：`doctor.ps1` 第 3 项应变 ✅（出现 `workbuddy-scan-*.info`)

**用户选 B(workbuddy-switch)**:
1. 从 `references/download-links.md` 给官方下载地址（MSIX 安装包，双击装）
2. 打开 APP → 登录 → 点「同步」
3. 验证：`doctor.ps1` 第 3 项应变 ✅（出现 `workbuddy-pool-*.info`)

**避坑**：桌面端 5.6+ 会把令牌写成 `$wbEncrypted` 加密包装，这类文件网关会跳过。**必须有至少一个明文 pool 文件**，没有就回到这一步。

## 阶段 2：放网关代码 + 启动（2 分钟）

1. 网关代码**就在本 skill 文件夹内**（`workbuddy-anthropic-gateway/`，和 `SKILL.md` 同级）。确认它在位即可，不需要额外下载。若用户想放到别处长期保存，把整个文件夹复制过去也行
2. 确认 `config.json` 用 `references/config-template.json` 的内容
3. 装 Node（若缺或跑不了 .ts，给 nodejs.org 官方 LTS 链接；需 22.18+）
4. 跑一键脚本：

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\setup-gateway.ps1
   ```

   （脚本会自动找到本 skill 文件夹内的 `workbuddy-anthropic-gateway`；网关放在别处才需要补 `-GatewayDir "路径"`）

   脚本自动完成：启动网关 → 探测 `/healthz` → 写桌面端 profile → 注册开机自启。**幂等，可反复跑。**

5. 验证：让用户打开 `http://127.0.0.1:8789/healthz`,应看到 `"ok":true` 和账号列表。

## 阶段 3：接入 Claude（按用户用哪个客户端分路）

**路线一：Claude 桌面端（推荐，用户主要用这个）**
setup 脚本已写好 profile(`Claude-3p\configLibrary\...json`)。让用户**完全退出桌面端再打开**（右键托盘图标退出，不是关窗口）。选择器里应出现全部模型（glm-5.3-flash、deepseek-v4.1-flash、kimi-k3-1 等 28 个，带积分倍率）。

**路线二：终端 Claude Code(cc-switch)**
在 cc-switch 加 provider,env 填（见 `references/cc-switch-env.md`):
- `ANTHROPIC_BASE_URL` = `http://127.0.0.1:8789`
- `ANTHROPIC_AUTH_TOKEN` = `data\api-key.txt` 内容
- `ANTHROPIC_DEFAULT_OPUS_MODEL` / `SONNET_MODEL` = `glm-5.3-flash`
- `ANTHROPIC_DEFAULT_HAIKU_MODEL` = `deepseek-v4.1-flash`

## 阶段 4：验收（1 分钟）

让用户随便选一个没听过的模型（比如 `kimi-k3-1`)，发一句"你好"。**看网关日志**：应出现 `假名 claude-xxx-N → kimi-k3-1` 且模型正常回复。通了 = 完工。

---

# 报错经验吸收（遇到就照着查，别重排）

**这是整个 skill 最值钱的部分。** 所有坑在 `references/pitfalls.md`，按症状速查：

| 用户说的现象 | 根因 | 跳到哪节 |
|---|---|---|
| "模型只有 3 个 / 时有时无 / 重启没用" | cc-switch 缓存了旧模型清单 | **pitfalls.md #0(首选修法)** |
| "桌面端完全没反应 / 连不上" | 网关没起（8789 无监听） | pitfalls.md #1 |
| "黄色横幅 provider setup needs a fix" | profile 缺 inferenceModels / 被桌面端重写剥掉 | pitfalls.md #2 |
| "organization hasn't configured any models" | 同上 | pitfalls.md #2 |
| "Invalid request" + 网关全 400 | system 带计费标记，上游 11128 拦截 | pitfalls.md #3 |
| "选择器只有 5 个模型" | 假名含黑名单词（glm/deepseek/kimi/…) 或没带 tier 字段 | pitfalls.md #4 |
| "终端 CLI 报 400，桌面端好的" | 同上（计费标记） | pitfalls.md #3 |
| "凭据全是 $wbEncrypted 被跳过" | 桌面端 5.6+ 加密包装 | pitfalls.md #5 |
| "配置写好了但桌面端像没读" | profile 写错位置（cc-switch 旧版写到容器外） | pitfalls.md #6 |
| "模型名对不上 / 说自己是 Opus" | 系统提示扮演，看网关日志 `x-wb-model-used` | pitfalls.md #7 |
| "一直是旧路径 / 重启后连不上" | 计划任务记录的旧绝对路径失效 | pitfalls.md #12 |
| "上下文只有 200K / 没有 1M 变体" | 网关没发 `supports_1m`（旧版）；需完全退出重开桌面端 | pitfalls.md #13 |
| "计划任务拉起时弹黑窗" | 直跑 node.exe 自带控制台；已改 VBS 隐藏启动 | pitfalls.md #14 |
| "问他是什么模型，答不对" | 网关剥掉了身份信息；现已改为注入真实模型名 | EXPERIENCE.md 第一节 |

**进阶问题**（积分为什么变多、推理档位能不能调、怎么排查）不在 pitfalls 里，在 [`EXPERIENCE.md`](EXPERIENCE.md)——那是作者的实测心得，不是报错速查。

---

# 给执行 AI 的话（别看漏）

- **用户是非技术背景**，全程用大白话，别在对话里讲协议、JSON、正则。要提就说"小工具/配置文件/服务"这种词。
- **一次只让用户做一件事**。阶段 0 体检完，只让他补缺的那一样，不要列三样让他选。
- **遇到报错先查 pitfalls.md**，查不到再临场分析——不要凭记忆瞎猜，那些坑都是我（这个 skill 的作者）拿真机一条条试出来的。
- **改网关代码前必读** `references/desktop-profile-schema.md` 和 `references/pitfalls.md`——桌面端那三重校验是 asar 逆向结论，别的地方查不到，不看必踩。
- **最敏感的两个函数**是 `sanitizeSystemIdentity()` 和 `stripBillingHeader()`，它们直接决定上游 11128 拦不拦你。改这两个前先备份 `anthropic.ts`，改完必须跑一条真实请求验证 HTTP 200。详见 EXPERIENCE.md。
- setup-gateway.ps1 幂等，用户说"好像没生效"就先让他重跑一遍脚本+完全退出桌面端，这两步能解决 80% 的"没生效"。
