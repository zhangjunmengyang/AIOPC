# 公司 · 项目 · 角色 · 知识库:整体方案

状态:设计稿,2026-11-12。依据:外部框架调研、AIOPC 代码盘点、技能与知识库检索调研、子目录会话可行性代码调查。
标注约定:**[证据]** 读到了代码或文档。本文是目标态,不含备选方案。

## 1. 要纠正的骨架

现状把"项目"和"团队"压在同一层:一个 workspace 就是一个项目文件夹,知识库、记忆、会话、沙箱都锁在里面。后果:项目之间资料不通,团队经验无法累积,侧栏没有"多个项目",资料空间把一个文件夹摊平所以上传后全混在一起。

新骨架:**一个公司(workspace),下面多个项目,角色和知识库属于公司,会话属于项目。**
这修改了此前"workspace = project"的决定。旧决定的出发点("给 AI 一台自己的电脑"、不同产品的账号不串)保留,但沙箱不再是项目的附属,而是公司的资源池,项目按需绑定一个或多个(见 4.5)。

## 2. 实体

| 实体 | 含义 | 归属 | 存放 |
|---|---|---|---|
| 公司 | 唯一根,即 OpenWork 的 workspace `W` | - | `W/` |
| 项目 | 一个产品或一次事业:简介、品牌、记忆、资料、交付物、社交账号、沙箱 | 公司 | `W/projects/<名>/` |
| 角色 | 设计、产品、增长等:persona + 技能包 + 工具权限 | 公司 | opencode agent,`W/.opencode/agent/<角色>.md` |
| 会话 | 一次对话，创建时确定 `projectId`，可绑定角色和任务 | 项目 | opencode session,元数据存服务端 KV |
| 知识库 | 公司共享资料 + 项目资料 + 技能库,统一检索 | 公司/项目 | Markdown 文件为真源 |
| 技能 | 一套可复用步骤。常驻、项目、目录三层 | 见第 6 节 | `SKILL.md` |
| 环境 | 沙箱,"AI 的电脑",可用资源。有自己的 id、提供方(本地 Docker 或云浏览器)、登录态 | 公司(资源池) | `sandbox/registry.py`,key 由项目路径改为环境 id |
| 绑定 | 项目 ↔ 环境,一对多;一个环境同一时间只服务一个项目(账号不串) | 项目 | 项目目录下 `environments.json` |
| 收件箱条目 | 待我处理:发布审批、AI 提问、失败任务 | 公司 | 第二期 |
| 任务 | 可分配、有状态的工作单元,会话挂在任务下 | 项目 | 第三期 |

外部框架校验:公司作根(Paperclip、Manor、Multica、OneManCompany 一致),角色即 persona+skills+tools(Kortix、CrewAI),一会话一角色(Kortix)。没有任何一家做"每项目一台沙箱",这是我们的差异化选择,需在第 9 节验证并发冲突。

## 3. 目录

```
W/                              公司
  .opencode/agent/*.md          角色(公司级)
  .opencode/skills/             公司级常驻技能
  knowledge/                    公司共享知识
  projects/<名>/                项目
    CONTEXT.md brand.md MEMORY.md decisions.md
    knowledge/                  项目资料(含媒体 sidecar)
    assets/ content/ social/
    .opencode/skills/           项目已采用的技能
~/.aiopc/library/
  skills-mirror/                技能库原文镜像(只读,固定提交号)
  skills-index/                 供检索的索引视图(生成物)
```

## 4. 会话与项目

### 4.1 侧栏
**项目 = 侧栏分组。** 侧栏已有 workspace 下的自定义分组,带拖拽、折叠、服务端同步和"新会话进指定分组" [证据:`session-management-store.ts`、`routes/session-groups.ts`、`new-session-destination.ts`]。创建项目时建一个稳定 id 为 `proj:<名>` 的分组。需要做:项目分组禁止改名删除;"未分组"改名"公司级会话";分组上的"+"传入 `groupId`。

### 4.2 会话元数据

服务端 `sessionMeta` 保存 `projectId`、`agentName` 和可选的 `taskId`。其中 `projectId` 为空表示公司级会话。旧记录从项目分组补齐归属，之后由项目归属确定侧栏分组。

### 4.3 会话的执行目录

