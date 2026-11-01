# cc-remote 架构方案

> `cc-remote` 是 `claude -p` 的替身：模型在远端（登录好 Claude Code 的服务器）跑，
> 文件和 shell 工具在本机跑。像 rsync：一个二进制，一个 ssh host，没有守护进程，没有自定义协议。

## 1. 架构

```
本机                                        服务器
┌──────────────────────────────┐            ┌────────────────────────┐
│ cc-remote (bun compile)      │  ssh -T    │ claude (已登录)         │
│  ├ Claude Agent SDK query()  │ ─────────► │  --output-format        │
│  │   spawnClaudeCodeProcess  │  stdin/    │    stream-json          │
│  │   = ssh host claude ...   │  stdout    │  --input-format         │
│  ├ in-process MCP server     │ ◄───────── │    stream-json          │
│  │   Read/Write/Edit/Bash/   │  SDK 自带  │  模型 + 系统提示 + 会话   │
│  │   Glob/Grep 本机执行       │  控制协议   │  + WebSearch/Agent/…    │
│  └ 按 claude -p 格式打印      │            │                        │
└──────────────────────────────┘            └────────────────────────┘
```

服务器端只需要已安装并登录的 `claude`，不需要任何 cc-remote 的东西。

SDK 和 `claude` 本来就是两个进程通过 stdin/stdout 用控制协议说话：启动时 SDK 发
`initialize` 把工具清单（名字、描述、schema）交给 `claude`；模型调工具时 `claude` 发
`control_request`（MCP `tools/call`），SDK 在本进程执行 handler 后回 `control_response`。
我们做的唯一一件事是让这两根管子变成 ssh 的 stdin/stdout。`claude` 不知道对面隔着网络。

用到的 SDK 能力：

| 选项 | 作用 |
|---|---|
| `spawnClaudeCodeProcess` | 返回 `ssh -T host claude <args>` 子进程 |
| `createSdkMcpServer` + `tool()` | 本机工具，`alwaysLoad: true` 让 schema 常驻不被 tool search 延迟 |
| `disallowedTools: [12 个本机工具]` | 从模型上下文移除内置的本机工具，其余服务端工具照用 |
| `toolAliases: { Bash: "mcp__cc__Bash", … }` | 模型按内置名发 `Bash` 时也路由到我们的工具 |
| `verbatimPrompts: true` | 用户 prompt 原样送达（要求 claude ≥ 2.1.248） |

已验证（`/tmp/sdkprobe/probe2.ts`，SDK 0.3.316 + claude 2.1.314）：默认工具集保留、摘掉本机工具、
别名生效、`mcp__cc__Bash` 在本进程执行并正确返回。

从 opencode v2 的 `claude-agent` provider 借鉴：`alwaysLoad`、`verbatimPrompts` 及其版本门槛。

## 2. 仓库结构（目标 ~1000 行）

```
cc-remote/
  package.json            # bun, @anthropic-ai/claude-agent-sdk, zod
  src/main.ts             # 入口：解析参数 → 组 Options → query() → 打印 → exit code
  src/permissions.ts      # 规则解析与匹配、canUseTool（/dev/tty 询问）、deny hook
  src/prompt.ts           # append：本机 cwd、git 状态、CLAUDE.md
  src/args.ts             # claude -p 参数子集（显式白名单，未知参数报错）
  src/ssh.ts              # spawnClaudeCodeProcess：ssh -T -o BatchMode=yes host -- '…'
  src/names.ts            # strip()/prefix()：mcp__cc__ 前缀只存在于 claude 和 SDK 之间
  src/tools/index.ts      # createSdkMcpServer({ name: "cc", tools, alwaysLoad: true })
  src/tty.ts              # 经 /dev/tty 提问（Bun.file），无终端返回 null
  src/tools/{read,write,edit,bash,glob,grep,notebook}.ts   # 每个文件 = schema + description + handler
  test/                   # 工具、规则、引号的单测；端到端用 ssh localhost 手测
```

## 3. 工具

### 3.1 本机实现（schema 与内置工具一致）

| 工具 | 输入 | 实现 |
|---|---|---|
| Read | `file_path, offset?, limit?` | `cat -n` 风格行号；图片返回 image block；`.ipynb` 渲染为带 id 的 cell 和输出，输出里的图片也是 image block |
| Write | `file_path, content` | 自动建目录 |
| Edit | `file_path, old_string, new_string, replace_all?` | 精确替换，唯一性检查，错误文案与内置一致 |
| Bash | `command, timeout?, description?, run_in_background?` | `Bun.spawn` 独立进程组，cwd 跨调用保持，默认 120s 最长 10 分钟，stdout+stderr 合并，大输出截断；`run_in_background` 输出写到临时文件，返回 ID 和文件路径，会话结束时停止 |
| NotebookEdit | `notebook_path, cell_id?, new_source, cell_type?, edit_mode?` | replace / insert / delete；cell id 用 notebook 自带的 `id`，没有则为 `cell-N`；替换代码 cell 时清空输出 |
| Glob | `pattern, path?` | `Bun.Glob`，按 mtime 排序 |
| Grep | `pattern, path?, glob?, output_mode?, -i/-n/-A/-B/-C, head_limit?, multiline?, type?` | 优先本机 `rg`，无则 `grep -r` |

