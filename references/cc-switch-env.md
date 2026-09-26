# cc-switch 里要填的 env 配置(终端 Claude Code 专用)

> 桌面端**不需要**填这些——它走模型发现自动出全部模型。这些只在终端 CLI(Claude Code)用。

在 cc-switch 添加 provider,`settings_config` 的 `env` 块填：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8789",
    "ANTHROPIC_AUTH_TOKEN": "<workbuddy-anthropic-gateway/data/api-key.txt 的内容>",
    "ANTHROPIC_MODEL": "glm-5.3-flash",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.3-flash",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.3-flash",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4.1-flash",
    "API_TIMEOUT_MS": "3000000"
  }
}
```

## 要点

- **`ANTHROPIC_BASE_URL` 不带 `/v1`**——cc-switch 会自己拼接并折叠重复的 `/v1`
- **三个 `ANTHROPIC_DEFAULT_*_MODEL` 必须填**，否则 Claude Code 会发 `claude-sonnet-4-5` 这类真实 Anthropic 模型名过来，网关按 `models.map` 兜底映射（见 `config-template.json`)
- `ANTHROPIC_AUTH_TOKEN` 用 Bearer 头；网关同时接受 `x-api-key`，想用 `ANTHROPIC_API_KEY` 也行
- `API_TIMEOUT_MS` 给足（上游推理慢，8 秒~3 分钟波动）
