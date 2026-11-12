# 环境池后端验收

公司持有环境资源池，项目绑定一个或多个环境。账号记录保存 environment；环境为空的旧账号保留历史，但需要重新登录。会话创建后项目固定，浏览器操作的项目归属由宿主核实。

## 已实现

- `sandbox.json` schemaVersion 2 以环境 ID 为键；项目的 `environments.json` 是绑定投影。旧记录原地迁移前备份，保留容器名、volume、云端 profile 和账号记录。
- 多环境时必须明确选择。解绑保留登录；绑回原项目继续使用。改绑另一项目先返回受影响账号和确认令牌，取消不改变绑定；确认后清理档案、解除原账号关联并更新绑定版本。
- SQLite 租约跨 HTTP、MCP 和 Electron 共享。自动化按可信 runtime/session 排队，人工接管优先；正在执行的浏览器操作结束后才转交。空闲默认 60 秒，扫码等待最多 600 秒。
- `sandbox-policy.json` 可配置 `idleSeconds`（5–3600）和 `waitForUserSeconds`（5–600），修改后重启服务生效。
- 账号登录状态按环境和会话保存；检查账号、填写稿件使用账号自己的环境。审批同时冻结环境和绑定版本，重绑后旧审批不能继续填写。
- HTTP 只服务桌面已打开的公司及直接项目目录。MCP 只接受运行时原生 metadata 的会话 ID，经宿主验证后选择目录；模型参数不能冒充会话。

## 真实浏览器验证

在临时公司创建两台本地 Docker Chromium，使用同一个测试域的 Cookie 作为登录状态，未登录外部网站。

```text
PASS same project: two independent Chromium cookie jars
PASS unbind/rebind same project: both logins preserved
PASS confirmed cross-project rebind: old profile erased, other environment unchanged
CLEANED temporary containers/profiles
```

这三项验证期间浏览器保持运行，没有覆盖正常退出后重新启动。独立预检发现旧镜像的 Cookie 策略会在退出时清除持久 Cookie；该镜像修复由集成窗口单独实施。

脚本：`/tmp/aiopc-stage2-browser-verify.py`；日志：`/tmp/aiopc-stage2-browser-verify.log`。容器和 profile 已清理，原小红书环境未重启、未发布。

前端真实 HTTP 验收见 [环境池页面](environment-pool-frontend.md)，原生会话与生命周期验证见 [运行时验收](stage-2-runtime-verification.md)。最终自动化测试输出汇总在 [改造进度](company-project-progress.md)。

## 提供方边界

本地环境已实测完整档案清理。Kernel、Browserbase、Hyperbrowser、Anchor、Browser Use 的重绑使用各自的结束会话与删除 profile/context 接口，失败会保留原绑定和账号记录，不会宣布清理成功。这些分支已做接口模拟测试，没有使用真实云端账号调用。

Steel 的当前接入和自定义 CDP 地址没有可核实的完整档案删除能力，因此拒绝跨项目重绑和清档删除；同项目多环境、解绑与绑回原项目可以使用。不能用“清 Cookie”代替清空整个浏览器档案。

接口依据：[Kernel SDK](https://github.com/onkernel/kernel-python-sdk/blob/main/src/kernel/resources/profiles.py)、[Browserbase SDK](https://github.com/browserbase/sdk-python/blob/main/src/browserbase/resources/contexts.py)、[Hyperbrowser](https://www.hyperbrowser.ai/docs/api-reference/delete-profile-by-id)、[Anchor](https://docs.anchorbrowser.io/api-reference/profiles/delete-profile)、[Browser Use](https://docs.browser-use.com/cloud/api-v2/profiles/delete-browser-profile)。
