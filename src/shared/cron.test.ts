import { describe, expect, it } from "vitest";
import { nextCronRun, parseCron } from "./cron";

const at = (text: string): Date => new Date(text);
const next = (expression: string, after: string): string | undefined =>
  nextCronRun(expression, at(after))?.toString();

describe("nextCronRun", () => {
  it("finds the next matching minute", () => {
    expect(next("*/15 * * * *", "2026-03-02T10:07:30")).toBe(
      at("2026-03-02T10:15:00").toString(),
    );
    expect(next("*/15 * * * *", "2026-03-02T10:15:00")).toBe(
      at("2026-03-02T10:30:00").toString(),
    );
  });

  it("rolls over hours, days and months", () => {
    expect(next("0 9 * * *", "2026-03-02T09:00:00")).toBe(
      at("2026-03-03T09:00:00").toString(),
    );
    expect(next("30 8 1 * *", "2026-01-31T12:00:00")).toBe(
      at("2026-02-01T08:30:00").toString(),
    );
    expect(next("@yearly", "2026-06-01T00:00:00")).toBe(
      at("2027-01-01T00:00:00").toString(),
    );
  });

  it("handles weekdays, ranges and lists", () => {
    // 2026-03-06 is a Friday; weekdays only skips to Monday.
    expect(next("0 9 * * 1-5", "2026-03-06T10:00:00")).toBe(
      at("2026-03-09T09:00:00").toString(),
    );
    expect(next("0 9,17 * * *", "2026-03-02T10:00:00")).toBe(
      at("2026-03-02T17:00:00").toString(),
    );
    expect(next("0 0 * * 7", "2026-03-02T10:00:00")).toBe(
      at("2026-03-08T00:00:00").toString(),
    );
  });

  it("matches either day field when both are set", () => {
    // The 15th, or any Monday: Monday 2026-03-09 comes first.
    expect(next("0 0 15 * 1", "2026-03-03T00:00:00")).toBe(
      at("2026-03-09T00:00:00").toString(),
    );
  });

  it("returns null when the date never comes", () => {
    expect(nextCronRun("0 0 31 2 *", at("2026-01-01T00:00:00"))).toBeNull();
  });

  it("rejects bad expressions", () => {
    expect(() => parseCron("* * *")).toThrow(/five fields/);
    expect(() => parseCron("61 * * * *")).toThrow(/minute/);
    expect(() => parseCron("*/0 * * * *")).toThrow(/step/);
  });
});
