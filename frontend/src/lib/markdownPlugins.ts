/**
 * The Comark plugin list every markdown render site shares (chat, job logs,
 * workflow runs, portal task bodies).
 *
 * Markdown rendered here comes from LLM output, tool and job logs, push
 * messages, workflow prompts and human task bodies, so none of it is trusted.
 * Two rules keep it from injecting script:
 *
 * - The `html` plugin is left out, so raw HTML stays literal text.
 * - The `security` plugin runs last. Component syntax (`:iframe{src=…}`,
 *   `::script`) builds elements without the `html` plugin, so `security` drops
 *   the dangerous tags and strips event-handler attributes and
 *   `javascript:` / `vbscript:` URLs from whatever is left.
 *
 * The `attributes` plugin is left out too: it treats `{...}` after any token
 * as an attribute block and drops it, which truncates the raw tool-call JSON in
 * job logs (`exec {"command":...}`).
 *
 * Pass the list with `registerDefaultPlugins: false`, since Comark's defaults
 * include both `html` and `attributes`.
 *
 * @module
 */

import type { ComarkPlugin } from "comark";
import alert from "comark/plugins/alert";
import components from "comark/plugins/components";
import frontmatter from "comark/plugins/frontmatter";
import linkify from "comark/plugins/linkify";
import security from "comark/plugins/security";
import taskList from "comark/plugins/task-list";

/** Tags removed from rendered markdown together with their content. */
export const BLOCKED_MARKDOWN_TAGS: readonly string[] = [
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "form",
  "base",
  "meta",
  "link",
  "style",
  "template",
];

/** Parser options for `<Markdown>`; the plugin list replaces Comark's defaults. */
export const MARKDOWN_PARSER_OPTIONS = { registerDefaultPlugins: false } as const;

/**
 * Builds the shared markdown plugin list.
 *
 * linkify keeps its strict defaults: only URLs with a scheme and emails are
 * linked, so file names like `README.md` (a valid TLD) stay plain text.
 *
 * @param extra - Render-site plugins (e.g. syntax highlighting, Mermaid),
 *   inserted before the `security` plugin so their output is checked too
 * @returns A fresh plugin list, with `security` last
 */
export function createMarkdownPlugins(extra: ComarkPlugin[] = []): ComarkPlugin[] {
  return [
    linkify(),
    frontmatter(),
    alert(),
    taskList(),
    components(),
    ...extra,
    security({ blockedTags: [...BLOCKED_MARKDOWN_TAGS] }),
  ];
}
