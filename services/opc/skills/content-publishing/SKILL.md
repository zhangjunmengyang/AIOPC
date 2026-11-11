---
name: content-publishing
description: 用聊天管理项目原稿、平台改写、审稿、素材、发布前检查与投递记录。适用于准备 X、知乎、即刻、小红书和公众号内容，或修改现有稿件与规则。
---

# 从原稿到渠道结果

使用 `company` MCP 工具操作内容。先复用当前对话的项目和稿件；不确定时列出项目和稿件。只有确实无法判断归属才询问。每篇稿件始终包含原稿、平台稿、素材和来源版本。

本 skill 的结构化改写和投递参数只覆盖下列七种形态。其他平台的现成 MCP 分发、GitHub / Hugging Face 社区和聊天通道运营使用 `channel-operations`；可复用本流程产生的原稿与媒体，但不能把新增平台 ID 传给旧 `company` 投递工具。

## 工作顺序

1. 用 `list_projects`、`list_posts`、`get_post` 读取已有内容；新内容用 `create_project`、`create_post`。`markdown` 是原稿，标题和封面是独立字段。上传的图片、音视频或文档先用 `import_asset` 复制到稿件素材目录，保留原上传文件；渠道图片和封面只使用图像素材。
2. 使用目标形态：`x:article`、`x:post`、`zhihu:article`、`zhihu:pin`、`jike:post`、`xhs:note`、`wechat:article`。按用户目标选需要的形态，不必每次生成全部。
3. `preview_rewrite` 查看规则、范文、项目事实和提示词来源，`rewrite_post` 生成平台稿。公众号正文沿用原稿并加配置的开头结尾，摘要与转发语独立；用户要求重置正文时用 `reset_wechat_body`，不要改掉摘要或其他平台稿。小红书保留两步结果，第二步失败用 `retry_step2` 继续。
4. 读回结果，用 `compare_draft` 打开对照。补写标记是待核实提示，不代表内容真实。返回稿件文件链接，用户可在原生侧栏直接编辑。手改、外部更新和原稿变化要保留，发生版本冲突先重读，不能偷偷覆盖。
   公众号摘要和转发语用 `save_wechat_metadata` 单独修改，传入 `get_draft` 返回的 `metadata_hash`；不将整段内部元数据交给模型改写。
   修改原稿用 `save_post(expected_hash=当前原稿hash)`，修改平台稿用 `save_draft(expected_hash=当前平台稿hash)`。已有手改平台稿只有在当前要求确实包含重写替换时，才把刚读到的 hash 传给 `rewrite_post(expected_variant_hash=...)`；不能为了绕过冲突自动补这个参数。公众号只重写摘要时会保留手改正文。
5. `check_delivery` 分开检查稿件和运行环境；`export_package` 只准备文件。只有当前用户授权覆盖对应目标与动作时才调用 `deliver_post` 或 `deliver_batch`。代码安装或“准备发布”不自动授权向外部账号发送测试内容。
6. 保存每次尝试的结果。创建稿件、改写和生成媒体不需要多加一轮审批；需要用户判断时在聊天展示具体内容、目标账号和动作，沿用已明确的授权。

## 记录与重试

- 投递的 `idempotency_key` 对同一请求必须稳定。调用断开后先查 `delivery_history`，不要换 key 重发；`unknown` 表示不知道外部是否成功，先查外部结果。只有用户明确要求重新尝试才创建新尝试，并引用 `retry_of`。
- 已成功的内容只有在用户明确要求重发时，才使用 `allow_resend=True`，同时传入成功尝试的 `retry_of`、当前已审版本的 `expected_revision` 和新的 `idempotency_key`。`unknown` 仍须先核对结果，不能用重发参数绕过未知状态。
- `awaiting_browser`：尚待打开浏览器交接；`composer_filled`：填好了发布框；`draft_created`：创建了草稿；`exported`：只导出了文件；`published`：有明确公开发布记录。不得混用。
- MultiPost 需要已安装扩展并登录目标平台的本机浏览器。打开工具返回的交接链接，等真实回执；不要把“已返回交接页”描述成“已填好”。
- 用户给出发布链接后用 `record_publication` 保存，注明链接来自用户回填；它不等于自动核实了平台内容。
- `trash_post` 是可恢复删除，使用 `restore_post` 恢复。活动中的稿件不能删除。
- 恢复旧正文或平台稿先用 `post_history` 选择明确的 `event_id`，核对快照，再调用 `restore_revision`。`expected_hash` 必须来自当前 `get_post` / `get_draft`，不能拿历史快照的旧 hash 代替；恢复后检查派生稿是否需要同步。
- 小红书第二步失败后可用 `retry_step2` 复用保存的精简稿；若原稿或最终稿已改动，旧检查点会被拒绝，此时依据当前要求重新改写，不能把旧结果强行覆盖到新版本。
- 公司级规则用 `list_rules`、`get_rule`、`save_rule` 管理，保存时使用读出的 hash。预览里的临时规则不自动写回正式规则。

输出只需简要说明产物、实际停止点和下一步，附可点击文件或真实平台链接。不要在聊天罗列内部 JSON、令牌、文件锁和模型请求体。
