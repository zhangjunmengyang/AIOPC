import { useState } from "react";
import { Link } from "react-router";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CompanyGoal, CompanyGoalsClient } from "./goal-client";
import { goalSelectClass, goalText } from "./goal-copy";
import { useCompanyGoals } from "./goal-query";

export type TaskGoalFieldProps = {
  client: CompanyGoalsClient | null;
  workspaceId: string;
  projectId: string;
  taskId: string;
  goalHref?: (goalId: string) => string;
};

function GoalLinkForm({ current, choices, saving, error, onSave, goalHref }: {
  current: CompanyGoal | undefined;
  choices: CompanyGoal[];
  saving: boolean;
  error: Error | null;
  onSave: (goalId: string | null) => void;
  goalHref?: (goalId: string) => string;
}) {
  const [selected, setSelected] = useState(current?.id ?? "");
  return (
    <section className="space-y-2">
      <p className="text-xs text-muted-foreground">{goalText("projectGoal")}</p>
      {current && goalHref ? (
        <Link to={goalHref(current.id)} className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "max-w-full justify-start px-0")}>
          <span className="truncate">{current.title}</span>
        </Link>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={goalText("projectGoal")}
          className={goalSelectClass}
          value={selected}
          disabled={saving}
          onChange={(event) => setSelected(event.target.value)}
        >
          <option value="">{goalText("noGoal")}</option>
          {choices.map((goal) => <option key={goal.id} value={goal.id}>{goal.title}</option>)}
        </select>
        <Button type="button" size="sm" variant="outline" disabled={saving || selected === (current?.id ?? "")}
          onClick={() => onSave(selected || null)}>{goalText("saveLink")}</Button>
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error.message || goalText("saveFailed")}</p> : null}
    </section>
  );
}

export function TaskGoalField({ client, workspaceId, projectId, taskId, goalHref }: TaskGoalFieldProps) {
  const { goals, link } = useCompanyGoals(client, workspaceId);
  if (!client || !workspaceId) return null;
  if (goals.isPending) return <p role="status" className="text-sm text-muted-foreground">{goalText("loading")}</p>;
  if (!goals.data) return <p role="alert" className="text-sm text-destructive">{goals.error?.message || goalText("loadFailed")}</p>;

  const choices = goals.data.items.filter((item) => item.projectId === projectId);
  const currentId = goals.data.links.find((item) => item.projectId === projectId && item.taskId === taskId)?.goalId;
  const current = choices.find((item) => item.id === currentId);
  return (
    <GoalLinkForm
      key={`${projectId}/${taskId}/${currentId ?? ""}`}
      current={current}
      choices={choices}
      saving={link.isPending}
      error={link.error}
      onSave={(goalId) => link.mutate({ projectId, taskId, goalId })}
      goalHref={goalHref}
    />
  );
}
