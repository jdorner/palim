---

name: workflow-design
description: Read this FIRST whenever the user asks for a new workflow that does not exist yet, even when they already describe some of its steps ("build me a workflow that...", "I need a workflow for...", "I need an approval process for...", "set up a pipeline where someone reviews...") - interview, write a draft early, add approvals, forms and branches one confirmed change at a time; not for a task already solved in this chat (that is workflow-crystallize)
---

# Design a workflow in conversation

The user describes a process that does not exist yet. Build it with them over several turns, in small confirmed steps. Do not guess the whole workflow at once. Assignees, choices, form fields, and branch targets are the user's decisions: ask, do not invent them.

Follow these steps in order.

1. **Prepare.** Before you ask anything:
   - Run `skill read workflow-writing`. Its checklist and rules still apply.
   - Run `workflow list` and apply the duplicate guardrail from the `workflows` skill.
   - Run `workflow step-types`, so you know which step types this deployment offers.

2. **Interview, one topic per message.** Ask at most three questions per message. Offer a default for each question, so the user can answer "ok". Do not ask what you can look up yourself. Topics, in this order:
   1. **Start:** what starts the workflow, and which values differ from run to run. These become the trigger and its `outputSchema`.
   2. **Main path:** what happens, step by step, when everything goes well.
   3. **People:** where a person must decide or supply data. For each such point: who (users or roles), which choices, which form fields, and whether there is a deadline and what happens when it passes.
   4. **Branches:** what happens after each choice, one choice at a time.
   5. **End:** who is told, what is stored, and what should happen when a step fails.

3. **Write early.** As soon as the main path is known, write it as a draft with the trigger the user wants: `workflow write --draft "<name>" '<json5>'`, then `workflow validate "<name>"`. If the trigger needs a webhook, schedule, or watcher, create that first. A draft ignores its trigger, so nothing fires yet.

4. **Grow it one change per turn.** Add the human task, then the `case`, then one branch at a time. For each change, run `workflow read "<name>"`, change only that part, and write it back with `workflow write "<name>" '<json5>'`. After each change:
   - run `workflow validate "<name>"` and resolve every warning,
   - show the outline (step 5),
   - ask the next question.

   Never change a step the user did not ask about. Copy all other steps exactly as `workflow read` showed them.

5. **Show the outline after every change.** A table with one row per step:

   | Step      | Type        | What it does            | Leads to                            |
   | --------- | ----------- | ----------------------- | ----------------------------------- |
   | `extract` | `convert`   | reads the receipt       | `review`                            |
   | `review`  | `humanTask` | approve, reject, rework | `route`                             |
   | `route`   | `case`      | branches on the answer  | approve: `notify`, reject: `notify` |
   | `notify`  | `notify-*`  | tells who decided       | (end)                               |

   Below the table, a list **Open points**: every choice the user has not decided yet, and every outcome that has no branch yet (e.g. "`rework`: no branch yet"). The workflow is not finished while this list has entries.

6. **Rules for human tasks.**
   - Every outcome id gets a `case` path, or the `case` gets a `default`.
   - Add the path `expired` only together with `"onTimeout": "expire"` and a `timeout`.
   - Outcome ids, `case` paths, and edge `branch` values are the same strings. Copy them, do not retype them.
   - Read the result only through the fields listed by `workflow step-types humanTask` (`outcome`, `data`, `comment`, `respondedBy`). Do not invent others.
   - A workflow with a `portal` trigger must be saved once in the workflow editor by the user before the portal can start it. Tell the user.

7. **Test each branch.** One run covers one branch.
   - Propose `workflow trigger "<name>" '<json>'` and run it only after the user agrees. Warn about side effects (messages sent, files written).
   - For a human task: tell the user where the task appears (the portal) and which answer to give. Wait until they say it is done, then read `workflow logs "<run-id>"`.
   - Repeat for each outcome, or name the branches left untested and get the user's agreement.

8. **Let the user activate it.** Tell the user the workflow is a draft: it runs only by hand until they open it in the workflow editor and click **Activate**. Never remove `draft` yourself.
