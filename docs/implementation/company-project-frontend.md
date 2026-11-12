# 阶段 1 前端验证

2026-11-12。按 `docs/design/01-company-project-role-knowledge.md` 的 4.1–4.4 及项目标题规则实施。按用户后续决定，会话创建后固定所属项目，不支持跨项目移动；此决定优先于旧 4.6 的迁移方案。未提交。

## 已实现

| 范围 | 行为 | 主要文件（相对 `apps/app/`） |
| --- | --- | --- |
| 项目分组 | `proj:<名>` 保持稳定；项目组不可改名、删除；组上的「+」保留 groupId；未分组改为公司级会话 | `domains/session/sidebar/session-management-store.ts`、`app-sidebar.tsx`（均位于 `src/react-app/`） |
| 会话目录 | 创建时按项目组传 `W/projects/<名>`；恢复时读取服务端 `sessionMeta.projectId`，推导执行目录，公司 home 保持 W；分屏草稿、文件、技能、角色发现使用各自项目目录 | `src/react-app/domains/aiopc/company-project.ts`、`shell/session-route.tsx`、`domains/session/chat/new-task-project-context.ts` |
| 角色绑定 | PATCH 服务端 sessionMeta；收到成功响应才更新；localStorage 仅缓存。服务端已加载后，缺失绑定及 `{}` 清除记录都不会被旧缓存覆盖 | `src/app/lib/openwork-server.ts`、`src/react-app/shell/use-session-group-sync.ts`、`domains/session/surface/session-mode-memory.ts` |
| 首次发送 | 先持久化项目分组和选中的角色。写入失败可重试元数据，不重复创建会话 | `src/react-app/domains/session/chat/pending-conversation-store.ts` |
| fork | 服务端登记实际项目和继承角色；前端只 GET 并消费快照，不再复制、覆盖服务端状态。读取失败只重试快照，不重复 fork | `src/react-app/shell/session-route.tsx`、`domains/session/sidebar/session-management-store.ts` |
| 固定项目 | `projectId` 是服务端权威事实；项目分组是派生显示，缓存不另存已知项目的 assignment。创建后禁止项目间、项目与公司间移动；未发送草稿仍可选择目标，公司级会话保留普通分组整理 | `src/react-app/domains/aiopc/company-project.ts`、`session-management-store.ts`、`session-menu-actions.tsx`、`shell/command-palette.tsx` |
| 总览入口 | 侧栏项目入口、工作区菜单均可进入总览；点击项目标题打开详情，左侧箭头单独折叠，原有「+」仍在项目内新建会话 | `src/react-app/domains/session/sidebar/app-sidebar.tsx`、`shell/session-route.tsx` |
| OPC 页面 | 知识库、账号页保留当前项目；「交给 AI」回到该项目草稿，保留来源路径。使用服务端 canonical home 识别 `/tmp` 与 `/private/tmp` 等路径别名 | `src/react-app/shell/session-route.tsx`、`domains/aiopc/company-project.ts` |
| 项目总览 | 可直接访问 `/workspace/:workspaceId/projects/:projectName?`。创建项目后同步稳定分组；简介来自项目记录，阶段目标来自 CONTEXT.md，近期交付物来自真实 content 文件；置顶复用已有收藏记录 | `src/react-app/domains/aiopc/projects-page.tsx`、`aiopc-client.ts`、`shell/workspace-routes.ts` |

阶段 1 验收时，项目总览的环境区域为占位；后续已接入阶段 2 的多环境资源池，见 [环境池前端验证](environment-pool-frontend.md)。没有增加目标、阶段或置顶资料的独立数据模型。

## 自动验证

工作目录为 `apps/app`。每个测试文件单独启动 Bun，避免已有测试对全局 DOM、localStorage 和模块 mock 的影响。

```text
bun test tests/<文件名>
```

| 测试文件 | 通过 / 失败 | 验证内容 |
| --- | --- | --- |
| `project-draft-context.test.ts` | 1 / 0 | 分屏草稿保留用户选择，切换到自己的项目 client、cwd 和发现接口 |
| `project-first-send.test.ts` | 1 / 0 | 分组、角色先写入；失败重试不重建会话 |
| `project-session-engine.test.ts` | 2 / 0 | v2 的 home 与执行目录分离；角色列表请求携带项目目录 |
| `project-sidebar.test.tsx` | 5 / 0 | 项目只读、定向新建、标题与折叠独立；空闲、运行、等待权限时均拒绝跨项目拖拽 |
| `project-skills-client.test.ts` | 2 / 0 | 技能 list/content 的目录参数；角色清除的 PATCH 合同 |
| `projects-page.test.tsx` | 2 / 0 | 总览只显示已有文件内容；组同步失败不重复建项目 |
| `company-project-context.test.ts` | 5 / 0 | 稳定目录、路径边界、canonical home、OPC 项目上下文 |
| `session-role-metadata.test.ts` | 6 / 0 | 服务端权威状态、清除、失败写入、跨公司、稳定项目组、fork 只消费服务端元数据 |
| `session-role-picker.test.tsx` | 2 / 0 | React 角色控件重载读回、清除墓碑、跨公司隔离、等待服务端确认 |
| `session-management-store.test.ts` | 9 / 0 | 原有分组行为及项目只读、角色快照保留 |
| `use-workspace-route-state.test.tsx` | 18 / 0 | 原有会话路由、恢复、切引擎，以及项目路由公司切换与回落 |
| `i18n-placeholders.test.ts` | 2 / 0 | 重复占位符及字面量替换 |
| `session-project-move.test.ts` | 3 / 0 | 服务端项目权威；已创建会话禁止改项目；公司级普通分组保留 |
| `session-menu-actions.test.tsx` | 13 / 0 | 原有菜单与命令面板动作；项目目标禁用、未发送草稿可选目标 |
| `chat-file-context.test.tsx` | 37 / 0 | 原有文件链接解析、上下文与不存在文件处理不变 |

