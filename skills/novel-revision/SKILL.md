---
name: novel-revision
description: Use when changing prose that already exists — fixing a passage, reworking a chapter, applying one change across the whole book, or carrying a changed world rule or character through the manuscript without breaking continuity.
---

# Revising

Revision has one rule: change what was asked and nothing else. The tools enforce the mechanics (snapshots before every change, proposals the author accepts or rejects); your job is scope and consistency.

## Pick the smallest scope that solves it

| The problem lives in | Use | Notes |
|---|---|---|
| words the author gave you, a name, a fact, a typo | `novel_edit` | No model rewrites anything: `replace` / `insert` / `append` / `delete` / `set`, exactly. Copy `find` from `novel_read`; `all=true` for a term throughout a chapter. The result names the characters the change touches and how many later chapters exist — check them. |
| a sentence to a few paragraphs that needs rewriting | `novel_revise scope=passage` | Quote the passage exactly as it stands (copy from `novel_read`). Say what to change and what must survive. |
| one chapter, to one instruction | `novel_revise scope=chapter` | The writer goes through the chapter as an agent and changes only the places the instruction reaches — find → replace, a place at a time; the rest is not written again, so it cannot drift. Each place that changed is a small proposal (or is written in at once where yours apply directly); the result says how many places, and what the writer said of them. Nothing changed is an answer too — read the writer's note. Not for adding plot — change the outline and redraft instead. |
| one chapter, all of it | `novel_revise scope=chapter whole=true` | Only where the change is of the whole chapter: another voice or point of view throughout, the scenes in another order. The chapter is written over start to end, as one proposal. The writer says so itself when asked for places that will not do. |
| where the story goes from a chapter on | `novel_derive after=<chapter>` with `mode=replace` or `mode=branch` | Not a revision of prose but of the plan. `replace` swaps the outline after that chapter (what was written there is kept as a shelved plot line, never deleted); `branch` opens a plot line beside it so both ways stand. Ask the author which they mean when they say "rewrite the outline from here". |
| the whole manuscript | `novel_revise scope=book` | One instruction ("rename X to Y and adjust the passages around it"). The planner names the places it reaches — quoting each word for word, a sentence or two — and the writer rewrites those and nothing else: every place comes back as a small proposal of its own. A chapter is written over whole only where the request is one for all of it (voice, point of view, pace). `chapters` keeps it to the chapters named. |
| something the author noticed themselves | `novel_revise scope=lead` | Their sentence goes in `instruction` ("his glasses come and go", "the days between chapters 3 and 4 do not add up"). The planner finds where it shows — each place quoted and filed as an issue of its chapter, marked as the author's — and mends it by places, each change beneath its issue. `chapters` keeps it to those chapters; `find_only=true` files and changes nothing. Use it instead of a general review when the author already knows what is wrong; say afterwards where it was found and what changed — or, where nothing was found, where the planner looked. |
| several things a review found, together | `novel_revise scope=issues` | `issues` names them as `<chapter>:<issue id>` (or `severity=high` takes every open issue that grave or graver); `instruction` is what the author says of the batch, and what they said of single issues is kept with those. One planner reads them side by side and names the places that change — as few as mend them, also in chapters nobody named where they tell of the same facts; the writer rewrites those places and nothing else, and each comes back as a small proposal of its own (a chapter is written over whole only where the planner says places will not do). Use it rather than mending issue by issue whenever two of them touch the same fact, person or stretch of time. |

**Once the text has changed, its plan may be behind.** A chapter's plan — synopsis, what the chapter is for, place, time, cast, beats — was laid out before the chapter was written; a revision accepted, or the author's own edits, can leave it saying something the text no longer does, and whoever works from the plan next (a writer rewriting the chapter, the director, the planner deriving what follows) would go by it. `novel_derive kind=plan chapter=<n>` reads the plan off the text as it now stands, anew (`kind=beats from_text=true` the beats alone): synopsis, purpose, place, time, point of view and cast by what the chapter says, a beat for every scene from the first to the last; the notes for the writer and the threads stay, and the plan as it was is in its history. The Studio does this by itself a moment after a chapter that was digested before is changed — a proposal accepted, the chapter rewritten, an edit of yours — beats included, and puts it on the book's record; the author can switch that off (`novel_settings`: `planFollowsText`). So ask for it only where a plan is behind all the same: a book whose chapters were changed before this, or with that switched off. The author has the same on the chapter's plan (*Update the plan from the text*), and for several chapters at once in the Outline's multi-select.

**Pictures in the text stay.** A line of a chapter that reads `![caption](path)` is a picture the author placed there. Every way of changing text keeps them: the writer is told to hand them back where they stood, and one left out is put back (the result says so). With `novel_edit`, write such lines back in what you put in the place of text; a picture comes out of a chapter only when the author asks — `action=delete` with its line alone as `find`.