项目会话在 `W/projects/<名>` 下执行，公司级会话在 `W` 下执行。两者都按会话之家 `W` 列到同一个公司侧栏。v1、v2 的创建代理都校验真实路径，技能列表从会话目录开始向上查找。

### 4.4 OPC MCP 的项目定位

宿主根据已确认的会话归属注入当前项目目录。项目工具使用 `project` 参数，服务端校验目标项目在已授权公司根下。

### 4.5 环境是资源,不是项目的附属
修正:沙箱不再"一项目一台"。一个项目做多套账号矩阵时,绑定多个环境;空闲环境留在公司资源池里,可以重新分配。
- **规则**:一个环境同一时间只服务一个项目(沿用"不同产品的账号不放进同一环境");项目可绑定 N 个环境;账号登录在某个具体环境里。
- **现状 [证据]**:`sandbox/registry.py:116` 以项目路径为 key,`sandbox.json` 的 `projects[path]`;`social/service.py:105,149,256,263,283,324` 的账号绑定用 `account["project"] == project_path`;`social/review.py:34,42,112` 用工作区路径哈希做 scope。即环境、账号、发布记录当前都由"项目路径"一个概念派生。
- **改法**:
  1. registry 的 key 改为环境 id;记录 `{id, name, provider, boundProject?}`,新增 `list/create/bind/unbind/destroy`。
  2. 账号记录增加 `environment` 字段;`project` 保留,表示账号归属的项目。发布日志仍按项目目录写。
  3. 项目的 `environments.json` 记录绑定;工具参数 `environment`(可省略,项目只有一个环境时默认)用于选择。
  4. 前端:设置里的"环境"页改为资源池视图(全部环境、状态、绑定到哪个项目);项目页里显示已绑定环境和"添加环境";右侧面板标签由 `environment:<workspaceRoot>` 改为 `environment:<envId>` [证据:`use-side-panel-tabs.ts:9`]。
  5. 迁移:现有 `sandbox.json` 里每个 `projects[path]` 转成一个环境并绑定到该项目。
- **并发与账号**:见 4.6。账号一致性检查(`xdata`、登录检测)按环境逐个执行。

另外 `server.py:254-262 workspace_of` 现在接受任意绝对目录,要限制为已授权公司根之内。`space.py` 若收到公司根会递归扫描全部项目,需排除 `projects/`。项目相关请求继续以 `?workspace=<项目目录>` 定位,环境相关请求另带 `environment=<id>`。

### 4.6 规则细则

会话的项目归属在创建时确定。侧栏分组、执行目录、环境、可见技能和 `kb_query` 的默认范围都以此为准。需要切换项目时，在目标项目中新建会话。

**项目分组标题**:点击标题打开项目总览,左侧小箭头单独负责展开/收起。

**环境重新分配**:登录状态跟环境走,账号记录归项目。
- 解绑后环境回到资源池,记录 `lastProject`。
- 绑回同一个项目:登录状态恢复。
- 绑给另一个项目时，先列出受影响账号，由用户确认清空浏览器档案。仅支持完整清除档案的提供方可以跨项目重绑。
- 原项目的账号记录保留,状态变为"需要重新登录",并清除其 `environment` 字段。

**环境租约**:独占的是浏览器使用权,不是整个会话。
- 会话要操作浏览器时获取租约;连续 60 秒无浏览器操作、本轮结束或会话关闭即释放。
- 等待用户扫码或接管登录时租约保持,上限 10 分钟。
- 排队先进先出,界面显示"会话 X 正在使用";人工接管实时画面时优先获得租约。
- 文件不加锁,写入走项目目录。
- 60 秒、10 分钟为初始值,做成可配置。

## 5. 知识库(原"资料空间")

### 5.1 原则
- 改名"知识库"。**Markdown 文件是真源**,索引是可重建的生成物。
- AI 只看到**一个工具**:`kb_query(query, scope?, kind?, limit?)`。`scope` 取 `project`(默认,当前项目 + 公司共享)、`company`、`skills`、`all`。
- 不自己造检索引擎;embedding 用外部模型,不强依赖自带向量库。

