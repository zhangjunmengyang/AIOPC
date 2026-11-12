阶段 2：运行时与环境隔离验收（2026-11-12）

浏览器操作按可信会话的 `projectId` 定位项目。界面当前选中的公司不参与定位。项目绑定多个环境时，调用方必须提供环境 ID；只有一个绑定时可以省略。浏览器连接与标签状态按 `environmentId + bindingRevision` 隔离。

| 边界 | 已验证行为 |
| --- | --- |
| 公司授权 | Electron 从 workspace store 写入规范化公司根列表；0600 文件随新增、删除及状态保存更新。Python HTTP 不接受任意调用者自行授权的目录。 |
| 会话身份 | `/runtime/session-context` 核实原生会话、公司归属、固定项目及父会话链。MCP 使用独立 scoped token；它不能调用其他 host 接口。每个运行时独立写入 0600 描述文件，退出时删除。 |
| MCP App | 宿主在最终 `tools/call._meta` 写入已验证的 `ai.opencode/sessionID`。页面工具参数中的同名字段不能覆盖宿主身份。 |
| 租约 | Electron 请求顺序是 `acquire → begin → start（必要时）→ heartbeat → end`。排队取消会清掉对应请求；心跳失效会中止正在执行的 CDP 请求。人工接管后，AI 必须重新获得租约才能继续。 |
| 人工步骤 | `browser_handoff` 申请最长 600 秒的等待保留。原生回合结束不清除这类等待；界面提供显式接管、交还。 |
| 生命周期 | 宿主独立订阅 v1 `/global/event` 和 v2 `/api/event`，无需聊天页面在线。回合结束、停止、归档及删除触发释放；停止运行时先释放，再退出 OPC HTTP。迟到的释放携带 `observedAt`，并在普通回合结束时核对当前原生 idle 状态。 |
| 删除后的清理 | 已删除会话仍可凭原操作的随机令牌结束短操作锁。令牌同时绑定环境、运行时及会话；该路径不能申请或续租，不能清理其他会话。 |

实际执行的检查：

| 工作目录 | 命令 | 结果 |
| --- | --- | --- |
| `apps/desktop` | `node --test electron/aiopc-service.test.mjs electron/sandbox-browser.test.mjs` | 12 项通过 |
| `apps/desktop` | `node scripts/check-electron-bridge.mjs` | 33 个 renderer 方法覆盖完整 |
| `apps/desktop` | `node --check electron/main.mjs` | 通过 |
| `apps/desktop` | `pnpm --dir ../server exec tsc -p ../desktop/tsconfig.electron.json --noEmit` | 通过 |
| `apps/server` | `bun test test/runtime-session-context.test.ts test/aiopc-lease-lifecycle.test.ts test/mcp-app-launch-session.test.ts test/browser-environment-tools.test.ts` | 11 项通过 |
| `apps/server` | `bun test test/opencode-v2-mcp-readiness.test.ts` | 5 项通过 |
| `apps/server` | `node --import tsx --test test/company-session-native.test.ts` | v1、v2 原生验收通过 |
| `apps/server` | `npx tsc --noEmit -p tsconfig.json`、`pnpm build` | 均通过 |
| `services/opc` | `UV_PROJECT_ENVIRONMENT=~/.aiopc/venv uv run python -I -m pytest -q tests/test_environment_cleanup.py tests/test_sandbox_leases.py tests/test_environment_api.py` | 21 项通过；新增清理用例先失败再修复 |
| `services/opc` | `UV_PROJECT_ENVIRONMENT=~/.aiopc/venv uv run ruff check aiopc/sandbox/leases.py tests/test_environment_cleanup.py` | 通过 |

原生验收启动已安装的 v1、v2 二进制，使用临时 HOME、XDG、数据库与公司目录，模型请求只发给本地替身。两代引擎都验证了项目 cwd、公司 home、恢复列表、fork 分组和角色、技能边界；新增断言验证真实回合结束与真实会话删除会触发后台租约释放。没有调用外部模型，也没有使用真实账号。

主代理另完成三项真实 Docker 浏览器验收：同一项目的两个 Chromium cookie jar 独立；浏览器保持运行时，解绑后重新绑定同项目保留两份登录态；确认跨项目重新绑定后，只清除目标环境的旧 profile，另一个环境保持不变。临时容器和 profile 已清理，现有小红书环境未改动。证据为 `/tmp/aiopc-stage2-browser-verify.log`。

本报告的运行日志：`/tmp/aiopc-phase2-desktop-focused.log`、`/tmp/aiopc-phase2-server-focused.log`、`/tmp/aiopc-phase2-native-lifecycle.log`、`/tmp/aiopc-phase2-readiness.log`、`/tmp/aiopc-phase2-server-build.log`、`/tmp/aiopc-environment-cleanup-green.log`。v1 原生 MCP 元数据补丁、可重复构建及原生 MCP 调用证据由独立验收报告记录。

本轮没有重启用户正在使用的 OPC 服务或发布草稿环境，没有真实发布。第三方 live-view 继续使用提供方原有画面；人工输入边界由界面遮罩、显式接管及租约控制，本报告未逐家验收第三方 viewer 的输入事件。

收尾独立审查补充：公司根现在由授权列表明确匹配并随 Workspace 传递，所有精确公司根优先于“某公司的直接项目”。公司目录本身位于名为 `projects` 的目录下时，不会被误判为另一个公司的项目。授权根或原绑定目录被换成符号链接时，修改会在 provider 与 registry 变化之前被拒绝。旧资源迁移也优先使用受保护的公司授权记录，保留原容器及 profile。

同项目并发绑定的 registry 读取与 `environments.json` 写入使用同一短锁，避免旧快照覆盖新绑定。自定义 CDP 地址按主机名大小写和尾斜杠归一化，并在独立跨进程锁内完成重复检查、凭据保存及资源登记；钥匙串失败不会留下半个资源。此处不进行网络探测，不能识别不同 DNS 名或不同入口实际指向同一浏览器的情况。

上述问题均先用临时目录、内存钥匙串及真实 HTTP 路由复现，再添加回归。命令 `UV_PROJECT_ENVIRONMENT=~/.aiopc/venv uv run python -I -m pytest -q tests/test_manual_environment_creation.py tests/test_environment_boundaries_review.py tests/test_environment_pool.py tests/test_environment_api.py tests/test_environment_cleanup.py tests/test_company_scope_review.py` 得到 41 项通过，日志 `/tmp/aiopc-pool-final-focused.log`；涉及文件 Ruff 与 `git diff --check` 均通过。没有触碰用户 home 或连接真实 CDP。

同一环境、同一平台登录另一身份后，旧账号立即标为需登录；历史、接口配置与其他环境账号保留。发布审批发现浏览器身份不符时，更新旧账号状态并拒绝填写。无法自动检测身份的平台仍显示无法自动确认。