**Who writes the changed words** is the author's to set (novel_settings), in two settings. `mendBy` — a change made by places (`chapter` / `book` / `issues` / `lead`): the crew's model itself (the default), or the writer's model after the planner has settled the places. `rewriteBy` — a passage rewritten (`scope=passage`) and a chapter written over whole (`whole=true`, and the chapters a mending lists to be written over): the writer's model (the default), or the crew's, for an author whose writer's model does not rewrite to an instruction well. Results say which it was; do not change either unasked.

`scope=book`, `scope=issues` and `scope=lead` take `order`. Mendings do not lock each other out — the author may have one running from the Studio while you start another. `queue` (the default) waits for the ones under way and goes on from the changes they leave waiting: a chapter with a change waiting is rewritten as it would read with that accepted, and the new proposal stands for the earlier ones, so the author has one to accept (turned down, the earlier ones come back). `apart` starts at once on the text as it stands: use it when the author asks for speed and the mendings have nothing to do with each other — another line of the plot, a far part of the story.

When the author can see the Studio, a passage is usually faster for them to select there. Offer it.

## Write the instruction like an editor

Bad: "make it better", "more emotional". Good: "She should refuse without explaining herself; cut her two lines of justification and let the silence do it. Keep his last line." Name the effect, the means if you have one, and what is not to be touched.

## Carrying a bible change through the book

When a world rule, a character's nature or a name changes after chapters exist:

1. Change the bible first (`novel_bible action=save`), so every later call sees the new truth.
2. Find what it contradicts: `novel_search` for the old name, the old rule in action, scenes where the character behaves the old way. List the chapters for the author with one line each on what conflicts.
3. Decide the scope together: sometimes the old behaviour can stay as "who they were then" and only later chapters change.
4. Run `novel_revise scope=book` with an instruction that states the new fact and the boundary: "Lin is now left-handed and never raises his voice. Make his actions and dialogue match; change nothing about the plot." Pass `chapters` when you already know the list.
5. After the proposals are settled, memory is digested again for the changed chapters. Check `novel_status` and settle what digest reports.

## What the bible and the outline were before

A card, an entry of the bible, a style, a chapter's plan, a thread and the book's own info each keep how they were before every change — yours included (`novel_manage action=history`, `fields` {kind: character|world|style|plan|thread|book, of: its name}). A version is named by when and by what changed the thing after it: the author, you, a job, a version put back, its deletion. With `version`, the call shows the fields in which that version and the thing as it is now differ; without `fields`, the cards and entries that were deleted and can be had back.

When the author says a card used to say something else, or that a change of yours (or a job's) lost something, look there before rewriting from memory: `action=restore_history` puts the whole version back, or only the fields named in `fields.only` — the usual case, since the rest of the card has moved on. What the thing was until then is kept too, so nothing is lost by putting back. Pictures are no part of a version: they stay as they are. (A chapter's text has its own versions: `novel_read what=versions`, `novel_manage action=restore_version`.)

## Proposals

Revisions from the Studio always wait as proposals. Yours apply directly unless the author switched on "review the showrunner's revisions" — then tell them proposals are waiting and where (Review tab). `scope=accept` / `scope=reject` settle one by id when the author decides in the chat. What the author turned down is kept (Review → Archive): `scope=turned_down` lists it, `scope=restore` puts one back to wait — when the author says a no was a slip, not on your own.

A proposal whose passage has since been edited goes stale and cannot be applied; reject it and revise again from the current text.

## Review before revising in bulk

`novel_review` reads a chapter as an editor against the bible, memory and style, and returns issues anchored to quotes with suggested fixes. Each issue maps onto one `scope=passage` call. Review first when the author says "tighten this up" without saying where.

## When memory is what is wrong

Later chapters are written from the memory of earlier ones. If the text is right and the memory of it is not — the digest misread who took the key — correct the memory (`novel_memory`: summary, facts added or removed, a character's state at chapter end). Digesting again would only repeat the reading. If the text itself is wrong, change the text; its memory follows.

## What not to do

- Do not reach for a raw file tool to change a chapter, a card or the outline. The Studio refuses it, and for a reason: no version would be kept and memory would describe a text that no longer exists. There is a tool for every kind of change.
- Do not route a dictated sentence through the writer, and do not write a scene yourself because the edit tool would take it. `novel_edit` is for what is not writing — unless the author asks you, in so many words, to write it.

- Do not rewrite a chapter to fix a paragraph.
- Do not "improve" passages nobody asked about while you are in there.
- Do not revise around a plot hole; fix the outline and redraft the scene.
- Do not paste revised prose into the chat as if it were applied — only the tools change the manuscript.