### 5.2 现成件选型(调研结论)
**决定:fork tobi/qmd 作为检索核心并直接改源码。** 它已具备 Markdown 为真源、BM25 + 向量 + 重排、RRF 融合、stdio/HTTP MCP、命名 collection、frontmatter 元数据递归 JSON 过滤 [证据:github.com/tobi/qmd README]。项目在 qmd 和包装层加入以下能力。
- **外部 embedding**:增加 embedding provider 抽象,支持 OpenAI 兼容接口和 Ollama,本地 GGUF 作为可选项;`qmd embed` 重建索引时记录模型 id 和维度,换模型自动全量重建。
- **中文检索**:BM25 路对中文用 trigram 分词(并对 1~2 字查询退回 LIKE),向量路用外部多语言 embedding(bge-m3 或同级);索引文本附上中英文别名。
- **媒体**:见 5.3,sidecar 在包装层处理,qmd 本身不用理解图片。

fork 放在 `services/` 下的独立目录,保留 `UPSTREAM.md` 记录同步点,与 OpenWork 的做法一致。

排除:Basic Memory(AGPL-3.0)、Khoj(AGPL-3.0)、RAGFlow(重,macOS Docker 镜像不支持)、LightRAG 与 Cognee(建图成本高,LightRAG 无元数据过滤)、Qdrant MCP(find 无过滤参数,只支持 FastEmbed)。
PDF 和 DOCX 保留页码或段落。MarkItDown 把 PPTX、XLSX 转为可检索文本。

### 5.3 媒体靠关联,不靠多模态 embedding
每个图片、视频、音频配一个同名 sidecar:`logo-v2.png` + `logo-v2.md`。

```yaml
---
title: 品牌 logo 第二版
aliases: [logo, 标志, 主视觉]
media: ./logo-v2.png
related: [brand.md, content/launch-post.md]
scope: project:auday
---
AI 或人工写的描述:深蓝底,字母 A 的负形……
```

- sidecar 进索引,命中它就等于命中图片。
- 文档命中时,包装层读 `related` 反查 sidecar,把关联媒体一并返回。
- 用户可以编辑媒体描述。生成图的提示词作为生成记录保存。
- 上传时必须选归属(项目 / 公司),默认当前项目,可"提升为公司知识"。这解决"传上去混在一起"。

### 5.4 作用域
frontmatter 带 `scope: project:<名>` 或 `scope: company`,由写入层自动补。查询用元数据过滤,不用多 collection 同查,因为 qmd 文档明确提醒大 collection 会挤掉小的。

### 5.5 页面
知识库页以现有 `SpacePage` 为基础改造 [证据:`aiopc/space-page.tsx`]:左侧"当前项目 / 公司 / 技能库",按类型分区(简介、知识、素材、内容),卡片显示关联媒体,上传弹窗选归属。

## 6. 角色与技能

### 6.1 分工
角色回答"谁来做"(判断力、边界),技能回答"怎么做"(可复用步骤)。起名、logo、营销页、复刻营销页都是技能,不是角色。角色是公司级的,不按项目复制;项目只提供上下文。每个角色有"出厂技能包",例如品牌设计师 = 起名 + 定位 + logo + 视觉规范。

### 6.2 三层
| 层 | 内容 | 规模 | 位置 |
|---|---|---|---|
| 常驻 | 角色出厂包,描述进提示 | 每角色 5~10 | `W/.opencode/skills/` |
| 项目 | 项目已采用的技能 | 随项目增长 | `projects/<名>/.opencode/skills/` |
| 目录 | 全量技能库,只检索,不进提示 | 约 2700 | `~/.aiopc/library/skills-mirror/` |

opencode 每步会把所有允许的技能名与描述列给模型 [证据:opencode.ai/docs/skills],所以已安装集合必须小。

### 6.3 技能库(采纳用户决定:全量本地镜像 + 独立检索)
来源 `AIOPC-skills/catalog.json`:2766 条,2674 条直指 `SKILL.md`,60 条仓库入口,26 条非 GitHub,6 条其他 [证据:本机解析]。
1. **镜像脚本**:按仓库浅克隆并固定提交号,复制 `SKILL.md` 及其目录;记录 来源仓库、提交号、许可证、是否含 `scripts/`、分类。60 个仓库入口展开为其中的具体 `SKILL.md`;非 GitHub 的 26 条按需手工补。
2. **索引视图**:为每个技能生成一份索引 Markdown(frontmatter 含中英文名、`catalog.json` 的中英文描述、分类、`has_scripts`,正文为 `SKILL.md` 内容),作为 qmd 的 `skills` collection。目录里自带中文描述,恰好补上英文技能的中文检索缺口。
3. **审核闸门**(镜像时一次完成):校验 agentskills.io 规范(name ≤ 64、description ≤ 1024);Cisco skill-scanner(Apache-2.0,可离线)扫描;含 `scripts/` 的打标记,默认只允许在项目沙箱内运行。注意其自述"仅规则只能抓到约 7.7% 恶意样本",干净结果不等于安全。
4. **工具**:`find_skill(query)` 返回 3~5 个候选;`adopt_skill(id, scope)` 复制到项目(或提升到公司),写 `skills-lock.json` 记 hash。
5. **限权**:各角色用 opencode 的 skill 权限 `deny *` + 白名单(以当前 opencode 版本的写法为准,文档把 `permission`/`tools` 标为旧写法)。

