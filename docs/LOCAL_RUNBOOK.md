# 本地运维 Runbook

这份文档面向当前这台机器上的 `check-cx` 实例，默认工作目录是仓库根目录。

默认约定：

- 默认监听：`0.0.0.0:24167`
- 本地入口：`http://127.0.0.1:24167`
- PID 文件：`/tmp/check-cx.pid`
- 日志文件：`/tmp/check-cx.log`
- 默认分组：`cch`
- 环境文件：`.env.local`
- 管理脚本：`pnpm ctl`

## 1. 核心结论

日常操作优先用脚本，不要手工拼命令：

```bash
pnpm ctl service start
pnpm ctl service status
pnpm ctl service restart
pnpm ctl service stop
pnpm ctl service logs --tail 120
pnpm ctl build
pnpm ctl update
pnpm ctl providers list --group cch
pnpm ctl providers sync-cch --group cch
pnpm ctl providers refresh --group cch
```

这套脚本已经处理了两件容易踩坑的事：

- `start` 会自动使用 standalone 感知启动器，避免 `.next/standalone` 缺静态资源时页面 JS/CSS 404。
- `build` / `update` 会走带代理的 shell，避免 Next 构建时拉 Google Fonts 失败。

## 2. 启动与关闭

### 启动

```bash
pnpm ctl service start
```

默认会：

- 读取 `.env.local`
- 以 `0.0.0.0:24167` 启动服务
- 将输出写到 `/tmp/check-cx.log`
- 将 PID 写到 `/tmp/check-cx.pid`

如需覆盖端口：

```bash
pnpm ctl service start --port 3000 --host 0.0.0.0
```

### 查看状态

```bash
pnpm ctl service status
```

会返回 JSON，包含：

- 当前 PID 是否存在
- PID 来自哪里（`pid-file` 或自动识别到的端口监听进程 `listener`）
- `/` 和 `/group/cch` 的 HTTP 状态与标题
- 当前页面引用的 CSS 资源是否返回 200
- `/api/group/cch` 返回的 provider 总数和状态摘要

### 查看日志

```bash
pnpm ctl service logs --tail 120
```

### 停止

```bash
pnpm ctl service stop
```

### 重启

```bash
pnpm ctl service restart
```

## 3. 构建与更新

### 仅重新构建

```bash
pnpm ctl build
```

等价于带代理执行：

```bash
pnpm build
```

当前仓库已经固定使用 `next build --webpack`。不要改回默认 `next build`，因为本机环境下 Turbopack 路径不稳定，会导致构建失败。

### 拉取更新并重启

```bash
pnpm ctl update
```

默认流程：

1. 检查 git 工作区是否干净
2. `git pull --ff-only`
3. `pnpm install --frozen-lockfile`
4. `pnpm build`
5. `pnpm ctl service restart`

注意：

- 如果工作区有未提交改动，`update` 会拒绝执行
- `update` 会访问外网，脚本内部已经启用代理 shell

## 4. Provider 管理

### 查看当前配置

```bash
pnpm ctl providers list --group cch
```

### 从 Claude Code Hub 同步启用中的 provider

```bash
pnpm ctl providers sync-cch --group cch
```

脚本会：

- 调用本地 CCH API 拉取启用中的 provider 列表
- 从 CCH 数据库容器读取对应 key
- 自动映射为 `check-cx` 可用的健康检查配置

当前映射规则：

- `providerType = codex`：转为 `openai` 类型，端点使用 `.../v1/responses`
- `providerType = openai-compatible`：转为 `openai` 类型，端点使用 `.../v1/chat/completions`
- chat 类 provider 优先选 `gpt-5`
- responses 类 provider 优先选 `gpt-5.4`

### 新增一个 provider

```bash
pnpm ctl providers upsert \
  --group cch \
  --name My-Provider \
  --type openai \
  --model gpt-5.4 \
  --endpoint https://example.com/v1/responses \
  --api-key sk-xxx
```

### 修改一个 provider

```bash
pnpm ctl providers set \
  --group cch \
  --name My-Provider \
  --model gpt-5 \
  --endpoint https://example.com/v1/chat/completions
```

### 禁用 / 启用一个 provider

