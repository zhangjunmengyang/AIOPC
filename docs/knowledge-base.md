# 知识库

知识库使用公司和项目目录里的文件。Markdown 原文和同名说明文件随资料保存，qmd 索引可以从这些文件重建。AI 用 `kb_query(query, scope, kind, limit)` 查原文片段、出处和关联资料。

| 查询范围 | 可查资料 |
| --- | --- |
| `project`（默认） | 会话所属项目和公司共享资料。公司会话默认查公司资料 |
| `company` | 公司共享资料 |
| `skills` | 本地技能目录 |
| `all` | 会话所属公司、公司下的各项目和技能目录 |

桌面版从会话记录确认公司和项目。手动启动 MCP 时，`--workspace` 指定本次服务使用的目录。知识库页面的项目、公司、技能库标签分别展示自己的范围。

## 导入和关联

导入时选择当前项目或公司。文件存入所选目录下的 `knowledge/imports/`，同名时另存。提升为公司知识会保留项目原件，复制选中的文件、别名和说明。项目内的私有资料链接仍随原件保存。

媒体的同名 Markdown 记录别名、说明和关联文件。例如 `logo-v2.png` 的说明是 `logo-v2.md`。

```yaml
---
title: 品牌 logo 第二版
aliases: [logo, 标志, 主视觉]
media: ./logo-v2.png
related: [brand.md]
scope: project:auday
---
深蓝底，字母 A 的负形。
```

搜到别名就能找到原图。搜到关联文档时，也会返回对应媒体。Markdown 图片引用保留替代文字。PDF、DOCX 的内嵌图带原文出处。生成图保留标为「生成要求」的原始描述和来源。媒体说明可以在页面中编辑。

## 配置检索

桌面开发与构建会准备 qmd 运行程序。单独运行 OPC 时，在 `services/qmd` 执行 `bun install --frozen-lockfile --ignore-scripts`。qmd 按中文 trigram 检索，短中文词使用子串查找。没有配置 embedding 时，全文检索可以独立运行。

在 AIOPC 的 `.env` 里配置可选的文本 embedding。

| 变量 | 值 |
| --- | --- |
| `AIOPC_KB_EMBEDDING_PROVIDER` | `openai` 或 `ollama`。设为空值或 `off` 可关闭向量检索 |
| `AIOPC_KB_EMBEDDING_BASE_URL` | OpenAI 兼容的 API 根地址（通常含 `/v1`），或 Ollama 服务根地址 |
| `AIOPC_KB_EMBEDDING_MODEL` | 服务上的模型名 |
| `AIOPC_KB_EMBEDDING_DIMENSIONS` | 可选。接口支持显式指定维度时填写 |
| `AIOPC_KB_EMBEDDING_API_KEY` | 可选。服务要求认证时设置 |

启用 embedding 后，所选范围的资料文字和查询文字会发送给已配置的服务。更换服务、模型或向量维度后，下一次刷新会重建向量。索引与解析缓存保存在 AIOPC 数据目录。查到的排序分数表示检索匹配度。

如果没有设置 `AIOPC_KB_EMBEDDING_*`，只查单个项目时会沿用 AIOPC 数据目录里的 `embedding-profile.json` 和系统钥匙串里的 `AIOPC / models:embedding`。配置或密钥缺失时使用全文检索。公司资料、跨项目查询和技能库需要显式配置向量服务。

PDF 和 DOCX 保留页码或段落。MarkItDown 在本机把 PPTX、XLSX 转成可检索文字。扫描件 OCR、语音转录和自动图像说明暂未接入。解析警告会随查询返回。