最近一次针对验证的实际汇总：

```text
focused files: 15 failures: 0
108 tests passed
```

输出保存在 `/tmp/aiopc-stage1-fixed-<测试文件名>.log`；汇总为 `/tmp/aiopc-stage1-fixed-tests.json`。核心新增行为先运行失败测试，再写实现；对应失败证据为 `/tmp/aiopc-stage1-*-red.log`。

服务端 fork 自动登记对接后，已撤掉前端重复写入，并再次运行 `session-role-metadata.test.ts`（6 pass）、`session-role-picker.test.tsx`（2 pass）、`session-management-store.test.ts`（9 pass）及 typecheck，均无失败。新的 fork 测试明确禁止调用 assignment/role 写接口，验证前端按服务端实际项目和角色读回。

此前已逐文件运行 `tests/*.test.ts` 和 `tests/*.test.tsx`，实际输出：

```text
RESULT 134 passed files; 1 failed files
```

共 135 个文件。唯一失败为旧 `i18n-placeholders.test.ts` 引用了已删除的云端文案；改为现存本地重复占位符文案后单独复测：`2 pass / 0 fail`。之后的目录、角色、路由改动使用上表针对回归；没有重复运行无关全量。

```text
cd apps/app
npx tsc --noEmit -p tsconfig.json
# exit 0，无错误输出

cd ../..
git diff --check -- apps/app
# exit 0，无错误输出
```

## 真实页面验证

当前会话未提供 Browser 插件，使用已安装的 Playwright runtime。没有安装依赖或连接真实用户浏览器。

- 前端：临时 Vite harness，`http://127.0.0.1:5178/qa`。
- 后端：当前 OPC 源码，端口 8978；使用独立 home 和临时公司 `/tmp/aiopc-stage1-ui-qa/company`。
- 页面：实际 ProjectsPage 与 SpacePage；项目创建、简介、文件目录与知识库读取调用真实 HTTP API。分组同步、创建会话回调在 harness 中记录，由上面的客户端、store、路由测试单独验证。
- 尺寸：1280 × 900、390 × 844。

```text
node /tmp/aiopc-stage1-ui-qa/flow.mjs
UI checks: 7 console/page errors: 0
Project API calls: 18 failed responses: 0
```

通过的交互：创建 Alpha 和 Beta；读取 Alpha 的 CONTEXT 阶段目标与真实 content 文件；Beta 不显示 Alpha 的目标、交付物；新会话回调携带 `proj:Alpha` 与实际目录；知识库「交给 AI」携带 Alpha 的来源路径。页面有有效内容，无 Vite 错误遮罩；390px 下没有横向溢出。

证据：

- [Alpha 项目总览](/tmp/aiopc-stage1-ui-qa/alpha-overview.png)
- [Beta 窄屏总览](/tmp/aiopc-stage1-ui-qa/beta-mobile.png)
- [知识库交给 AI](/tmp/aiopc-stage1-ui-qa/alpha-knowledge-ask.png)
- [交互结果与请求记录](/tmp/aiopc-stage1-ui-qa/result.json)
- [Playwright 脚本](/tmp/aiopc-stage1-ui-qa/flow.mjs)

已关闭临时 5178、8978 服务。未操作已登录账户、真实用户项目或发布稿。此项是模块与真实 API 验收，不是完整 Electron 启动、实际引擎发消息或桌面重启验收。

## 固定归属交互验证

```text
node /tmp/aiopc-stage1-move-ui-qa/check.mjs
UI checks: 7 console/page errors: 0
```

使用实际 GroupedSessionList、会话原生拖拽、菜单和 CommandPalette，状态由真实 store 消费受控的服务端响应。此 harness 不启动原生引擎；服务端拒绝规则由后端测试验证。

验证项目标题打开总览、箭头独立折叠、空闲/运行/等待权限均拒绝跨项目拖拽、公司到项目拖拽拒绝、项目会话移动菜单禁用、命令面板禁用；公司级会话拖到普通 Notes 分组可成功且 `projectId` 仍为 null。

证据目录：`/tmp/aiopc-stage1-move-ui-qa/`。`result.json` 记录实际检查与 console/pageerror，`fixed-project-menu.png`、`fixed-project-palette.png`、`fixed-project-desktop.png` 为浏览器截图。

已关闭本次临时 5178 服务，截图已等待开场动画结束。

本轮曾为迁移尝试的逐消息历史 cwd 投影和队列动态目录适配已经精确撤回。`global-queue-drainer.ts`、`usechat-adapter.ts`、`session-sync.ts`、`message-list.tsx`、`target-provider.ts` 无本轮改动；原有分屏草稿执行目录和历史文件解析保持原行为。无需增加迁移提示、历史补丁或跨项目锁。

阶段 1 前端范围完成。环境池、知识库 qmd、技能角色后续阶段尚未在此验收；完整 Electron 与真实引擎启动/重启结果见服务端验收报告。
