/**
 * Five-field cron (minute hour day-of-month month day-of-week), in local time.
 * Supports `*`, numbers, lists, ranges, steps and the @hourly/@daily/@weekly/
 * @monthly/@yearly shortcuts. Sunday is 0 (7 also works).
 */

type Field = Set<number>;
type Cron = {
  minute: Field;
  hour: Field;
  dom: Field;
  month: Field;
  dow: Field;
  anyDom: boolean;
  anyDow: boolean;
};

const SHORTCUTS: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

function field(text: string, min: number, max: number, name: string): Field {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1)
      throw new Error(`Bad step in ${name}: ${part}`);
    let from = min;
    let to = max;
    if (range !== "*") {
      const [a, b] = range.split("-");
      from = Number(a);
      to = b === undefined ? (stepText === undefined ? from : max) : Number(b);
    }
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < min ||
      to > max ||
      from > to
    ) {
      throw new Error(`Bad ${name}: ${part} (allowed ${min}-${max})`);
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

export function parseCron(expression: string): Cron {
  const text = SHORTCUTS[expression.trim().toLowerCase()] ?? expression.trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 5)
    throw new Error(
      "A cron schedule has five fields: minute hour day month weekday.",
    );
  const dow = field(parts[4], 0, 7, "weekday");
  if (dow.has(7)) {
    dow.delete(7);
    dow.add(0);
  }
  return {
    minute: field(parts[0], 0, 59, "minute"),
    hour: field(parts[1], 0, 23, "hour"),
    dom: field(parts[2], 1, 31, "day of month"),
    month: field(parts[3], 1, 12, "month"),
    dow,
    anyDom: parts[2] === "*",
    anyDow: parts[4] === "*",
  };
}

function dayMatches(cron: Cron, date: Date): boolean {
  if (!cron.month.has(date.getMonth() + 1)) return false;
  const dom = cron.dom.has(date.getDate());
  const dow = cron.dow.has(date.getDay());
  // Standard cron: when both day fields are restricted, either one matching is enough.
  if (cron.anyDom) return dow;
  if (cron.anyDow) return dom;
  return dom || dow;
}

/** The first time strictly after `after` that the expression matches, or null within ~5 years. */
export function nextCronRun(expression: string, after: Date): Date | null {
  const cron = parseCron(expression);
  const date = new Date(after.getTime());
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);
  const limit = after.getTime() + 5 * 366 * 24 * 60 * 60 * 1000;
  while (date.getTime() <= limit) {
    if (!dayMatches(cron, date)) {
      date.setDate(date.getDate() + 1);
      date.setHours(0, 0, 0, 0);
      continue;
    }
    if (!cron.hour.has(date.getHours())) {
      date.setHours(date.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!cron.minute.has(date.getMinutes())) {
      date.setMinutes(date.getMinutes() + 1, 0, 0);
      continue;
    }
    return date;
  }
  return null;
}
