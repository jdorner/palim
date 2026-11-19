/**
 * Scenarios of the workflow design eval (`bun run eval:workflows`).
 *
 * Each scenario is one chat message that contains every decision, so the
 * agent can write the workflow without an interview. The checks are computed
 * from the written definition (see `checks.ts`), never from the chat text.
 *
 * @module
 */

/** What a scenario expects from the written workflow. */
export interface ScenarioExpectations {
  /**
   * `required`: an `iterator` with at least one `agent` step in its body.
   * `forbidden`: no `iterator` at all.
   */
  loop: "required" | "forbidden";
  /** Step types the workflow must contain at least once. */
  stepTypes?: string[];
  /**
   * Whether an agent step's result must have fixed fields when another step
   * references it. False where handing on free text is the right design (one
   * summary that a notification sends as is); the `schema` check is then skipped.
   */
  structuredHandoff: boolean;
  /**
   * Result fields of an agent step that the prompt says may be empty. Each
   * must appear in an agent `outputSchema` with the hint `"any"`, the only
   * hint that accepts `null`. Omit when no field may be empty.
   */
  nullableFields?: string[];
}

/** One eval scenario. */
export interface Scenario {
  /** Short id, shown in the result table. */
  name: string;
  /** The single user message sent to the chat agent. */
  prompt: string;
  /** What the written workflow is checked against. */
  checks: ScenarioExpectations;
}

/** Appended to every prompt so the agent writes instead of interviewing. */
const NO_QUESTIONS = "Do not ask questions. Write the workflow as a draft now.";

/**
 * Extensions the eval deployment enables, by name. Built-in ones load from the
 * repository; the others are copied from the configured deployment's
 * `DATA_DIR/extensions` when installed there. All of them load without
 * secrets, which a fresh eval deployment does not have.
 */
export const EVAL_EXTENSIONS: readonly string[] = [
  "ntfy",
  "converter",
  "web-fetch",
  "datatables",
  "imap-fetch",
  "sandbox-exec",
  "json-parse",
];

/** The scenarios, in the order they are run and reported. */
export const SCENARIOS: readonly Scenario[] = [
  {
    name: "email-tagging",
    prompt: [
      'Build me a workflow named "eval-email-tagging".',
      "It runs every day at 07:00.",
      'It fetches the unread mails from the INBOX with the imap-fetch step (authType "account", account "gmail"), including the mail body, at most 50 mails.',
      'It decides for each mail whether it is an "invoice", an "ad" or "other".',
      "It does not change the mailbox.",
      'At the end it sends one notification with the notify-ntfy step to the topic "mail-report" that says how many mails were classified.',
      NO_QUESTIONS,
    ].join(" "),
    checks: { loop: "required", stepTypes: ["imap-fetch", "notify-ntfy"], structuredHandoff: true },
  },
  {
    name: "folder-files",
    prompt: [
      'Build me a workflow named "eval-pdf-intake". It is started manually.',
      'First the imap-attachments step (authType "account", account "gmail") saves the PDF attachments of the unread mails in the INBOX to the folder "intake".',
      'Then every saved file is handled on its own: the convert step turns the PDF into text, an agent reads the text and extracts sender, date and total, and the datatable-insert step stores one row per file in the table "documents" (columns: file, sender, date, total).',
      'At the end it sends one notification with the notify-ntfy step to the topic "intake" that says how many files were stored.',
      NO_QUESTIONS,
    ].join(" "),
    checks: {
      loop: "required",
      stepTypes: ["imap-attachments", "convert", "datatable-insert"],
      structuredHandoff: true,
    },
  },
  {
    name: "digest",
    prompt: [
      'Build me a workflow named "eval-news-digest". It is started manually.',
      "It fetches https://hn.algolia.com/api/v1/search?tags=front_page with the http-request step. The response is JSON; its field hits is the list of headlines (each with title and url).",
      "An agent then writes ONE summary of all headlines together, five sentences long.",
      'The summary is sent with the notify-ntfy step to the topic "news".',
      NO_QUESTIONS,
    ].join(" "),
    checks: { loop: "forbidden", stepTypes: ["http-request", "notify-ntfy"], structuredHandoff: false },
  },
  {
    name: "single-webhook",
    prompt: [
      'Build me a workflow named "eval-order-notify".',
      'It is started by a webhook named "eval-order". The webhook payload has the fields orderId (string), customer (string) and total (number).',
      'It sends one notification with the notify-ntfy step to the topic "orders" with the text "New order <orderId> from <customer>: <total> EUR".',
      "Nothing else happens.",
      NO_QUESTIONS,
    ].join(" "),
    checks: { loop: "forbidden", stepTypes: ["notify-ntfy"], structuredHandoff: true },
  },
  {
    name: "approval",
    prompt: [
      'Build me a workflow named "eval-expense-approval". It is started manually with the fields amount (number) and reason (string).',
      'A human task asks the role "admin" to decide. It shows amount and reason and has exactly two outcomes: "approve" and "reject". It has no deadline and no form fields.',
      'After "approve" it sends a notification with the notify-ntfy step to the topic "expenses" with the text "Expense approved".',
      'After "reject" it sends a notification with the notify-ntfy step to the topic "expenses" with the text "Expense rejected".',
      NO_QUESTIONS,
    ].join(" "),
    checks: { loop: "forbidden", stepTypes: ["humanTask", "case", "notify-ntfy"], structuredHandoff: true },
  },
  {
    name: "optional-fields",
    prompt: [
      'Build me a workflow named "eval-mail-triage". It is started manually with the fields subject (string) and text (string).',
      'An agent reads the mail and decides its category: "invoice", "ad", or no category at all when it is neither.',
      "It also extracts the invoice number, which stays empty when the mail has none.",
      'Then the datatable-insert step stores one row in the table "triage" with the columns subject, category and invoiceNumber.',
      NO_QUESTIONS,
    ].join(" "),
    checks: {
      loop: "forbidden",
      stepTypes: ["datatable-insert"],
      structuredHandoff: true,
      nullableFields: ["category", "invoiceNumber"],
    },
  },
];
