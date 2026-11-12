# 开发交接

以[公司、项目、角色与知识库设计](01-company-project-role-knowledge.md)为验收依据。阶段清单保留改造范围和验证方法，开始工作前先看现有实现与测试。

## 工作方式

- 在 AIOPC 主仓库通过分支推进。收口后合到 `main`，验收通过再推送。保留正在进行的本地改动。
- 优先复用已有模块。验证改动通过应用正常入口生效，汇报实测范围和遗留问题。
- 发布测试止于填写发布页，最终发布由用户完成。验收不使用知乎。

## 阶段和验收

### 阶段 1:会话与项目(设计稿 4.1~4.4)
- 服务端 `sessionMeta`(角色绑定),侧栏项目分组(稳定 id `proj:<名>`、只读保护、"+"传 groupId、文案)。
- 会话执行目录:放行 `W/projects/*`,之家保持 `W`;v1、v2 代理都改;必要时补列子目录会话;`listSkills` 起点改为会话目录。
- OPC MCP:项目相关工具加 `project` 参数(限制在 `W/projects/*`),会话指令注入当前项目目录。
- 会话创建时固定 `projectId`，侧栏分组和默认作用域由项目归属确定。点击项目标题进入总览，箭头单独控制展开与收起。
- 验收:设计稿第 9 节 Phase 1 前三条。

### 阶段 2:环境资源池(4.5)
- registry 以环境 id 为 key,账号加 `environment`,项目 `environments.json` 绑定,同环境并发排队;前端资源池视图与项目页绑定;`workspace_of` 校验;旧 `sandbox.json` 迁移。
- 按设计稿 4.6 实现环境租约(60 秒空闲释放、等待扫码最长 10 分钟、排队、人工接管优先)与重新分配规则(同项目恢复登录态,换项目需确认并清空浏览器档案,账号记录转为需重新登录)。
- 验收:一个项目两个环境、账号互不影响,解绑回池,并发行为符合设计稿。

### 阶段 3:知识库(第 5 节)
- qmd fork:外部 embedding provider(OpenAI 兼容 / Ollama)、换模型自动重建、中文 trigram 与短查询处理。
- sidecar 生成与上传选归属,`kb_query(query, scope, kind, limit)`,关联媒体展开,`SpacePage` 改造为知识库页并改名。
- 验收:设计稿第 9 节 Phase 1 中知识库相关四条。

### 阶段 4:迁移
- 旧工作区迁移到 `projects/<名>`。脚本支持 dry-run，保留原文件。

### 阶段 5:技能库与角色(第 6 节,设计稿 Phase 2)
- 镜像脚本(浅克隆固定提交号,展开 60 个仓库入口,记录来源/提交/许可证/是否含脚本)、索引视图(合并 `catalog.json` 中英文描述)、Cisco skill-scanner 扫描、`find_skill`/`adopt_skill` 与 hash 锁、按角色限权、角色出厂包、团队页、收件箱、发布审批卡。
- 验收:设计稿第 9 节 Phase 2。

### 阶段 6:任务与例行(设计稿 Phase 3)
- 迁移 Multica 的"任务看板 + issue 详情含活动流"和 Markus 的"任务与交付物同板";例行任务迁移 Multica 的 Autopilots,调度表单复用本仓库 automations。
- 任务实体、看板、会话挂任务、阻塞与依赖;例行任务本地调度,产出进收件箱。
- 验收:设计稿第 9 节 Phase 3。

### 阶段 7:组织与成本(设计稿 Phase 4)
- 迁移 Paperclip 的 `org-chart`、`Goals`/`GoalDetail`、`Costs` 同款功能。
- 验收:设计稿第 9 节 Phase 4。

## 页面参考
参考项目的信息结构和交互，用 AIOPC 现有组件实现。组件放在 `apps/app/src`，使用语义色变量和 Base UI 的 `render` 接口。

| 本产品页面 | 迁移谁的同款 | 参考位置 |
|---|---|---|
| 团队(员工看板) | Multica 的 Team/agent 页(状态、成功率、当前任务)+ Paperclip `AgentDetail` | multica-ai/multica;paperclipai/paperclip `ui/src/pages/AgentDetail.tsx` |
| 收件箱 | Paperclip Inbox + Approvals + ApprovalDetail | paperclipai/paperclip `ui/src/pages/Inbox.tsx`、`Approvals.tsx`、`ApprovalDetail.tsx` |
| 发布审批卡(聊天内) | OneManCompany 的文件改动 diff 审批 | 1mancompany/OneManCompany;在 `message-list.tsx` 的 `ToolMessageInner` 加分支,先做 `aiopc_social_publish` |
| 任务看板 | Multica 看板 + Markus 任务与交付物同板 | multica-ai/multica;markus-global/markus |
| 例行任务 | Multica Autopilots | multica-ai/multica |
| 组织架构图 | Paperclip `org-chart` | paperclipai/paperclip `ui/src/pages/org-chart/` |
| 目标树 | Paperclip Goals/GoalDetail | paperclipai/paperclip `ui/src/pages/Goals.tsx`、`GoalDetail.tsx` |
| 成本 | Paperclip Costs | paperclipai/paperclip `ui/src/pages/` |
| 技能库页 | 本仓库 `ExtensionsView` + `extension-card.tsx` 改造;检索体验参考 skills.sh | `apps/app/src/react-app/domains/settings/pages/extensions-view.tsx` |
| 项目总览、知识库页、环境资源池 | 本仓库 `SpacePage`、`environment-card.tsx` 改造 | `apps/app/src/react-app/domains/aiopc/` |
| 会话沙箱桌面、整体"公司/项目/角色"心智 | Kortix CompanyOS | 本机 `~/project/companyos-trial`,在线 kortix-ai/suna |

团队页卡片的数据来源:会话状态用服务端现有的 `/session/active`(`server.ts:1688`)和 pending 列表;"此刻在做什么"取该角色会话最近一次工具调用的标题;技能取角色的出厂包与项目已采纳技能;"本周产出"取任务交付物和发布记录(`social/log.jsonl`)。
