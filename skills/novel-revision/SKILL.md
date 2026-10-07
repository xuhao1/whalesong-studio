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
| one chapter | `novel_revise scope=chapter` | For structure, pacing or voice problems across the chapter. Not for adding plot — change the outline and redraft instead. |
| the whole manuscript | `novel_revise scope=book` | One instruction ("rename X to Y and adjust the passages around it"). Triage decides which chapters it touches; each comes back as a proposal. |

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

## Proposals

Revisions from the Studio always wait as proposals. Yours apply directly unless the author switched on "review the showrunner's revisions" — then tell them proposals are waiting and where (Review tab). `scope=accept` / `scope=reject` settle one by id when the author decides in the chat.

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
