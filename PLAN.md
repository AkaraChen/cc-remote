# cc-remote 架构方案

> `cc-remote` 是一个 ACP agent：模型在远端（登录好 Claude Code 的服务器）跑，
> 文件和 shell 工具在本机跑。一个二进制，一个 ssh host，没有守护进程，没有自定义协议。
> 任何 ACP 客户端（Zed、paseo……）都能直接用。

## 1. 架构

```
本机                                                     服务器
┌────────────────────────────────────────┐   ssh -T    ┌──────────────────────┐
│ ACP 客户端 (Zed / paseo / …)            │            │ claude (已登录)        │
│   ⇅ ACP over stdio                      │            │  stream-json 控制协议  │
│ cc-remote                               │  stdin/    │  模型 + 系统提示 + 会话 │
│  ├ claude-agent-acp（库，打一处补丁）   │  stdout    │  + WebSearch/Agent/…   │
│  │   query() options ─ transform ─┐     │ ─────────► │                      │
│  ├ spawnClaudeCodeProcess = ssh   │     │ ◄───────── │                      │
│  ├ proxy：双向改写协议流          │     │            │                      │
│  ├ in-process MCP "cc"：          │     │            │                      │
│  │   Read/Write/Edit/Bash/Glob/   │     │            │                      │
│  │   Grep/NotebookEdit 本机执行   │     │            │                      │
│  ├ 客户端 MCP 桥接（本机连接）    │     │            │                      │
│  └ sessionStore：会话镜像回本机   │     │            │                      │
└────────────────────────────────────────┘            └──────────────────────┘
```

服务器端只需要已安装并登录的 `claude`。本机不需要 `claude`。

ACP 这一层（会话、权限请求、AskUserQuestion、diff/终端渲染、模式、模型、fork、标题……）
全部由 [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp) 负责。
cc-remote 只做一件事：让它启动的 `claude` 跑到服务器上，而工具留在本机。

## 2. 对 claude-agent-acp 的补丁

`patches/@agentclientprotocol%2Fclaude-agent-acp@<ver>.patch`（`bun patch`），只加一个钩子：

```js
export function setQueryOptionsTransform(transform) { … }
// createSession 里唯一的 query() 调用：
query({ prompt: input, options: queryOptionsTransform ? await queryOptionsTransform(options) : options })
```

new/load/resume/fork、退出计划模式后重建、v1/v2 协议，全部经过这一处。
`@anthropic-ai/claude-agent-sdk` 锁定为 claude-agent-acp 依赖的同一版本，只保留一份 SDK。

## 3. options 变换（`src/options.ts`，每个会话一次）

| 字段 | 处理 |
|---|---|
| `spawnClaudeCodeProcess` | `ssh host 'mkdir -p D && cd D && exec env … claude <args>'`，经 `proxy` 包装 |
| `mcpServers` | 客户端给的 stdio/http/sse 全部桥接为本机 sdk server；加上本机工具 `cc`（按会话 cwd 创建） |
| `toolAliases` | `Bash → mcp__cc__Bash` 等，模型按内置名调用 |
| `disallowedTools` | + 12 个碰本机 fs/shell 的内置工具（见 `names.ts` 的 `REMOVED`） |
| `allowedTools` | + `mcp__cc__Read/Glob/Grep`：claude 对任何 MCP 工具都会询问，对自己的读工具不会 |
| `systemPrompt` | preset 加 `excludeDynamicSections`，`append` 本机环境、git 状态、本机 CLAUDE.md；`CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` |
| `additionalDirectories` | 清空（远端没有这些路径），写进提示 |
| `hooks` | matcher 里的 `Edit|Write` 等扩展出带前缀的名字 |
| `sessionStore` | 本机镜像（见 §5） |

## 4. 协议流代理（`src/proxy.ts`）

包在 ssh 子进程的 stdin/stdout 上，逐行处理：

- **claude → SDK**：本机工具去掉 `mcp__cc__` 前缀（claude-agent-acp 按 `Edit`、`Bash` 渲染 diff 和终端，
  hook 输入、权限请求也一样）；服务器镜像目录改写为本机 cwd；`transcript_mirror` 帧的 `filePath`
  改到本机 projects 目录（SDK 按它算 SessionKey，否则丢弃）。