### 3.2 全部内置工具的归属（SDK `BUILTIN_TOOL_NAMES`，55 个）

**A. 碰本机 fs/shell → `disallowedTools`，12 个**

| 工具 | 状态 |
|---|---|
| Read Write Edit Bash Glob Grep | v1 重写 |
| NotebookEdit | 已重写 |
| LSP Monitor EnterWorktree ExitWorktree PowerShell | 禁用 |

**B. 留在服务端，零本机副作用 → 原样保留**

| 类别 | 工具 | 备注 |
|---|---|---|
| 网络 | WebSearch WebFetch | 走服务器网络 |
| 子代理 | Agent(Task) Workflow SubagentHandback SendMessage ListAgents | 子代理共享同一份工具表，其 Read/Bash 也落本机 |
| 任务 | TodoWrite TaskCreate TaskGet TaskList TaskUpdate TaskStop | 会话内状态 |
| 技能 | Skill ToolSearch | 用服务器 `~/.claude/skills` |
| MCP | ListMcpResourcesTool ReadMcpResourceTool ReadMcpResourceDirTool WaitForMcpServers | 服务器上配的 MCP server 直接可用 |
| 调度 | ScheduleWakeup CronCreate CronDelete CronList | `-p` 本就支持 |
| 计划模式 | EnterPlanMode ExitPlanMode | 计划文件在服务器 `~/.claude`；ExitPlanMode 走 canUseTool |
| 其他 | ReportFindings EndConversation | 输出型 |

**C. 需要人回答 → 本机 TTY：** AskUserQuestion。claude 把它交给 `canUseTool`，我们在 `/dev/tty` 列出选项，
答案按 `{问题原文: label}` 回传，多选用逗号拼接，也可直接输入文字。启动时没有终端就把它放进 `disallowedTools`，
与 `claude -p` 无宿主时隐藏它一致。`bypassPermissions` 下也照常传 `canUseTool`，因为 AskUserQuestion 仍会来问；
SDK 对此的 `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` 警告被精确过滤。

**D. 绑定 claude.ai / 桌面 / 云，`-p` 下自动不出现：** Artifact ClaudeDesign DesignSync
OfferChromeSetup Projects propose_skills ProposeGoal PushNotification ReadNotifications
RemoteTrigger SendFeedback SendUserFile SendUserMessage ShareOnboardingGuide ShowOnboardingRolePicker

**防漏网：** `system/init` 的 `tools[]` 与 SDK 的 `BUILTIN_TOOL_NAMES` 比对，不认识的名字在 `--verbose` 时警告。
远端 claude 通常比内嵌 SDK 新（实测 2.1.314 多出 `DesignSync`），默认警告会成为每次运行的噪音。

### 3.3 工具名前缀

`mcp__cc__` 是 `claude` 给所有 MCP 工具加的固定前缀，无法关闭。`src/names.ts` 两头抹平：

- 出站 `strip()`：打印前去掉 `assistant.content[].tool_use.name`、`system/init.tools[]`、
  `result.permission_denials[].tool_name`、`stream_event.content_block_start.tool_use.name` 的前缀。
  下游拿到的 stream-json 与真 `claude -p` 字节级一致。
- 出站还把 `system/init.cwd` 改写成本机目录。
- 入站：`canUseTool` 和 deny hook 收到的名字先去前缀再匹配用户规则。

## 4. 设计决定

**cwd。** ssh 不带 cwd，而 `claude` 会把自己的 cwd 和 git 状态写进系统提示。
服务器上用镜像空目录 `~/.cc-remote/ws/<本机hostname>/<本机绝对路径>/`，只为让会话文件和
`--continue` 有稳定归属；spawn 命令 `mkdir -p D && cd D && exec claude …`。
**系统提示。** SDK 只有两种形态：`preset: "claude_code"` + `append`，或 `type: "custom"` 整个替换；
没有对默认提示做 search & replace 的接口，默认提示文本也不对外暴露。选 preset + append：
`{ type: "preset", preset: "claude_code", excludeDynamicSections: true, snapshot: true, append }`。
`excludeDynamicSections` 把 cwd / git 状态 / 记忆路径这些按机器生成的段落从系统提示里挪到第一条用户消息，
系统提示本身就是静态的 Claude Code 默认提示；`append` 里写明真实 cwd 和 OS，并追加本机 CLAUDE.md。
镜像目录是空目录，没有 git，所以不会生成服务器端 git 状态。
设 `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` 不读服务器端 CLAUDE.md；本机 CLAUDE.md（cwd 及父目录、`~/.claude/CLAUDE.md`）
按 claude 的发现规则读出，v1 就注入 `append`。

