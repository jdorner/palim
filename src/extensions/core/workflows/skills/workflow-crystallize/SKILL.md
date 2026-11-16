---

name: workflow-crystallize
description: Turn a task you just solved in this chat into a reusable workflow - use when the user says "make that a workflow", "automate what we just did", "do this every morning", "save this as a workflow", or wants a finished chat task repeated
---

# Crystallize a chat task into a workflow

The user solved a task with you in this chat and wants it as a workflow. Rebuild what actually worked, step by step. Do not re-describe the task in one big `agent` prompt.

Follow these steps in order.

1. **Read `workflow-writing` first.** Run `skill read workflow-writing`. Its checklist and rules still apply. This skill adds only the steps below.

2. **List your calls.** Write down every tool call you made in this conversation for the task, in order, numbered. Work from the calls and their results, not from the user's wording.

3. **Find the minimal path.** Drop:
   - failed calls and their retries
   - attempts that a later call replaced
   - `skill read` calls
   - pure exploration (listing, inspecting, reading help)

   Keep only the calls whose results were used.

4. **Find the inputs.** Look at each kept call for values that would differ next time (a date, a file name, a search term, a recipient).
   - Each such value becomes `{{trigger.payload.<field>}}`. Declare every field in the trigger's `outputSchema`, e.g. `"outputSchema": { "city": "string", "days": "number" }`.
   - Fixed configuration (a URL, a channel, a folder) becomes `{{var.KEY}}`.
   - Credentials become `{{secret.KEY}}`.
   - **Never copy a credential (token, password, API key) from the conversation into the workflow.** If no secret exists for it, tell the user which secret to create.

5. **Map each kept call to a step.** Find the most deterministic step type: `workflow step-types --search "<terms>"`, then `workflow step-types <type>`. Use the exact command, URL, or arguments that worked, with inputs replaced by templates. Use an `agent` step only for judgement, summarizing, or free-form extraction. Give it the narrowest prompt, the fewest tools, and an `outputSchema`.

6. **Show the plan and ask.** Present a table with one row for every call from step 2, dropped ones included, then the list of inputs, then ask for approval. Do not write anything before the user agrees.

   | Call | What it did                   | Step (type)                      |
   | ---- | ----------------------------- | -------------------------------- |
   | 1    | listed files                  | dropped: exploration             |
   | 2    | fetched the forecast          | `fetch-weather` (`http-request`) |
   | 3    | first summary attempt, failed | dropped: failed                  |
   | 4    | summarized the forecast       | `summarize` (`agent`)            |

   Inputs: `city` (string, was "Berlin"), `days` (number, was 3).

7. **Write it as a draft.** Use the trigger the user wants (schedule, webhook, file watcher, or manual), with the inputs in its `outputSchema`. If it needs a webhook, schedule, or watcher, create that first: a draft ignores its trigger, so nothing fires yet. Then write with `workflow write --draft "<name>" '<json5>'`, run `workflow validate "<name>"`, and resolve every warning.

8. **Offer one test run.** Propose `workflow trigger "<name>" '<json>'` with this conversation's values as the payload. Warn that side effects (messages sent, files written) happen again. Run it only after the user agrees. Check the result with `workflow logs "<run-id>"` and compare it with what the conversation produced. Fix and re-test if it differs.

9. **Let the user activate it.** Tell the user the workflow is a draft: it runs only by hand until they open it in the workflow editor and click **Activate**. Never remove `draft` yourself.
