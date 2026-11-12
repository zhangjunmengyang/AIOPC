"""Local clock schedules using the same fields and DST rules as Automations."""

from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

DAY = timedelta(days=1)
MINUTE = timedelta(minutes=1)


def _number(value, label, lower, upper):
    if type(value) is not int or not lower <= value <= upper:
        raise ValueError(f"{label}应为 {lower}–{upper} 的整数")
    return value


def parse_schedule(value: dict) -> dict:
    if not isinstance(value, dict):
        raise ValueError("请选择调度时间")  # noqa: TRY004 - public validation error
    kind = value.get("kind")
    if kind not in ("once", "daily", "weekly", "interval"):
        raise ValueError("本地例行任务支持单次、每天、每周和按小时间隔")
    zone = value.get("timezone")
    try:
        if not isinstance(zone, str) or not zone.strip() or len(zone) > 120:
            raise ValueError
        zone = zone.strip()
        ZoneInfo(zone)
    except (ValueError, ZoneInfoNotFoundError):
        raise ValueError("请输入有效的时区，例如 Asia/Shanghai") from None
    result = {"kind": kind, "timezone": zone}
    if kind == "once":
        return {**result, "at": _number(value.get("at"), "时间", 0, 253402214400000)}
    if kind in ("weekly", "interval"):
        days = value.get("daysOfWeek", list(range(7)) if kind == "interval" else None)
        if not isinstance(days, list) or not 1 <= len(days) <= 7:
            raise ValueError("至少选择一天")
        result["daysOfWeek"] = sorted({_number(day, "星期", 0, 6) for day in days})
    if kind == "interval":
        start = _number(value.get("startHour", 0), "开始小时", 0, 23)
        end = _number(value.get("endHour", 24), "结束小时", start + 1, 24)
        return {**result, "startHour": start, "endHour": end,
                "everyHours": _number(value.get("everyHours"), "间隔小时", 1, 24)}
    return {**result, "hour": _number(value.get("hour"), "小时", 0, 23),
            "minute": _number(value.get("minute"), "分钟", 0, 59)}


def _wall_time(date, hour, minute, zone):
    local = datetime.combine(date, time(hour, minute))
    # fold=0 picks the first instant when the clock repeats. The round trip
    # detects a skipped wall time and advances it to the first valid minute.
    while local.date() == date:
        utc = local.replace(tzinfo=zone, fold=0).astimezone(UTC)
        if utc.astimezone(zone).replace(tzinfo=None) == local:
            return int(utc.timestamp() * 1000)
        local += MINUTE
    return None


def _occurrences(schedule, pivot, direction):
    zone = ZoneInfo(schedule["timezone"])
    day = datetime.fromtimestamp(pivot / 1000, tz=zone).date()
    if schedule["kind"] == "interval":
        times = [(hour, 0) for hour in range(schedule["startHour"], schedule["endHour"], schedule["everyHours"])]
    else:
        times = [(schedule["hour"], schedule["minute"])]
    for offset in range(9):
        current = day + offset * direction * DAY
        if schedule["kind"] != "daily" and (current.weekday() + 1) % 7 not in schedule["daysOfWeek"]:
            continue
        candidates = {_wall_time(current, hour, minute, zone) for hour, minute in times}
        yield from sorted(candidates - {None}, reverse=direction == -1)


def next_occurrence(schedule: dict, after: int) -> int | None:
    if schedule["kind"] == "once":
        return schedule["at"] if schedule["at"] > after else None
    return next((item for item in _occurrences(schedule, after, 1) if item > after), None)


def latest_occurrence(schedule: dict, at: int) -> int | None:
    if schedule["kind"] == "once":
        return schedule["at"] if schedule["at"] <= at else None
    return next((item for item in _occurrences(schedule, at, -1) if item <= at), None)
