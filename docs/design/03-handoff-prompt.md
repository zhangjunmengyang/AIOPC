# 开发交接提示词

把下面整段发给执行改造的 Claude Code 窗口。分两次发:先发"Phase 0",拿到结论并由用户确认后,再发"Phase 1"。

---

## Phase 0 提示词

你在 `~/project/AIOPC`(OpenWork 的 fork,产品名 AIOPC)里工作。先完整读 `docs/design/01-company-project-role-knowledge.md`,它是本次改造的唯一设计依据。全程用中文回复和写文档。

### 背景
我们要把抽象从"workspace = 项目"改为:一个公司(workspace)→多个项目(`projects/<名>/`)→会话(可绑定角色);角色和知识库属于公司;沙箱是公司资源池,项目按需绑定一个或多个环境。设计稿里标 **[待测]** 的点还没有被运行验证过,这是 Phase 0 要做的事。

### 本阶段只做验证,不合并功能代码
可以写临时脚本和原型,放在 `/tmp` 或新建的 `scratch/` 目录,不要改已有文件的行为。逐项给出结论和证据,写到新文件 `docs/design/02-phase0-findings.md`:

1. **子目录会话**:创建会话时把 directory 设为 `W/projects/x`(需要先放行 `apps/server/src/server.ts:1455` 与 `:1721-1736` 的强制覆盖,只在原型分支做)。回答:`session.list` 是否仍能列出;非 git 的 `W` 下 project 归属;OPC MCP 在该会话里 `get_project_brief` 返回的 `project.path`;`W/.opencode/skills`、`W/projects/x/.opencode/skills` 是否被加载,向上查找停在哪层;在 `W` 里 `git init` 后有何变化。结论:选方案 A 还是 B。
2. **qmd**(github.com/tobi/qmd):能否接外部 embedding(OpenAI 兼容接口或 Ollama),查 README、issue、源码;用真实中文资料和 `AIOPC-skills/catalog.json` 的中文描述各抽样测中英混合检索质量;索引 2674 个 `SKILL.md` 的耗时与内存;作为独立进程(HTTP MCP)运行还是内嵌 Electron 更可行。若外部 embedding 不成立,给出回退方案的最小实现建议。
3. **sidecar 媒体关联**:用 qmd 的 frontmatter 过滤验证"文档命中→按 `related` 反查 sidecar→带出图片"可行。
4. **环境并发**:同一环境内两个会话并发使用浏览器和文件时会发生什么。
5. **opencode skill 权限**:当前所用版本里 `deny *` + 白名单的确切写法,按角色(agent)限定可见技能是否生效。
6. **技能目录**:`AIOPC-skills/catalog.json` 的 60 个仓库入口条目能展开出多少个具体技能(浅克隆后统计 `SKILL.md`)。

### 约束
- 工作区是脏的:有约 600 处未提交改动,隔壁窗口在改 `services/opc`(`server.py`、`social/`、`ui/`)。不要 `git reset`、`git checkout .`、`git stash`、`rm` 任何不是你创建的文件;不要提交,不要推送。
- 只读优先;需要改源码做原型时,用 `git worktree` 或复制到 `/tmp`,验证完丢弃。
- 下载的仓库和压缩包放进各自全新的空目录,脚本放在别处,用路径参数传入,运行 Python 带 `-I`。
- 基建遵守"先复用开源";不做短期 hack,只做终局方案。
- 不用知乎做任何测试;发布流程只到"AI 填好,人按发布"。
- 结论区分"实测确认"与"推断"。

### 交付
`docs/design/02-phase0-findings.md`:每项一节,含命令、输出摘要、结论。末尾给出对设计稿的修订建议(哪一节要改、怎么改),不要直接改设计稿。完成后向我汇报并等我确认,再开始 Phase 1。

---

## Phase 1 提示词(Phase 0 确认后再发)

按 `docs/design/01-company-project-role-knowledge.md` 第 9 节 Phase 1 和 `02-phase0-findings.md` 的结论实施。顺序:

1. 会话元数据与项目分组:服务端 `sessionMeta`,侧栏项目分组(只读保护、"+"传 groupId、文案)。
2. 会话执行目录(按 Phase 0 选定的 A 或 B)与 OPC MCP 的 `project` 参数、指令注入。
3. 环境资源池:registry 改以环境 id 为 key,账号加 `environment` 字段,项目绑定,前端资源池视图,迁移旧 `sandbox.json`。
4. 知识库:改名,`knowledge/` 模块接入选定的检索引擎,sidecar 生成,`kb_query` 工具,上传选归属,页面改造。
5. 旧 workspace 到 `projects/<名>` 的迁移脚本,要求可预演(dry-run)且不删除原文件。

### 规则
- 每步先写测试再改代码;`services/opc/tests` 与 `apps/app/tests` 现有测试必须仍通过,汇报时贴出实际命令输出,失败就如实说。
- 改动尽量放在独立模块,少改上游核心文件,方便合并 OpenWork 上游。
- 提交信息用中文,末尾加 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`;只在我要求时提交,先给我看差异清单。
- 每完成一步停下汇报:改了哪些文件、怎么验证的、剩余风险。不要自行进入下一步的重构或 Phase 2。
- 遇到设计稿没覆盖的决定,先问我,不要自行选择。
