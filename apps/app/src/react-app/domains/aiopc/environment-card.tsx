/** @jsxImportSource react */
import { t } from "@/i18n";
import { useAiopcProject } from "./aiopc-client";
import { ProjectEnvironments } from "./environment-pool";

export function EnvironmentCard(props: { workspaceRoot: string }) {
  const project = useAiopcProject(props.workspaceRoot);
  if (project.isError) return <p role="alert" className="text-sm text-destructive">{project.error.message}</p>;
  if (!project.data?.company) return <p role="status" className="text-sm text-muted-foreground">{t("aiopc.loading")}</p>;
  return <ProjectEnvironments key={project.data.path} companyRoot={project.data.company.path} projectRoot={project.data.path} />;
}
