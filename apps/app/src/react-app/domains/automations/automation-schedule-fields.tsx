/** @jsxImportSource react */
import { automationLocalDateTimeInput, automationLocalDateTimeTimestamp } from "@openwork/types/automation-schedule";
import type { AutomationSchedule } from "@openwork/types/automations";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { currentLocale } from "@/i18n";

export type LocalAutomationSchedule = Exclude<AutomationSchedule, { kind: "calendar" }>;

export function routineCopy(zh: string, en: string) {
  return currentLocale() === "zh" ? zh : en;
}

const WEEKDAYS = [
  { value: 1, zh: "周一", en: "Mon" },
  { value: 2, zh: "周二", en: "Tue" },
  { value: 3, zh: "周三", en: "Wed" },
  { value: 4, zh: "周四", en: "Thu" },
  { value: 5, zh: "周五", en: "Fri" },
  { value: 6, zh: "周六", en: "Sat" },
  { value: 0, zh: "周日", en: "Sun" },
] as const;

const INTERVAL_HOURS = [1, 2, 3, 4, 6, 8, 12];
const hourLabel = (hour: number) => `${String(hour).padStart(2, "0")}:00`;

function tomorrowAtNine(timezone: string) {
  const day = new Date(Date.now() + 86_400_000);
  const date = automationLocalDateTimeInput(day.getTime(), timezone).split("T")[0];
  return automationLocalDateTimeTimestamp(`${date}T09:00`, timezone) ?? day.getTime();
}

function timeForSchedule(schedule: LocalAutomationSchedule) {
  if (schedule.kind === "once") return { hour: 9, minute: 0 };
  if (schedule.kind === "interval") return { hour: schedule.startHour, minute: 0 };
  return { hour: schedule.hour, minute: schedule.minute };
}

