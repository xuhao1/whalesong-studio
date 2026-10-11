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
- **What it goes by has been read.** A book that goes by other books (`novel_reference` lists them, with what of each is open and how the author wants each used) has the planner read them for a chapter before it is written, and leave notes on the chapter's plan (`referenceNotes`) — the writer has no tools and sees the references only through those. The pass runs by itself unless the author turned it off; `novel_reference action=consult chapter=<n>` runs it now, with `direction` for what to look for. Read the notes before a chapter that leans on a reference: they are the author's to correct, and yours to point out when they took the wrong thing. When the author says how a reference should be used, put it on the reference (`action=update note=…`), not into each brief.

## The brief

`novel_write` already sends the writer the bible, the cast with their current states, the story so far — the chapters nearest to this one word for word, as many as half the model's window holds, and a line per chapter for everything older — relevant earlier passages, the open threads, the chapter's outline and the style. When the chapter is not the last one written (a redraft in the middle of the book), the chapters after it go along too, and the writer is held to them. The brief adds only what those cannot know:

- the emphasis ("the argument is the centre; keep the journey to two paragraphs");
- what to withhold ("she does not learn who sent it");
- the temperature ("quiet — no raised voices until the last beat");
- the landing ("end on the knock, before the door opens").

Three or four sentences. Never restate the outline, never dictate sentences, never ask for "vivid, engaging prose".

**Length is the author's to give.** A chapter may carry a recommended length in its plan, the book a default; `words` on the call is for when the author names one now. When nobody did, pass none: the writer is told to judge from the beats and from how long this book's chapters run, and that is better than a figure you made up.

## After the call

1. Read the result the tool returns (length, opening and closing lines, cast used). Open the chapter with `novel_read` only to check something specific.
2. Tell the author, in a few lines: what happened, how long it is, and the one or two places you would look at. Do not paste the chapter; they read it in the Studio.
3. Let digest finish (it runs automatically after a write unless switched off) before the next chapter. Then settle what it left: new characters or places it found, threads — accept the obvious ones, ask about the rest. (Who came on, left or died needs no settling: it is read off the digest itself.)
4. "Continue" from the author means: the next chapter, same loop.

## A run of chapters

"Write the next five", "draft the rest of the volume": `novel_batch what=text steps=[beats, write, digest] count=5` is this loop as one job — beats derived where a chapter has none, each chapter digested before the next is written, so every chapter has read what the one before it actually said. It is right when the outline of the stretch is settled and the author wants pages; it is wrong when each chapter needs a decision from them first. Say what it will write and get their go-ahead, and when it is over read the result the way you would read one chapter's — which chapters came out, which did not and why — then settle what the digests left. Without `write`, the same call brings many chapters up to date at once: `steps=[digest]` for a book with undigested chapters, `steps=[review]` for an arc.

Writing chapter after chapter is also what the model's cache is built for: each request is the last one plus one chapter. Nothing to do about it — but it is why a run is cheaper per chapter than the same chapters written days apart.

## When the story forks

A book can hold more than one way the story goes: the main line, and plot lines beside it (`novel_status` lists them). When the chapter just written is one that lines leave from, "continue" is a question — ask the author which way, naming each line by its choice, and pass `line` to `novel_write` (or to `novel_batch`). A line's chapter is written with the line's own story behind it, not the main line's.

## When a chapter comes back wrong

- **Drifted from the outline** — the beats were too loose. Tighten them, then redraft (`mode=draft`); do not patch drift with revisions. A redraft of a chapter that has chapters after it is written to lead into them: if the point of the redraft is to change where the story goes, change the outline after it first (`novel_derive after=<chapter> mode=replace`, or `mode=branch` to keep both ways).
- **Right events, wrong voice** — check the style profile's "never" list and add what went wrong as a rule; revise the chapter (`novel_revise scope=chapter`) with that one instruction.
- **A character out of character** — compare with their card (personality, speech habits, what they would never do). If the card is thin, the fix belongs in the bible first.
- **One bad passage** — `novel_revise scope=passage`, quoting it exactly.
- **Too short or cut off** — `mode=continue` with a brief that says where to pick up and where to stop.
- **Facts contradict earlier chapters** — find the earlier passage (`novel_search`), decide with the author which version is canon, then revise the other.

## Pace of a long book

Every eight to ten chapters, stop drafting and take stock: run a review on the last arc, look at the cast's presence (who vanished, who is overused), check threads that have not moved, and re-outline the next arc from what the book has become rather than from the original plan.
