# Codex Anthropic Adapter

本目录是 `One Claw` 的本地协议桥。

它负责把上层 CLI 发出的 Anthropic 风格请求转成对 `codex app-server` 的调用。

当前职责：

- `/health`
- `/v1/messages`
- 文本响应转发
- SSE 流式输出
- `tool_use` / `tool_result` 与 Codex dynamic tool 调用桥接
- provider/auth 集成

当前限制：

- 会话映射主要保存在 adapter 进程内
- Claude.ai 专属控制面能力没有在 codex 模式下实现

## 启动

### 单独启动 adapter

```bash
cd /Users/mac/Documents/claude-code-source
bun run adapter:codex
```

### 启动完整本地栈

```bash
cd /Users/mac/Documents/claude-code-source
bun run stack:codex
```

### 启动 CLI

```bash
cd /Users/mac/Documents/claude-code-source
bun run start:codex
```

正常使用时更推荐直接运行：

```bash
one
```

## 可选环境变量

- `CODEX_ADAPTER_HOST`
- `CODEX_ADAPTER_PORT`
- `CODEX_ADAPTER_API_KEY`
- `CODEX_APP_SERVER_URL`