## 7. 页面:新增、改造、复用、抄谁

| 页面 | 期 | 做法 | 复用 / 参考 |
|---|---|---|---|
| 侧栏(项目分组) | 1 | 改造 | 现有分组全套交互 [证据:`app-sidebar.tsx`、`session-management-store.ts`] |
| 项目总览 | 1 | 新增 | `SpacePage` 的卡片;简介、目标、阶段、置顶资料、近期交付物、绑定的环境 |
| 知识库 | 1 | 改造 `SpacePage` | 见 5.5 |
| 环境资源池 | 1 | 改造 `environment-view.tsx` / `environment-card.tsx` | 现有 `ProviderRow` |
| 技能库 | 2 | 新增 | `ExtensionsView`、`extension-card.tsx` 作基础 |
| 团队(员工看板) | 2 | 新增 | 角色卡:头像、此刻在做什么(点开进会话)、技能、本周产出。参考 Multica agent 页、Paperclip `AgentDetail` |
| 收件箱 | 2 | 新增 | 待审批发布稿、AI 提问、失败任务。参考 Paperclip `Inbox`/`Approvals`;逻辑复用 `permission-approval-modal.tsx` |
| 聊天里的 OPC 卡片 | 2 | 新增 | `message-list.tsx` 的 `ToolMessageInner` 加分支,先做 `aiopc_social_publish` 审批卡 [证据:卡片是硬编码分派,无注册表] |
| 任务看板 | 3 | 新增 | 无现成 kanban 组件,需自建;参考 Multica 看板、Markus 任务与交付物同板 |
| 例行任务 | 3 | 改造 automations | 保留 schema 和调度表单,后端换本地调度;现有代码依赖云端 Den 且未挂路由 [证据] |
| 组织架构图、目标树、成本 | 4 | 后置 | Paperclip `org-chart`、`Goals`、`Costs` |

抄的方式:**照信息结构,用我们的组件重写**,不拷代码。Paperclip(MIT,React)可参考但组件库不同;Multica 许可有商用与品牌限制,只看不抄;OneManCompany(Apache-2.0)的文件改动 diff 审批值得借鉴。设计系统是 Tailwind v4 + Radix 色板 token + shadcn 风格(底层 Base UI,不是 Radix,`asChild` 写法要改成 `render`),新组件放在 `apps/app/src` 内 [证据]。

## 8. 改动清单(文件级)

| 区域 | 文件 | 改动 |
|---|---|---|
| 会话目录 | `apps/server/src/server.ts` | 校验并采用会话所属的项目目录 |
| 会话元数据 | `session-groups.ts`、`routes/session-groups.ts` | 加 `sessionMeta`,改 normalize,加 PATCH |
| 角色绑定 | `session-mode-memory.ts` | 写服务端,localStorage 作缓存 |
| 侧栏 | `app-sidebar.tsx`、`utils.ts`、`zh.ts` | 项目分组只读保护、"+"传 groupId、文案 |
| MCP | `services/opc/aiopc/server.py`、`project.py`、`space.py` | `project`/`environment` 参数,措辞改"项目目录",`workspace_of` 校验 |
| 环境 | `sandbox/registry.py`、`social/service.py`、`social/review.py`、前端 `aiopc-client.ts` | key 改环境 id,账号加 `environment` |
| 知识库 | `services/opc/aiopc/knowledge.py`、`services/qmd/` | qmd 集成、sidecar 生成、`kb_query` |
| 技能库 | 新模块 `services/opc/aiopc/skillhub/` + 镜像脚本 | 镜像、索引视图、审核、`find_skill`/`adopt_skill` |
| 迁移 | 一次性脚本 | 旧 workspace → `projects/<名>`;旧沙箱 → 环境 |

