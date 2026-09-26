# 下载与获取方式

> 以下地址随时间可能变化，失效时按名字去 GitHub 搜同名项目即可。

## 本 skill 自带（推荐，已验证）

- **网关代码**:`workbuddy-anthropic-gateway/` 文件夹（与 SKILL.md 同级，见 `scripts/` 旁的获取说明）
- **config.json 模板**:`references/config-template.json`（直接替换网关根目录的 config.json)

## 凭据来源（二选一）

| 工具 | 类型 | 获取方式 |
|---|---|---|
| **xdpool 插件** | DSH 插件 | DSH 桌面端 → 插件市场 → 搜 `workbuddy-xdpool` 安装；装好在插件卡片点「添加账号」扫码 |
| **workbuddy-switch** | 独立 APP(MSIX) | 项目仓库 `CangShui/workbuddy-gateway` 或同类 WorkBuddy 账号池工具的 Releases 页下载 .msix 双击安装 |

## Claude 侧

| 工具 | 获取方式 |
|---|---|
| **cc-switch** | GitHub `farion1231/cc-switch` Releases（选 Windows 安装包） |
| **Claude 桌面端** | Microsoft Store 搜 "Claude"，或 claude.ai 官网下载 Windows 版 |

## 运行时

| 工具 | 获取方式 |
|---|---|
| **Node.js（能直接跑 .ts）** | nodejs.org 官方 LTS（**必须能直接运行 `.ts` 文件**，即 22.18+ 或更新的 LTS；无需任何 npm 包） |

> 检测方法：随便存一个含类型标注的 `.ts` 文件，用 `node 它.ts` 跑一下，不报错就行。

## 验证清单（装完逐项打勾）

- [ ] WorkBuddy 桌面端已登录
- [ ] `node` 能直接跑 `.ts` 文件（22.18+ LTS）
- [ ] `%APPDATA%\CodeBuddyExtension\Data\Public\auth\` 下有 `workbuddy-pool-*.info` 或 `workbuddy-scan-*.info`
- [ ] `http://127.0.0.1:8789/healthz` 返回 `"ok":true`
- [ ] 任务计划程序里有 `WorkBuddyGateway`（登录自启）
