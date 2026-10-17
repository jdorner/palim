import { describe, expect, test } from "bun:test";
import { HubError } from "./errors";
import { tryGit } from "./git";

describe("tryGit", () => {
  test("returns null when git answers no", async () => {
    expect(await tryGit(["rev-parse", "--verify", "--quiet", "refs/heads/does-not-exist^{commit}"])).toBeNull();
  });

  test("throws when git times out instead of answering no", async () => {
    const run = tryGit(["-c", "alias.slow=!sleep 5", "slow"], { timeoutMs: 50 });
    await expect(run).rejects.toBeInstanceOf(HubError);
    await expect(run).rejects.toThrow(/timed out/);
  });
});
