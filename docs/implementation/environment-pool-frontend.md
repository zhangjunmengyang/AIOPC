# 阶段 2 前端验证

2026-11-12。按公司环境资源池、多环境绑定和租约合同实现。前端改动未自行暂存或提交；旧知识库原型不属于本阶段。

## 已实现

| 范围 | 行为 |
| --- | --- |
| 公司资源池 | 设置中的环境页新增资源池；保留原有环境变量功能。可创建、启动、停止、删除环境；本机缺少容器引擎时保留「帮我安装」入口 |
| 项目绑定 | 一个项目可绑定多个环境。解绑回池保留 lastProject；回到同一项目保留登录。跨项目先读取服务端 409 确认信息，列出受影响账号；取消保持原绑定，确认才发送 token |
| 账号 | 项目账号列表包含全部环境及失去环境的旧账号。新增登录必须选择环境；只有一个时自动选中。已有账号的检查、授权操作按账号自身 environment 执行 |
| 环境面板 | 标签按 `environment:<envId>` 区分。多个环境先选择，再打开对应画面；绑定变更或授权失效时关闭旧画面 |
| 人工接管 | 默认观看不占租约。取得人工租约才开放 iframe 输入；显示持有人、队列、剩余时间。明确续用、交还或取消；不因观看自动续约 |

观看时使用 `inert`、负 tabIndex 和输入遮罩；真实浏览器已验证点击、键入和 Tab 焦点不能进入 iframe。接管 token 保留在宿主内存，不加入第三方画面 URL。跨域画面内的活动不可观测，因此以倒计时和明确「继续接管」续用；到期恢复观看。

主要实现位于 `apps/app/src/react-app/domains/aiopc/` 的 `environment-pool.tsx`、`environment-picker.tsx`、`environment-lease.ts`、`environment-view.tsx`、`accounts-page.tsx`。项目页、设置页和会话侧栏使用相同资源与绑定信息，不另存环境归属。

## 自动验证

在 `apps/app` 下逐文件运行 `bun test tests/<文件名>`，避免既有 DOM 和模块 mock 互相影响。

| 测试 | 通过 / 失败 | 覆盖 |
| --- | --- | --- |
| `environment-pool-client.test.ts` | 2 / 0 | 409 结构保留、不自动确认；每个环境独立面板 ID |
| `environment-pool.test.tsx` | 6 / 0 | 多环境、跨项目确认、同项目重绑、本机引擎安装入口、服务商标签、目录缺失时显示实际绑定 |
| `account-environment.test.tsx` | 2 / 0 | 多环境明确选择、项目草稿上下文；旧账号按自身环境检查 |
| `environment-lease-view.test.tsx` | 5 / 0 | 默认只读、取得与交还、到期不续约、绑定撤销关闭画面、排队沿用 requestId |
| `projects-page.test.tsx` | 2 / 0 | 项目真实文件内容、建组失败重试 |
| `project-first-send.test.ts` | 1 / 0 | 项目和角色写入先于首次消息 |
| `project-draft-context.test.ts` | 1 / 0 | 各分屏保留自己的项目目录 |
| `session-role-picker.test.tsx` | 2 / 0 | 服务端角色读回、清除、跨公司隔离 |
| `i18n-placeholders.test.ts` | 2 / 0 | 本地中英文占位符 |

共 23 条通过。新增核心行为先运行失败测试，再实现；红绿输出位于 `/tmp/aiopc-stage2-*-red.log`、`/tmp/aiopc-stage2-*-green.log`。逐文件结果与日志位于 `/tmp/aiopc-stage2-frontend-tests.json` 和 `/tmp/aiopc-stage2-<测试文件名>.log`。

```text
cd apps/app
npx tsc --noEmit -p tsconfig.json
# exit 0

cd ../..
git diff --check -- apps/app
# exit 0
```

## 真实页面验证

使用已安装的 Playwright 和真实 React 页面，连接当前 OPC HTTP 服务与租约代理。公司与 home 均在 `/private/tmp/aiopc-stage2-ui-qa/data/`；provider 是仅操作内存状态和本地 HTML 画面的假实现。没有启动 Docker、登录真实账号或发布内容。

```text
node /tmp/aiopc-stage2-ui-qa/flow.mjs
{"checks":12,"errors":[]}

node /tmp/aiopc-stage2-ui-qa/queue.mjs
{"checks":3,"errors":[]}

node /tmp/aiopc-stage2-ui-qa/lifecycle.mjs
{"checks":3,"errors":[]}
```

18 项检查通过，未出现 console error、pageerror 或 Vite 错误遮罩。换项目的预期 HTTP 409 单独记录，不计为页面错误。

- 资源池读取、创建、同项目多绑定、解绑回池、重绑同项目保留 ready 账号。
- 跨项目列出受影响账号，取消不改绑定；确认后环境进入目标项目，旧账号仍在且标为 needs_login。两个项目的环境列表、登录选择互相隔离。
- 观看时阻止输入；取得租约后可填写、点击、明确续用；交还后立即只读。第二个窗口排队、取消、再次申请；前一个交还后才取得控制，任一时刻只有一个交互窗口。
- 启动、停止读取真实 provider 状态；删除先确认，取消保留资源，确认删除后列表移除。
- 1180 × 860 与 390 × 844 截图已检查；窄屏无横向溢出。

证据目录：`/tmp/aiopc-stage2-ui-qa/`。`result.json`、`queue-result.json`、`lifecycle-result.json` 记录断言与请求；`pool-desktop.png`、`pool-mobile.png`、`rebind-confirmation.png`、`viewer-watch.png`、`viewer-control.png`、`viewer-queued.png` 为实际截图。临时 `reset.mjs` 和 `reset-identities.py` 仅恢复这套测试环境与虚构账号，便于重放。

这是页面、真实 HTTP 与租约代理的集成验收。第三方真实画面与真实账号登录未在此验证；Electron 浏览工具执行结果见 [运行时报告](stage-2-runtime-verification.md)。临时前端 5178 已关闭，后端 8979 由主代理统一关闭。
