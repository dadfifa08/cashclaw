import { describe, expect, it } from "vitest";

import { DEFAULT_REGISTER_SKILLS, normalizeRegisterSkills } from "../src/moltlaunch/cli.js";

describe("normalizeRegisterSkills", () => {
  it("falls back to the default registration skills when the input is empty", () => {
    expect(normalizeRegisterSkills([])).toEqual([...DEFAULT_REGISTER_SKILLS]);
    expect(normalizeRegisterSkills(["   ", ""])).toEqual([...DEFAULT_REGISTER_SKILLS]);
    expect(normalizeRegisterSkills(undefined)).toEqual([...DEFAULT_REGISTER_SKILLS]);
  });

  it("trims and deduplicates explicit skills", () => {
    expect(normalizeRegisterSkills([" diagnostics ", "diagnostics", "inspection "])).toEqual([
      "diagnostics",
      "inspection",
    ]);
  });
});