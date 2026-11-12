# 阶段 1 服务端验收

2026-11-12。公司目录记为 `W`，项目执行目录限定为 `W/projects/<name>` 的直接目录。会话只保存 `projectId` 作为项目归属，分组和执行目录由它推导；`directory` 和 `openworkHomeDirectory` 保持为公司目录。项目归属在创建或旧数据首次恢复时确定，之后固定，调用方传入其他目录不能改变已有会话的归属。

已验证两个引擎的项目创建、公司列表、恢复读取、分叉、原生事件归属过滤。原生项目创建与 `session.created` 事件会登记项目归属，侧栏显示为 `proj:<name>` 分组，分叉继承源角色。角色清空值和手动调整不会被重复事件覆盖。修改已有 `projectId`、通过分组或批量导入更换项目均返回 409；角色与普通分组仍可调整。v1 项目的问题、权限、运行状态会汇总到公司；回复和拒绝发送到原执行目录，并保留旧引擎 generation 中尚未完成的请求。

技能查询从当前项目向公司目录查找。公司初始化在引擎启动前建立 Git 边界，只执行 `git init`，不暂存或提交。v2 仍会扫描 Git 边界外的技能，且原生文件技能源晚于外部插件注册，因此公司技能插件在 prompt admission 阶段重挂最终 `skill.transform`，再释放旧注册。原生钩子位于选中技能解析之前；后续技能重载继续重放该过滤器。[官方插件生命周期与 transform 文档](https://opencode.ai/docs/build/plugins/server)说明了注册顺序和 prompt hook 的执行位置。

真实引擎验收使用安装的 v1 `1.18.33` 与 v2 `2.2.6`，运行目录、HOME、数据库和配置均在临时目录。v2 请求发往本地模型替身，实际模型请求包含公司技能、当前项目技能、用户全局技能和明确注入的可信技能包，不含公司外层或兄弟项目技能。显式选择 `outside-company`、`project-b` 均收到原生 `Skill not found`。真实分叉后的项目组和 `designer` 角色也已检查。没有调用外部模型或真实账号。

| 检查 | 结果 | 完整输出 |
| --- | --- | --- |
| 阶段 1 focused tests | 47 通过 | `/tmp/aiopc-stage1-focused.log` |
| readiness | 66 通过 | `/tmp/aiopc-stage1-readiness.log` |
| 真实 HTTP 会话归属检查 | 1 通过 | `/tmp/aiopc-stage1-read-proof.log` |
| 双引擎原生验收 | 1 通过，覆盖 v1/v2 | `/tmp/aiopc-stage1-native.log` |
| TypeScript | 退出码 0 | `/tmp/aiopc-stage1-server-typecheck.log` |
| 服务端构建 | 退出码 0 | `/tmp/aiopc-stage1-server-build.log` |

以上命令均在 `apps/server` 运行：

```sh
bun test test/company-projects.test.ts test/company-session-proxy.test.ts test/company-session-scope-review.test.ts test/company-skills-instructions.test.ts test/company-skills-v2.test.ts test/session-groups-routes.test.ts test/opencode-v2-session-list.test.ts test/aiopc-runtime.test.ts test/workspace-init-legacy-browser-plugin.test.ts
pnpm test:readiness
bun test test/company-session-read-proof.test.ts
node --import tsx --test test/company-session-native.test.ts
pnpm exec tsc --noEmit -p tsconfig.json
pnpm build
```

`company-session-read-proof` 通过真实 HTTP 复现并修复了旧 v1 会话没有本地 origin 时的 500：归属证明的 `/message` 回调现在读取消息列表，不再返回会话元数据。新增目录、角色、事件、技能边界和后台创建测试均先观察到失败，再修改实现。用户随后取消跨项目移动需求，本轮为移动新增的数据库适配、移动锁、提示事件和试验代码均已撤回；没有修改已安装的引擎。宿主基线已提交，提交范围与后续接入见改造进度。