export function ScheduleSelect<T extends string | number>(props: {
  id: string;
  value: T;
  items: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <Select
      value={props.value}
      items={props.items}
      onValueChange={(value) => {
        const match = props.items.find((item) => item.value === value);
        if (match) props.onChange(match.value);
      }}
    >
      <SelectTrigger id={props.id} className="w-full rounded-lg">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {props.items.map((item) => <SelectItem key={String(item.value)} value={item.value}>{item.label}</SelectItem>)}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

/** Reuses the Automations frequency, time, weekday and window fields for local clock schedules. */
export function AutomationScheduleFields(props: {
  schedule: LocalAutomationSchedule;
  onChange: (schedule: LocalAutomationSchedule) => void;
  idPrefix?: string;
}) {
  const id = (name: string) => `${props.idPrefix ?? "automation"}-${name}`;
  const schedule = props.schedule;
  const time = timeForSchedule(schedule);

  const changeScheduleKind = (kind: LocalAutomationSchedule["kind"]) => {
    const timezone = schedule.timezone;
    const days = schedule.kind === "weekly" || schedule.kind === "interval" ? schedule.daysOfWeek : [1, 2, 3, 4, 5];
    if (kind === "once") return props.onChange({ kind, timezone, at: tomorrowAtNine(timezone) });
    if (kind === "daily") return props.onChange({ kind, timezone, hour: time.hour, minute: time.minute });
    if (kind === "interval") return props.onChange({ kind, timezone, everyHours: 3, daysOfWeek: days, startHour: 9, endHour: 18 });
    props.onChange({ kind, timezone, daysOfWeek: days, hour: time.hour, minute: time.minute });
  };

  const changeTime = (value: string) => {
    const [hour, minute] = value.split(":").map(Number);
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || (schedule.kind !== "daily" && schedule.kind !== "weekly")) return;
    props.onChange({ ...schedule, hour, minute });
  };

  const toggleWeekday = (day: number) => {
    if (schedule.kind !== "weekly" && schedule.kind !== "interval") return;
    const daysOfWeek = schedule.daysOfWeek.includes(day)
      ? schedule.daysOfWeek.filter((value) => value !== day)
      : [...schedule.daysOfWeek, day].sort((left, right) => left - right);
    if (daysOfWeek.length > 0) props.onChange({ ...schedule, daysOfWeek });
  };

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={id("frequency")}>{routineCopy("频率", "Schedule")}</Label>
          <ScheduleSelect
            id={id("frequency")}
            value={schedule.kind}
            items={[
              { value: "once", label: routineCopy("单次", "Once") },
              { value: "daily", label: routineCopy("每天", "Daily") },
              { value: "weekly", label: routineCopy("每周", "Weekly") },
              { value: "interval", label: routineCopy("按小时间隔", "Every few hours") },
            ]}
            onChange={changeScheduleKind}
          />
        </div>
        {schedule.kind === "interval" ? (
          <div className="space-y-2">
            <Label htmlFor={id("every-hours")}>{routineCopy("间隔", "Every")}</Label>
            <ScheduleSelect
              id={id("every-hours")}
              value={schedule.everyHours}
              items={[...new Set([...INTERVAL_HOURS, schedule.everyHours])].sort((left, right) => left - right)
                .map((hours) => ({ value: hours, label: routineCopy(`${hours} 小时`, hours === 1 ? "1 hour" : `${hours} hours`) }))}
              onChange={(everyHours) => props.onChange({ ...schedule, everyHours })}
            />
          </div>
        ) : schedule.kind === "once" ? (
          <div className="space-y-2">
            <Label htmlFor={id("once-at")}>{routineCopy("运行时间", "Run at")}</Label>
            <Input
              id={id("once-at")}
              type="datetime-local"
              required
              value={automationLocalDateTimeInput(schedule.at, schedule.timezone)}
              onChange={(event) => {
                const at = automationLocalDateTimeTimestamp(event.currentTarget.value, schedule.timezone);
                if (at !== null) props.onChange({ ...schedule, at });
              }}
            />
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor={id("time")}>{routineCopy("运行时间", "Time")}</Label>
            <Input
              id={id("time")}
              type="time"
              required
              value={`${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`}
              onChange={(event) => changeTime(event.currentTarget.value)}
            />
          </div>
        )}
      </div>

      {schedule.kind === "interval" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={id("window-start")}>{routineCopy("开始", "From")}</Label>
            <ScheduleSelect
              id={id("window-start")}
              value={schedule.startHour}
              items={Array.from({ length: 24 }, (_, hour) => ({ value: hour, label: hourLabel(hour) }))}
              onChange={(startHour) => props.onChange({ ...schedule, startHour, endHour: Math.max(schedule.endHour, startHour + 1) })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={id("window-end")}>{routineCopy("结束", "Until")}</Label>
            <ScheduleSelect
              id={id("window-end")}
              value={schedule.endHour}
              items={Array.from({ length: 24 - schedule.startHour }, (_, index) => schedule.startHour + index + 1)
                .map((hour) => ({ value: hour, label: hour === 24 ? routineCopy("当天结束", "End of day") : hourLabel(hour) }))}
              onChange={(endHour) => props.onChange({ ...schedule, endHour })}
            />
          </div>
        </div>
      ) : null}

      {schedule.kind === "weekly" || schedule.kind === "interval" ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{routineCopy("运行日期", "Days")}</legend>
          <div className="flex flex-wrap gap-2">
            {WEEKDAYS.map((day) => (
              <Button
                key={day.value}
                type="button"
                size="sm"
                aria-pressed={schedule.daysOfWeek.includes(day.value)}
                variant={schedule.daysOfWeek.includes(day.value) ? "secondary" : "outline"}
                onClick={() => toggleWeekday(day.value)}
              >
                {routineCopy(day.zh, day.en)}
              </Button>
            ))}
          </div>
        </fieldset>
      ) : null}
    </>
  );
}

export function AutomationTimezoneField(props: {
  timezone: string;
  onChange: (timezone: string) => void;
  idPrefix?: string;
}) {
  const id = `${props.idPrefix ?? "automation"}-timezone`;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{routineCopy("时区", "Timezone")}</Label>
      <Input id={id} required maxLength={120} value={props.timezone} onChange={(event) => props.onChange(event.currentTarget.value)} />
    </div>
  );
}
