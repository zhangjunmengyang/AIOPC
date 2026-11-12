import { Link } from "react-router";

import { currentLocale } from "@/i18n";
import { cn } from "@/lib/utils";

const sections = ["overview", "tasks", "routines"] as const;
export type ProjectWorkSection = (typeof sections)[number];

const labels = {
  zh: { navigation: "项目页面", overview: "项目总览", tasks: "任务看板", routines: "例行任务" },
  en: { navigation: "Project pages", overview: "Overview", tasks: "Task board", routines: "Routines" },
};

function copy() {
  return currentLocale() === "zh" ? labels.zh : labels.en;
}

export function readProjectWorkSection(search: string): ProjectWorkSection {
  const view = new URLSearchParams(search).get("view");
  return view === "tasks" || view === "routines" ? view : "overview";
}

export function projectWorkHref(projectHref: string, section: ProjectWorkSection): string {
  return section === "overview" ? projectHref : `${projectHref}?view=${section}`;
}

export function ProjectWorkNavigation({ projectHref, current }: { projectHref: string; current: ProjectWorkSection }) {
  const text = copy();
  return (
    <nav aria-label={text.navigation} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 sm:px-6">
      {sections.map((section) => (
        <Link key={section} to={projectWorkHref(projectHref, section)}
          aria-current={current === section ? "page" : undefined}
          className={cn("border-b-2 px-1 py-2.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2",
            current === section ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
          {text[section]}
        </Link>
      ))}
    </nav>
  );
}
