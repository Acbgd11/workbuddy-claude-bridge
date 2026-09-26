# workbuddy-claude-bridge

把 **WorkBuddy（腾讯 CodeBuddy）** 的账号额度，接入 **Claude Code / Claude 桌面端**。

一个本地反代网关 + 一套可对话的安装向导，全部踩坑实录都内置好了。

---

## 这是什么

WorkBuddy（腾讯 CodeBuddy）桌面端背后有一套模型接口，但没有官方途径给 Claude Code 用。这个项目在本地起一个小网关，把 WorkBuddy 的登录态转成标准 **Anthropic Messages API**，于是 Claude Code 和 Claude 桌面端就能直接选用 WorkBuddy 里的模型（GLM、DeepSeek、Kimi、MiniMax、混元……）。

```
Claude 桌面端 / Claude Code
      │  ANTHROPIC_BASE_URL = http://127.0.0.1:8789
      ▼
workbuddy-anthropic-gateway   ← 本项目（Node 直跑 TypeScript，零 npm 依赖）
      │  读 WorkBuddy 明文凭据 → 转发
      ▼
https://copilot.tencent.com   ← WorkBuddy 客户端同款接口
```

## 特点

- **零依赖**：网关是 7 个 TypeScript 源文件，只用 Node 内置模块，不需要 `npm install`，不需要打包构建
- **两种客户端都支持**：Claude 桌面端（3P gateway 模式，动态发现全部模型）+ 终端 Claude Code（经 cc-switch 接入）
- **1M 上下文如实申报**：上游真实支持 1M 的模型（GLM-5.3-Flash、DeepSeek-V4.1-Flash、Kimi-K3 等 10 个）会在桌面端出现 `[1m]` 变体，不再被压成 200K
- **自愈式常驻**：计划任务双触发器（登录 + 每 5 分钟自检），进程意外死掉最多 5 分钟自动复活，隐藏窗口无弹黑框
- **踩坑全内置**：从一台空白电脑到跑通的全过程，含 15 条真机排障记录（`references/pitfalls.md`）
- **一键部署**：`scripts/setup-gateway.ps1` 幂等执行——启动网关、写客户端配置、注册开机自启

## 快速开始

**前置**：Windows 10/11、已登录的 WorkBuddy 桌面端、Node.js（需能直接运行 `.ts`，即 22.18+ 或更新的 LTS）

```powershell
cd workbuddy-claude-bridge\scripts
powershell -ExecutionPolicy Bypass -File .\doctor.ps1
```

体检表会把缺的东西列出来。补齐后：

```powershell
powershell -ExecutionPolicy Bypass -File .\setup-gateway.ps1
```

脚本会自动找到同级文件夹里的网关。如果网关放在别处，再补 `-GatewayDir "路径"`。

然后**完全退出** Claude 桌面端（右键托盘图标 Quit）再打开——模型选择器里就会出现全部模型。

> 更详细的安装流程，见 [`SKILL.md`](SKILL.md)（按对话阶段走，一次只做一件事）。

## 如果你用 DSH / 或其他支持 skill 的 AI 助手

把整个 `workbuddy-claude-bridge/` 文件夹放进 skills 目录，对 AI 说一句「帮我接入 WorkBuddy 到 Claude」，它会自己照着 `SKILL.md` 的 4 阶段流程引导你，不用手动跑脚本。

## 文件结构

```
SKILL.md                    AI 操作手册：4 阶段对话式安装流程
EXPERIENCE.md               一手经验与踩坑心得（模型身份、积分、档位、排障心法）
README.md                   你正在看的这份
references/
  pitfalls.md               13 条真机踩坑实录（症状 → 根因 → 修法）
  desktop-profile-schema.md Claude 桌面端 profile 校验规则（asar 逆向结论）
  config-template.json      网关 config.json 模板（映射已配好）
  cc-switch-env.md          终端 CLI 在 cc-switch 里要填的 env
  download-links.md         各组件获取方式
scripts/
  doctor.ps1                环境体检（只读，先跑这个）
  setup-gateway.ps1         一键部署（幂等）
workbuddy-anthropic-gateway/  网关源码（零依赖，Node 直接运行）
```

## 已知会遇到的坑（都已有对策）

| 现象 | 一句话根因 |
|---|---|
| 全部请求 400，错误码 11128 | 上游识别客户端身份，system 里的计费标记/身份词被拦截（网关已内置净化） |
| 问 AI 是什么模型，答不对 | 网关为绕校验剥掉了身份信息（已改为注入真实模型名） |
| 模型选择器只有 3 个或 5 个 | 客户端缓存 / 模型假名没过桌面端三重校验 |
| 黄色横幅 "provider setup needs a fix" | profile 缺字段或被客户端自己重写剥掉 |
| 凭据全被跳过 | 桌面端 5.6+ 把令牌加密了，需用明文 pool 文件 |
| 重启后连不上，手动启动却正常 | 计划任务记录的旧路径失效（静默失败） |
| 上下文只有 200K（别处是 1M） | 客户端只认 `/v1/models` 的 `supports_1m` 声明，网关已按上游真实能力如实上报 |
| 拉起网关时闪黑窗 | 任务直跑 node.exe 自带控制台，已改为 VBS 隐藏启动 |

完整清单见 [`references/pitfalls.md`](references/pitfalls.md)。

## 免责声明

本项目仅供个人学习与技术研究使用。WorkBuddy / CodeBuddy / Claude 的相关服务条款请自行遵守，使用风险自负。项目不包含任何账号、凭据或密钥。

## License

MIT
