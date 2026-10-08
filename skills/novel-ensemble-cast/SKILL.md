---
name: novel-ensemble-cast
description: Use when a novel has many characters — planning who is on the page when, introducing and retiring characters, keeping long-absent ones alive in the reader's mind, and making each voice distinct in an ensemble (群像) story.
---

# Running an ensemble

A large cast fails in two ways: characters blur into each other, or they vanish for a hundred pages and return as strangers. Novel Studio tracks the facts — who is in which chapter along each line of the plot, in what state they were last seen, who is planned to appear — so you can make the calls.

## Where somebody is in the book

No card carries a status. A book is not one straight road — it has lines of the plot that part, and chapters that are written again long after the ones that follow them — so "active" or "dead" on a card would be true of one line at one moment and wrong everywhere else. Where somebody is, is **their life on the page**: the chapter they come on in, the stretches of chapters they are in, where they are away, where they come back, where they leave for good or die. It is read off the chapter digests, along one line of the plot; along another line it reads otherwise, and the same person can be dead on one and alive on the next.

What the writer receives follows from it, for the chapter in hand and on that chapter's own line:

- everyone's card, the same whatever the chapter: the leads and supporting parts whole, the rest a line each;
- for those in the chapter: their state after their last chapter and a line of theirs from the text;
- a list of who is out of the story **as of the chapters before this one** — the dead (may be mentioned, must not appear alive) and those who left for good (not to come back unless the outline brings them). Somebody who dies in chapter 16 is alive to the writer of chapter 5.

So there is nothing to "mark". When a death or a leaving is missing or wrong, the digest of that chapter is what is wrong: digest the chapter again (`novel_digest`), or correct the text. A card's `life` field is a paragraph telling what they go through in the book — the author's to edit, continuity's to write from the digests.

## Reading the table

`novel_status` lists the cast with the chapters each is in and, for whoever the main line has let go, the chapter of their death or leaving. `novel_read what=character` gives one person's life in a line. The Studio's People page (人物) shows everyone's life in one table (履历表): a row a person, a column a chapter of the chosen line — on the page, coming on or back, leaving, dying, planned by the outline, planned but missing — beside the cards and the relationship graph. Look for:

- **Somebody with a part, absent for five chapters or more, with no planned return.** Schedule the return, or have the text say where they went. Do not leave it undecided.
- **Planned in the outline but missing from the written chapter.** The chapter was drafted without them: decide whether the outline or the text is right.
- **Dead or gone, yet cast in a later chapter of the outline.** A continuity error waiting to happen — fix the outline now.
- **More than a dozen with a part on the page in the same chapters.** Readers hold five to seven comfortably. Rotate: let a group step back with a visible reason and a promise of return.
- **A lead without a motive or an arc on their card.** Fix the card before the next chapter leans on them.

## The people without a card

A long book fills with people who are named once or twice: a clerk, a recruit, "that lady". `novel_manage action=walkons` lists everyone the page names who has no card — gathered from chapter memories, digest suggestions, audio scripts and the voice sheet — with where each turns up. Settle them (`action=settle_walkon`):

- **A card** (`as: card`, `role: minor` or `cameo`) for those the story will come back to. They keep the voice the audio drama gave them, and their lines in the scripts go to the card.
- **An alias** (`as: alias`, `of: <character>`) when the name is a known character under another name — the list says when it looks that way. Unsettled aliases split one person into two in memory and in the audio drama.
- **Nothing** (`as: ignore`) for a passer-by. Not every name needs a card; a cast list of forty cards hides the seven that matter.

Do this after every few chapters rather than once at the end.

## Entrances

Introduce at most two new named characters per chapter. Give each a first image, a want that is visible in their first scene, and a way of speaking the reader can recognise without a tag. Create the card before the chapter (`novel_bible action=save`, then `action=expand` to let the architect develop it); characters invented mid-draft arrive as digest suggestions and are thinner.

## Absences and returns

When someone has been away, the chapter that brings them back owes the reader a re-anchor: what they have been doing, and how they changed. Put it in the brief ("Wen returns; she has been in the capital and now knows about the ledger — show it in how she talks to Shen, do not explain it"). Their state after their last chapter is in memory; read it (`novel_read what=character`) before writing the brief.

## Distinct voices

The card's persona block — traits with intensity, values in order, speech habits, things they would never do, behaviour under pressure — is what keeps voices apart. For any two characters who share scenes, check that they differ on at least two of: sentence length, vocabulary, what they avoid saying, how they show anger. Thin persona blocks produce interchangeable dialogue; `novel_bible action=expand` with a direction like "sharpen how she speaks against how Lin speaks" repairs it.

## Giving everyone a reason

Before drafting a group scene, be able to say in one clause what each person present wants from it. Cut anyone who only watches. In the outline, list them under the chapter's cast only if they act.

## Relationships

Record relationships on the cards as they change (kind and a short note). After a turning point — betrayal, confession, reconciliation — update both sides; the writer reads these when two characters meet again.
