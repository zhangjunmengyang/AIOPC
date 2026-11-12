import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import type { CreateLibraryItemInput, LibraryAuthorableKind } from "./library";

export function validateLibraryItem(input: CreateLibraryItemInput) {
  const name = input.name.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("名称只能包含字母、数字、下划线或连字符。");
  if (!input.instructions.trim()) throw new Error("请填写内容。");
  return name;
}

/** Preserve comments and unrelated configuration; never replace an existing item. */
export function addLibraryConfigItem(raw: string, kind: Exclude<LibraryAuthorableKind, "skill">, input: CreateLibraryItemInput) {
  const name = validateLibraryItem(input);
  const errors: ParseError[] = [];
  const config = parse(raw || "{}", errors, { allowTrailingComma: true });
  if (errors.length || !config || typeof config !== "object" || Array.isArray(config)) throw new Error("项目配置格式有误，请先修复后再添加。");
  const collection = config[kind];
  if (collection !== undefined && (!collection || typeof collection !== "object" || Array.isArray(collection))) throw new Error("项目配置中的指令或员工列表格式有误。");
  if (collection && Object.prototype.hasOwnProperty.call(collection, name)) throw new Error("同名项目项已存在。");
  const value = kind === "command"
    ? { description: input.description, template: input.instructions }
    : { description: input.description, prompt: input.instructions, mode: "primary" };
  return applyEdits(raw || "{}", modify(raw || "{}", [kind, name], value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
}