- **SDK → claude**：权限回复里本机工具的规则补回前缀；跟踪 `--permission-mode`、`set_permission_mode`、
  回复里的 `setMode`。
- **代答权限**（claude 只对自己的内置工具做的事）：
  - acceptEdits 下，cwd 内的 Edit/Write/NotebookEdit 直接放行；询问时建议"本会话接受编辑"。
  - Bash：claude 对 MCP 工具只会建议放行整个工具。改为建议命令前缀（`npm test:*`），批准的前缀
    留在 cc-remote 进程里（按 cwd），之后匹配的命令直接放行；带 `; & | < > $( 反引号 换行` 的命令永不自动放行。

## 5. 会话

- 服务器：镜像空目录 `~/.cc-remote/ws/<本机hostname>/<本机绝对路径>/`，会话文件和 `--resume` 有稳定归属。
- 本机：SDK 的 `sessionStore`（alpha）。claude 每写一条记录都经协议回传（`--session-mirror`），
  `append()` 写到 `~/.claude/projects/<本机 cwd>/<id>.jsonl`，内容已经过 proxy 改写。`load()` 返回空，
  SDK 不会在本地物化临时文件。claude-agent-acp 的列表、历史回放、fork、标题都读本地文件，因此直接可用。
  claude 自己的内部记录（api-request、cost-state）不镜像，不影响回放。
- 恢复服务器上没有的会话（fork 出来的、本地 claude 写的）：spawn 前另开一次 ssh 把本地 jsonl 上传，
  远端已有同名文件则不覆盖。项目目录名在远端用 `pwd -P | sed` 计算（路径超过 200 字符时 claude 会加哈希，此情况不支持）。

## 6. 其他

- **入口**（`src/main.ts`）：默认在 stdio 上提供 ACP（复用 claude-agent-acp 的 `serveAcp`）；
  `--cli <args>` 在服务器上执行 `claude <args>`；`doctor`；`--version`。
- **`CLAUDE_CODE_EXECUTABLE`**：指向一个调用 `cc-remote --host H --cli` 的小脚本。claude-agent-acp
  自己执行的 `claude auth status`、`auth logout` 因此落到服务器上。
- **ssh**：默认 `ControlMaster=auto`、`ControlPersist=10m`，多会话和探测共用一条连接；`CC_REMOTE_SSH` 可整体替换。
  每条连接加 `-o ServerAliveInterval=15 -o ServerAliveCountMax=3`（`CC_REMOTE_SSH` 是 ssh 时追加在其后，其中更早的同名 `-o` 优先），
  死链约一分钟内失败而不是挂住。不用 `autossh`：它断线后会新开一条 ssh、再起一个 `claude`，而这条 stream-json 会话对不上。
  SDK 和 ACP 加给子进程的环境变量经 `env K=V` 带过去（`CLAUDE_CONFIG_DIR` 除外）。
- **工具**：每个会话一份（`localTools(cwd)`），Bash 的 cwd 跨调用保持且按会话隔离；后台命令随 cc-remote 退出被清理。
- **服务器设置**：`settingSources` 由 claude-agent-acp 决定（user/project/local）。服务器上的 user 设置、skills、MCP 生效；
  project/local 指向空镜像目录。本机项目的 `.claude/` 目前不同步到服务器。

## 7. 已知限制

- Bash 的"不再询问"只在 cc-remote 进程存活期间有效，不写入设置文件。
- 文件检查点 / `rewind_files` 由服务器上的 claude 记录，看不到本机文件改动。
- 本机项目级 `.claude/`（commands、skills、agents、settings）不会被服务器上的 claude 读到。
- 桥接的客户端 MCP 只转发 tools，不转发 resources/prompts。

## 8. 测试

`bun test`：工具、改写规则、Bash 规则、ssh 引号。端到端用假的 `CC_REMOTE_SSH`（忽略 host，在本机以另一个 HOME
执行远端命令）加一个最小 ACP 客户端，验证过：读/编辑/Bash/客户端 stdio MCP、权限请求与 acceptEdits、
Bash 前缀放行、会话镜像、list/load/resume、远端缺会话时上传、编译后的二进制。
