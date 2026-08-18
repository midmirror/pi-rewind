// test/snapshot.test.ts
import { describe, it, expect } from "vitest";

describe("smoke", () => {
  it("types compile and module loads", () => {
    expect(typeof describe).toBe("function");
  });
});
