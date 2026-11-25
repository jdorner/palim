import { describe, expect, test } from "bun:test";
import { parseMarkdown } from "comark";
import mermaid from "comark/plugins/mermaid";
import rangi from "comark/plugins/rangi";
import { githubDark, githubLight } from "rangi/themes";
import { createMarkdownPlugins, MARKDOWN_PARSER_OPTIONS } from "./markdownPlugins";

/** The plugin lists the render sites use: chat (with highlighting and Mermaid) and the portal. */
const SITES = {
  chat: () =>
    createMarkdownPlugins([rangi({ theme: { light: githubLight, dark: githubDark }, preStyles: true }), mermaid()]),
  portal: () => createMarkdownPlugins(),
};

/** Payloads that produced script-capable elements before (TD-02, TD-03). */
const PAYLOADS = [
  '<iframe src="javascript:alert(1)"></iframe>',
  '<a href="javascript:alert(1)">x</a>',
  '<img src=x onerror="alert(1)">',
  "<script>alert(1)</script>",
  '<form action="javascript:alert(1)"><button>x</button></form>',
  '::iframe{src="javascript:alert(1)"}\n::',
  ':iframe{src="javascript:alert(1)"}',
  "::script\nalert(1)\n::",
  ':img{src="x" onerror="alert(1)"}',
  '::div{onclick="alert(1)"}\nx\n::',
  ':a{href="javascript:alert(1)"}',
  ':a{href="JaVaScRiPt:alert(1)"}',
  ':a{href="vbscript:msgbox(1)"}',
  '::form{action="javascript:alert(1)"}\n::',
  ':object{data="javascript:alert(1)"}',
  ':embed{src="javascript:alert(1)"}',
  ':base{href="https://evil.example/"}',
  ':meta{http-equiv="refresh" content="0;url=javascript:alert(1)"}',
  "::style\nbody{display:none}\n::",
  "[x](javascript:alert(1))",
];

/** Element tags that must never reach the renderer. */
const FORBIDDEN_TAGS = new Set(["script", "iframe", "form", "object", "embed", "base", "meta", "link", "style"]);

type Node = string | [string, Record<string, unknown>, ...Node[]];

/** Collects every element of a parsed tree, depth first. */
function elements(nodes: Node[]): Array<[string, Record<string, unknown>]> {
  const out: Array<[string, Record<string, unknown>]> = [];
  for (const node of nodes) {
    if (typeof node === "string") continue;
    const [tag, attrs, ...children] = node;
    out.push([tag, attrs]);
    out.push(...elements(children));
  }
  return out;
}

/** Parses markdown with a site's plugin list. */
async function parse(markdown: string, site: keyof typeof SITES): Promise<Node[]> {
  const doc = await parseMarkdown(markdown, { ...MARKDOWN_PARSER_OPTIONS, plugins: SITES[site]() });
  return doc.nodes as Node[];
}

for (const site of Object.keys(SITES) as Array<keyof typeof SITES>) {
  describe(`markdown plugins (${site})`, () => {
    test.each(PAYLOADS)("leaves no script-capable element for %p", async (payload) => {
      for (const [tag, attrs] of elements(await parse(payload, site))) {
        expect(FORBIDDEN_TAGS.has(tag)).toBe(false);
        for (const [key, value] of Object.entries(attrs)) {
          expect(key.toLowerCase().startsWith("on")).toBe(false);
          if (typeof value === "string") expect(value).not.toMatch(/^\s*(javascript|vbscript):/i);
        }
      }
    });

    test("renders raw HTML as literal text", async () => {
      expect(await parse("<b>bold</b>", site)).toEqual([["p", {}, "<b>bold</b>"]]);
    });

    test("keeps links, alerts and task lists", async () => {
      const tags = elements(await parse("[x](https://example.com)\n\n> [!NOTE]\n> hi\n\n- [x] done", site));
      expect(tags).toContainEqual(["a", { href: "https://example.com" }]);
      expect(tags.some(([tag, attrs]) => tag === "blockquote" && attrs.as === "note")).toBe(true);
      expect(tags.some(([tag]) => tag === "input")).toBe(true);
    });

    test("keeps braces after tokens (no attributes plugin)", async () => {
      expect(await parse('exec {"command":"ls"}', site)).toEqual([["p", {}, 'exec {"command":"ls"}']]);
    });
  });
}

describe("markdown plugins (chat extras)", () => {
  test("still highlights code and parses Mermaid", async () => {
    const nodes = await parse("```ts\nconst a = 1;\n```\n\n```mermaid\ngraph TD; A-->B\n```", "chat");
    const tags = elements(nodes).map(([tag]) => tag);
    expect(tags).toContain("pre");
    expect(tags).toContain("span");
    expect(tags).toContain("mermaid");
  });
});
