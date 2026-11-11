---
title: 配置模型
description: 在设置里接入 AI 模型服务商，选择默认模型
---

# 配置模型

AIOPC 只使用你自己配置的模型，不提供托管模型。

- **设置 → AI 服务商**：添加 Anthropic、OpenAI、Google、OpenRouter，或任意 OpenAI 兼容接口（填写自定义 Base URL 和 API Key）。
- **本地模型**：设置 → Ollama，连接本机运行的 Ollama。
- **默认模型**：新对话默认使用运行时配置（`~/.config/opencode/opencode.json` 的 `model`）里的模型；在输入框下方的模型选择器里可以随时切换，切换后会记住。
- 密钥只保存在本机。
