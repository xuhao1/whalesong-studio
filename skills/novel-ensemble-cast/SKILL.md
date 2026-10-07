---
name: novel-ensemble-cast
description: Use when a novel has many characters — planning who is on the page when, introducing and retiring characters, keeping long-absent ones alive in the reader's mind, and making each voice distinct in an ensemble (群像) story.
---

# Running an ensemble

A large cast fails in two ways: characters blur into each other, or they vanish for a hundred pages and return as strangers. Novel Studio tracks the facts — who appeared where, in what state they were last seen, who is planned to appear — so you can make the calls.

## The lifecycle

Every character card carries a status. Keep it true; the writer and the context packer rely on it.

| Status | Meaning | What the writer receives |
|---|---|---|
| `planned` | designed, not yet on the page | their card, only when the chapter's outline casts them |
| `active` | part of the running story | in the scene: the full card, their state after their last chapter and a line of theirs from the text; otherwise a one-line reminder |
| `offstage` | alive, away for a stretch | a one-line reminder, so they can be mentioned |
| `retired` | their story is finished | nothing, unless the outline casts them |
| `dead` | dead in canon | their name on a list of the dead: may be mentioned, must not appear alive |

Digest proposes status changes when the text shows an entrance, an exit or a death. Settle those suggestions promptly (`novel_bible action=accept_suggestion`); a card that says `active` for someone buried in chapter 12 will mislead every later chapter.

## Reading the board

`novel_status` lists the cast with chapters since each was last seen. The Studio's Cast view shows the same as a board, a presence grid (written, planned, planned-but-missing) and the relationship graph. Look for:

- **Active and absent for five chapters or more, with no planned return.** Either schedule the return or mark them `offstage`. Do not leave it undecided.
- **Planned in the outline but missing from the written chapter.** The chapter was drafted without them: decide whether the outline or the text is right.
- **Dead or retired, yet cast in an upcoming chapter.** A continuity error waiting to happen — fix the outline now.
- **More than a dozen active at once.** Readers hold five to seven comfortably. Rotate: send a group offstage with a visible reason and a promise of return.
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
