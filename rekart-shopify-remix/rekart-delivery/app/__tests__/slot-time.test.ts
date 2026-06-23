import { describe, it, expect } from "vitest";

import { minutesToTime } from "../slot-time";

describe("minutesToTime", () => {
  it("formats morning times", () => {
    expect(minutesToTime(270)).toBe("04:30 AM");
  });
  it("formats midnight as 12:00 AM", () => {
    expect(minutesToTime(0)).toBe("12:00 AM");
  });
  it("formats noon as 12:00 PM", () => {
    expect(minutesToTime(720)).toBe("12:00 PM");
  });
  it("formats evening times", () => {
    expect(minutesToTime(1110)).toBe("06:30 PM");
  });
});
