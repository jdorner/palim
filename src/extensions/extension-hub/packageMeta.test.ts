import { describe, expect, test } from "bun:test";
import { HubError } from "./errors";
import { assertSafeRef, assertSafeRemoteUrl, remoteOrigin } from "./git";
import { compareVersions, isPrerelease, parsePackageMeta, parseReleaseTag, readmeSummary } from "./packageMeta";

describe("parsePackageMeta", () => {
  test("accepts a package named after its folder with a semver version", () => {
    const result = parsePackageMeta(JSON.stringify({ name: "foo", version: "1.2.3", description: " Foo " }), "foo");
    expect(result).toEqual({ ok: true, meta: { name: "foo", version: "1.2.3", description: "Foo" } });
  });

  test.each([
    [null, "missing"],
    ["{", "not valid JSON"],
    [JSON.stringify({ name: "foo" }), "name and version"],
    [JSON.stringify({ name: "bar", version: "1.0.0" }), "does not match folder"],
    [JSON.stringify({ name: "foo", version: "v1.0" }), "not a semver version"],
  ])("rejects %p", (raw, reason) => {
    const result = parsePackageMeta(raw, "foo");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reason);
  });
});

describe("parseReleaseTag", () => {
  test("parses <name>@<version>", () => {
    expect(parseReleaseTag("imap-fetch@1.3.0")).toEqual({ name: "imap-fetch", version: "1.3.0", prerelease: false });
    expect(parseReleaseTag("foo@2.0.0-rc.1")).toEqual({ name: "foo", version: "2.0.0-rc.1", prerelease: true });
  });

  test.each(["v1.0.0", "foo", "@1.0.0", "foo@1.0", "Foo@1.0.0", "foo@bar"])("ignores %p", (tag) => {
    expect(parseReleaseTag(tag)).toBeNull();
  });
});

describe("versions", () => {
  test("compares semver including prereleases", () => {
    const sorted = ["1.0.0", "2.0.0-rc.1", "1.10.0", "1.2.0", "2.0.0"].sort(compareVersions);
    expect(sorted).toEqual(["1.0.0", "1.2.0", "1.10.0", "2.0.0-rc.1", "2.0.0"]);
    expect(isPrerelease("2.0.0-rc.1")).toBe(true);
    expect(isPrerelease("2.0.0+build.1")).toBe(false);
  });
});

describe("readmeSummary", () => {
  test("returns the first prose paragraph", () => {
    expect(readmeSummary("# Title\n\n```sh\nx\n```\n\nDoes   things\nwell.\n\nMore.")).toBe("Does things well.");
    expect(readmeSummary(null)).toBeNull();
    expect(
      readmeSummary(
        "# x\n\nA Palim extension that adds an `imap-fetch` step, built on [ImapFlow](https://imapflow.com/), with **System-1** _support_ and snake_case_name.",
      ),
    ).toBe(
      "A Palim extension that adds an imap-fetch step, built on ImapFlow, with System-1 support and snake_case_name.",
    );
  });
});

describe("input validation", () => {
  test.each(["main", "foo@1.0.0", "release/1.x"])("accepts ref %p", (ref) => {
    expect(assertSafeRef(ref)).toBe(ref);
  });

  test.each(["-x", "--upload-pack=evil", "a..b", "a b", "x.lock", "x/", ""])("rejects ref %p", (ref) => {
    expect(() => assertSafeRef(ref)).toThrow(HubError);
  });

  test.each([
    "ssh://git@git.example.com:10022/joe/palim-extensions.git",
    "https://github.com/acme/ext.git",
    "git@github.com:acme/ext.git",
    "file:///srv/repo.git",
    "/srv/repo.git",
  ])("accepts URL %p", (url) => {
    expect(assertSafeRemoteUrl(url)).toBe(url);
  });

  test.each(["ext::sh -c touch% /tmp/pwned", "-uhttps://x", "relative/path", "https://a b"])(
    "rejects URL %p",
    (url) => {
      expect(() => assertSafeRemoteUrl(url)).toThrow(HubError);
    },
  );

  test.each([
    "https://x-access-token:secret@github.com/acme/ext.git",
    "https://secret@github.com/acme/ext.git",
    "http://user:pw@git.example.com/ext.git",
    "ssh://git:pw@git.example.com/ext.git",
    "git://user@git.example.com/ext.git",
  ])("rejects credentials in URL %p without echoing them", (url) => {
    expect(() => assertSafeRemoteUrl(url)).toThrow(/must not contain credentials/);
  });

  test("derives the origin a token is bound to", () => {
    expect(remoteOrigin("https://github.com/acme/a.git")).toBe(remoteOrigin("https://GitHub.com/other/b.git"));
    expect(remoteOrigin("https://github.com/a.git")).not.toBe(remoteOrigin("http://github.com/a.git"));
    expect(remoteOrigin("https://github.com/a.git")).not.toBe(remoteOrigin("https://evil.example/a.git"));
    expect(remoteOrigin("git@github.com:acme/a.git")).toBe("ssh://github.com");
    expect(remoteOrigin("/srv/a.git")).toBe(remoteOrigin("file:///srv/b.git"));
  });
});