## 9. 目标、分期与验收

目标态以第 1~8 节为准。实现中遇到上游或引擎行为与预期不符,改我们的代理层或 fork,不降低目标。

**Phase 1:骨架**
1. 项目分组、会话元数据、会话执行目录(4.3)、MCP `project` 参数与指令注入(4.4)。
2. 环境资源池与项目绑定(4.5),旧沙箱迁移。
3. 知识库:qmd fork(外部 embedding、中文 trigram)、sidecar、`kb_query`、上传选归属、页面改造。
4. 旧 workspace → `projects/<名>` 迁移脚本(可预演,不删原文件)。

验收(写成自动化测试或可复现脚本):
- 同一公司下建两个项目,各自会话的工作目录是各自的 `projects/<名>`,侧栏按项目分组,重启后分组与角色绑定还在。
- 子目录会话在侧栏列表中可见、可恢复;`get_project_brief` 返回的是该项目;项目级 `.opencode/skills` 被加载。
- 设计角色在项目 A 的会话里,`kb_query` 能同时命中项目 A 的资料和公司共享资料,查不到项目 B 的私有资料(`scope=all` 除外)。
- 图片通过 sidecar 的别名被检索到,文档命中时带出关联图片。
- 换 embedding 模型后索引自动重建;中英混合查询(含 1~2 字中文)有结果。
- 一个项目绑定两个环境,账号分别登录互不影响;解绑后环境回到资源池。
- 同一环境两个会话并发时有明确的互斥或排队行为,不出现登录态串用。

**Phase 2:技能与角色** 技能库镜像与检索(全量 2674 条直链 + 展开的仓库入口)、`find_skill`/`adopt_skill`、角色详情与出厂包、按角色限权、团队页、收件箱、发布审批卡。
验收:角色在提示中只看到自己的常驻技能与项目已采纳技能;`find_skill("复刻营销页")` 返回相关候选;采纳后写入项目并生成 hash 锁;含脚本的技能被标记且只在沙箱内运行。

**Phase 3:任务与例行**
- 任务(工单)实体:属于项目,字段 `title、description、status(待办/进行中/待审/完成/阻塞)、assignee(角色)、parent、blockedBy、deliverables(文件或发布稿)`,会话可挂在任务下;存项目目录 `tasks/*.md`(frontmatter + 正文),与知识库同为 Markdown 真源。
- 任务看板:按状态分列,卡片显示负责角色和交付物,点开进会话;任务与交付物同板。
- 例行任务:保留 `packages/types/src/automations.ts` 的 schema 和调度表单,后端换成本地调度(`services/opc` 内),增加 `agent` 字段,运行产出进收件箱。
验收:AI 可创建、领取、流转任务;任务可阻塞与依赖;例行任务按计划触发并在收件箱留下结果;重启后调度不丢。

**Phase 4:组织与成本**
- 组织架构图:角色与汇报线(`reportsTo`,可空)。
- 目标树:公司目标 → 项目目标 → 任务,任务可挂目标。
- 成本:按会话、角色、项目统计模型用量与费用,先统计,不做硬停。
验收:组织图可编辑;目标与任务双向可见;成本页数字与会话用量一致。

**补充验收(Phase 1/2 共用)**
- 跨项目拖动会话时，项目归属保持固定。目标项目的新会话在对应目录运行。
- 解绑后直接绑回同一项目时恢复登录态。经用户确认绑给另一个项目时清空浏览器档案，原账号显示需要重新登录。
- 租约 60 秒空闲释放,排队先进先出,等待扫码时保持。

## 10. 注意事项
- 第三方技能是第三方提示词,入库扫描(Cisco skill-scanner)只降低风险;含脚本的技能只在项目环境内运行。
- 技能库先作内部使用,不对外分发镜像。

## 11. 主要依据
tobi/qmd、Docling、MarkItDown、Cisco skill-scanner、vercel-labs/skills、agentskills.io、opencode.ai/docs/skills、Paperclip、Multica、OneManCompany、Markus、Kortix 的公开仓库与文档;代码证据来自 `~/project/AIOPC` 当前工作区。