```bash
pnpm ctl providers disable --group cch --name My-Provider
pnpm ctl providers enable --group cch --name My-Provider
```

禁用后不会再参与健康检查，但历史记录仍保留。

### 触发一次分组刷新

```bash
pnpm ctl providers refresh --group cch
```

这会请求本地：

- `GET /api/group/cch?trendPeriod=7d&forceRefresh=1`

适合在新增/修改 provider 后立刻验证结果。

## 5. 状态检查怎么看

可分三层看：

### 服务层

```bash
pnpm ctl service status
```

看的是：

- 进程是否还活着
- 页面是否能打开
- 页面静态资源是否 200

### 配置层

```bash
pnpm ctl providers list --group cch
```

看的是：

- 目标 provider 是否已经写进 `check_configs`
- endpoint / model / enabled 是否符合预期

### 健康检查层

```bash
pnpm ctl providers refresh --group cch
```

看的是：

- `api/group/cch` 里每个 provider 的最新状态

## 6. 关于 `并发 Session 超限`

你看到的这类错误：

```text
Failed after 3 attempts. Last error: 并发 Session 超限：当前 3 个（限制：3 个）
```

根因不是 `check-cx` 配置错了，而是上游 provider 本身有限制：

- 同一时刻只允许最多 3 个活跃 session
- 如果这时 CCH 或其他客户端也在用这个 provider，健康检查可能正好撞上限流

### 现在的处理方式

代码里已经加入了本地退避逻辑：

- 当某个 provider 返回 `concurrent_sessions` / `rate_limit_exceeded`
- 当前轮结果会降级为 `degraded`
- 后续会进入一个冷却窗口
- 冷却期内 `check-cx` 不再反复主动探测这个 provider

冷却时间优先使用上游返回的：

- `reset_time`
- `retry-after`
- `x-ratelimit-reset`

如果上游没给，就默认 60 秒。

### 这能解决什么

- 不再因为同一次限流连续打满 3 次再每分钟重复轰炸
- 面板会更稳定，不会纯粹因为观察行为把 provider 打成一串红

### 这不能解决什么

如果上游真的长期满载，这仍然会表现为 `degraded` 或 `error`。那属于 provider 容量问题，不是本地面板问题。

### 如果它经常出现

优先按这个顺序处理：

1. 减少手工 `forceRefresh`
2. 避免同时打开多个会触发主动刷新的页面
3. 把该 provider 从主力流量里挪开
4. 提高 `CHECK_POLL_INTERVAL_SECONDS`
5. 临时 `disable` 这个 provider，等上游恢复

## 7. 常见故障

### 页面能返回 200，但只看到骨架屏 / 没有样式

先看：

```bash
pnpm ctl service status
```

如果 `cssStatus` 不是 200，说明静态资源没准备好。直接：

```bash
pnpm ctl service restart
```

当前启动脚本会自动补齐 standalone 需要的 `.next/static` 和 `public/`。

### `status` 显示 `pidSource = listener`

这表示脚本发现 PID 文件和真实监听 `24167` 的进程不一致，于是自动回落到了端口监听进程。

在当前版本里这是自动修复行为，通常执行一次：

```bash
pnpm ctl service restart
```

即可把 PID 文件重新和真实服务进程对齐。

### `pnpm build` 失败，报 Google Fonts 或 Turbopack 错误

不要直接用原始 `next build`，使用：

```bash
pnpm ctl build
```

或者：

```bash
pnpm build
```

但前提是脚本里已经是 `next build --webpack`。

### provider 已经写入，但页面没有卡片

依次检查：

```bash
pnpm ctl providers list --group cch
pnpm ctl providers refresh --group cch
pnpm ctl service status
```

通常是：

- `enabled = false`
- endpoint 写错
- model 不兼容
- 页面还没刷新到最新数据

## 8. 推荐日常流程

### 同步 CCH 并验证

```bash
pnpm ctl providers sync-cch --group cch
pnpm ctl providers refresh --group cch
pnpm ctl service status
```

### 改一个 provider 后验证

```bash
pnpm ctl providers set --group cch --name RC-chat --endpoint https://right.codes/codex/v1/chat/completions
pnpm ctl providers refresh --group cch
```

### 更新代码并重启

```bash
pnpm ctl update
pnpm ctl service status
```
