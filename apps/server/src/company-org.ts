import { randomUUID } from "node:crypto";
import { realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ensureCompanyRoleDocumentUnchanged,
  listCompanyRoleDocuments,
  readCompanyRoleMetadata,
  setCompanyRoleReportsTo,
} from "./company-role-metadata.js";
import { ApiError } from "./errors.js";

export type CompanyOrgRole = {
  id: string;
  name: string;
  description?: string;
  reportsTo: string | null;
};

// Validation and persistence for all edges in a company must use the same queue.
const pendingEdits = new Map<string, Promise<unknown>>();

export async function listCompanyOrgRoles(companyRoot: string): Promise<CompanyOrgRole[]> {
  const documents = await listCompanyRoleDocuments(companyRoot);
  return documents.map(readCompanyRoleMetadata);
}

export async function updateCompanyReportingLine(
  companyRoot: string,
  roleId: string,
  reportsTo: string | null,
): Promise<CompanyOrgRole[]> {
  const company = await realpath(companyRoot);
  const previous = pendingEdits.get(company);
  const update = async () => {
    const documents = await listCompanyRoleDocuments(company);
    const target = documents.find((document) => document.id === roleId);
    const roles = documents.map(readCompanyRoleMetadata);
    const byId = new Map(roles.map((role) => [role.id, role]));
    if (!target || (reportsTo !== null && !byId.has(reportsTo))) {
      throw new ApiError(404, "company_role_not_found", "公司角色或汇报对象不存在");
    }

    const seen = new Set([roleId]);
    let manager = reportsTo;
    while (manager !== null) {
      if (seen.has(manager)) throw new ApiError(409, "company_reporting_cycle", "汇报关系不能形成循环");
      seen.add(manager);
      manager = byId.get(manager)?.reportsTo ?? null;
    }

    const role = byId.get(roleId)!;
    if (role.reportsTo === reportsTo) return roles;
    const content = setCompanyRoleReportsTo(target, reportsTo);
    const temporary = join(dirname(target.path), ".aiopc-role-" + randomUUID() + ".tmp");
    try {
      await writeFile(temporary, content, { flag: "wx", mode: target.mode });
      await ensureCompanyRoleDocumentUnchanged(target);
      await rename(temporary, target.path);
    } finally {
      await rm(temporary, { force: true });
    }
    role.reportsTo = reportsTo;
    return roles;
  };
  const current = previous ? previous.then(update, update) : update();
  pendingEdits.set(company, current);
  try {
    return await current;
  } finally {
    if (pendingEdits.get(company) === current) pendingEdits.delete(company);
  }
}
