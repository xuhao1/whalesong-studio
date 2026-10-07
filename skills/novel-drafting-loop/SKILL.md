---
name: novel-drafting-loop
description: Use when drafting chapters of a novel with the writer model — the per-chapter loop (readiness check, beats, brief, write, report, digest), how to write a good brief, and what to do when a chapter comes back wrong.
---

# The drafting loop

You are the showrunner; the writer model writes. Your leverage is in what you decide before the call and what you notice after it.

## Before the call

A chapter is ready when all of these are true. Fix whatever is not; do not hope the writer will.

- **It has a job.** The outline says what changes by the end: a decision, a loss, a revealed fact. A chapter where nothing changes is two chapters' worth of mood; merge it.
- **It has beats.** If there is only a synopsis, run `novel_derive kind=beats`. Read them: every beat should turn (someone wants something, something resists, something gives).
- **The cast is right.** Everyone listed has a reason to be in the scene. Someone the reader has not seen for many chapters needs a line that re-anchors them.
- **Memory is current.** Earlier chapters must be digested, or the writer works from stale facts. `novel_status` shows undigested chapters; run `novel_digest` first.
- **Threads are named.** Know which open threads this chapter plants, advances or pays off, and say so in the outline.

## The brief

`novel_write` already sends the writer the bible, the cast with their current states, the story so far, relevant earlier passages, the open threads, the chapter's outline and the style. The brief adds only what those cannot know:

- the emphasis ("the argument is the centre; keep the journey to two paragraphs");
- what to withhold ("she does not learn who sent it");
- the temperature ("quiet — no raised voices until the last beat");
- the landing ("end on the knock, before the door opens").

Three or four sentences. Never restate the outline, never dictate sentences, never ask for "vivid, engaging prose".

## After the call

1. Read the result the tool returns (length, opening and closing lines, cast used). Open the chapter with `novel_read` only to check something specific.
2. Tell the author, in a few lines: what happened, how long it is, and the one or two places you would look at. Do not paste the chapter; they read it in the Studio.
3. Let digest finish (it runs automatically after a write unless switched off) before the next chapter. Then settle what it left: new characters or places it found, lifecycle changes, threads — accept the obvious ones, ask about the rest.
4. "Continue" from the author means: the next chapter, same loop.

## When a chapter comes back wrong

- **Drifted from the outline** — the beats were too loose. Tighten them, then redraft (`mode=draft`); do not patch drift with revisions.
- **Right events, wrong voice** — check the style profile's "never" list and add what went wrong as a rule; revise the chapter (`novel_revise scope=chapter`) with that one instruction.
- **A character out of character** — compare with their card (personality, speech habits, what they would never do). If the card is thin, the fix belongs in the bible first.
- **One bad passage** — `novel_revise scope=passage`, quoting it exactly.
- **Too short or cut off** — `mode=continue` with a brief that says where to pick up and where to stop.
- **Facts contradict earlier chapters** — find the earlier passage (`novel_search`), decide with the author which version is canon, then revise the other.

## Pace of a long book

Every eight to ten chapters, stop drafting and take stock: run a review on the last arc, look at the cast's presence (who vanished, who is overused), check threads that have not moved, and re-outline the next arc from what the book has become rather than from the original plan.