**权限。** 执行在本机，TTY 也在本机。`--permission-mode` 透传；`canUseTool` 在本机实现：通过 `/dev/tty` 问用户
（stdout 被管道接走也能问，可答 y / n / always），完全无终端时按 `claude -p` 规则拒绝。
- allow 规则：裸名和本机工具的作用域规则（`Bash(git *)`、`Edit(src/**)`）都在 `canUseTool` 里匹配。
  裸名不交给 claude，否则 claude 直接放行、绕过 `canUseTool`，SDK 也会警告。
  只有远端工具的作用域规则（`WebFetch(domain:x)`）交给 claude 匹配。
- deny 规则：裸名进 `disallowedTools`（本机工具加前缀）；本机工具的作用域规则走 `PreToolUse` hook，
  在 `bypassPermissions` 下也生效。
- `--dangerously-skip-permissions` → `bypassPermissions`，此时不传 `canUseTool`。

**服务器设置。** 服务器是用户自己登录的机器，`settingSources` 用默认（user），服务器上的 settings、skills、MCP 都生效。

**版本。** 客户端内嵌 SDK 0.3.x，远端 `claude` ≥ 2.1.248。从 `system/init.claude_code_version` 校验，低了报错。`cc-remote doctor` = `ssh host claude --version` + 工具表比对。

**ssh。** `$CC_REMOTE_SSH -T host '<shell-quoted 命令>'`（默认 `ssh`，像 rsync 的 `RSYNC_RSH`）；
无 tty 所以 stdout 干净，密码提示走 `/dev/tty` 不受影响；远端 stderr 原样转发。
SDK 给子进程加的环境变量（实测 `CLAUDE_CODE_SDK_READS_SESSION_STATE`）经 `env K=V` 显式带过去。

**Ctrl-C。** 不做 `interrupt()`：SIGINT 到达整个前台进程组，ssh 断开，远端 claude 几秒内自行退出，
会话已存盘，`-c` 可接着来。本机 Bash 命令跑在独立进程组（超时才能杀掉整棵子进程树），
所以退出时由 `killAll()` 清理。已用伪终端发真实 Ctrl-C 验证无残留。

**host。** `--host box` / `CC_REMOTE_HOST` / `~/.config/cc-remote/host`（一行文本），优先级从左到右。
端口、密钥、跳板全写 `~/.ssh/config`。典型用法 `alias claude=cc-remote`。

**打包。** v1 三个目标：`bun-linux-x64`、`bun-linux-arm64`、`bun-darwin-arm64`。
`pathToClaudeCodeExecutable: "claude"` 只填进 `SpawnOptions.command`，SDK 自带的平台 cli 包不用；需确认不被打进单文件。

## 5. 参数对照（`claude -p` 子集）

透传给 SDK：`--model` `--effort` `--permission-mode` `--allowedTools` `--disallowedTools`
`--append-system-prompt` `--system-prompt` `--max-turns` `--max-budget-usd` `--json-schema`
`--continue` `--resume` `--session-id` `--dangerously-skip-permissions` `--verbose`。

`-p` 隐式：`cc-remote "fix tests"` 等价于 `claude -p "fix tests"`，带不带 `-p` 都行。

本机处理：`--output-format text|json|stream-json`、`--input-format text|stream-json`
（stdin NDJSON 作为 `AsyncIterable<SDKUserMessage>` 喂给 query，多轮天然支持）、
`--include-partial-messages`、`--host`、`--version`、`doctor`。

输出：`stream-json` 每条 SDK 消息 strip 后原样一行；`json` 打印 `result` 消息；`text` 打印 `result.result`。
退出码：result 成功 0，否则 1。

`--add-dir`：本机目录，写进 append 的环境段落，不传给远端 claude（远端没有这些路径；本机工具本来就不限目录）。

不支持（报错）：交互模式、`--mcp-config`、`--bg`、`--cloud`。

## 6. 实施步骤

1. **骨架**（半天）：probe2 搬进 `src/`，spawn 换成 ssh，只带 Bash，text 输出，跑通一次真实远程调用。
2. **六个工具**（1 天）：schema 对齐、`toolAliases`、`alwaysLoad`、`names.ts`、单测。
3. **参数与输出**（1 天）：`args.ts`、三种输出、stream-json 输入、resume/continue、退出码。
4. **cwd / 系统提示 / 权限**（1 天）：镜像目录、append、本机 CLAUDE.md 注入、`canUseTool` TTY、规则匹配。
5. **打包与体验**（半天）：三平台 compile、`doctor`、README（安装 = 下载一个文件 + 写一行 host）。
6. **补齐**：Read 图片与 notebook、NotebookEdit、AskUserQuestion、`--add-dir`、后台 Bash。均已完成并端到端验证。

**Bun 优先。** 能用 Bun 全局 API 的地方不用 `node:` 模块：`Bun.file`（读写、stat、lastModified、/dev/tty）、
`Bun.spawn`（Bash、Grep）、`Bun.$`（git、uname）、`Bun.Glob`、`Bun.env`、`Bun.which`。保留的 `node:` 导入只有 Bun 没有对应物的：
`node:path`、`node:util` 的 `parseArgs`、`node:os` 的 `hostname`、ssh 模块的 `node:child_process`（SDK 要求 Node 风格的流）。
