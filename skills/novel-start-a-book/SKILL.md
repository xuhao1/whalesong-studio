---
name: novel-start-a-book
description: Use when the author wants to begin a new novel from an idea, or bring an existing manuscript into Whalesong Studio — how to interview, lay the foundation (premise, cast, world, style, opening outline) and hand over a project that is ready to draft.
---

# Starting a book

A project is ready to draft when four things hold: the premise names a want, an obstacle and a cost; the leads have a motive and a flaw that the plot can press on; the world has rules that limit as much as they allow; and the first chapters are outlined with beats. Everything below serves that.

## From an idea

1. **Listen before building.** Ask at most three questions, and only ones whose answers change the book: whose story it is, what they want that they cannot simply have, and what feeling the author is chasing (name two or three books or films as coordinates). Do not ask about things you can propose.
2. **Offer directions, not a form.** Give two or three sharply different takes on the idea — different protagonists, stakes or tones — each in three sentences, with what it would cost the story. Let the author pick or blend.
3. **Lay the foundation in one pass** with `novel_init` (title, language, genre) and `novel_derive kind=foundation` (the idea plus what the author chose). It writes the premise, the main cast, the core world entries, the volumes and the opening chapters.
4. **Walk the author through it** in the Studio (Bible and Outline). Say what you would change and why. Typical weak spots of a first foundation: an antagonist without a reasonable motive, a world rule with no price, supporting characters who exist only to help.
5. **Set the style before the first chapter.** Ask for a sample passage the author loves and learn it (`novel_bible action=learn_style`), or describe the voice together (point of view, tense, diction, rhythm, what to avoid). A style profile with three concrete "never" rules is worth more than a page of adjectives.
6. **Outline three chapters deep.** Each needs a synopsis, a purpose and beats (`novel_derive kind=beats`). Do not outline the whole book in detail: plans beyond the next arc go stale as the prose teaches you who the characters are.

## From an existing manuscript

1. Create the project (`novel_init`), then `novel_import` with the file path — a `.txt`, `.md`, `.epub` or `.docx` inside the workspace. Import splits chapters (it recognises 第N章 / Chapter N / Markdown headings, and falls back to even cuts), digests each one into memory, merges character cards and world entries from what the text shows, rebuilds the outline and learns the style. If the analysis fails for lack of a model or a key, check the setup (`novel_settings action=show`), open the settings for the author (`novel_show view=settings`) and run the import again.
   A manuscript in another language than the book is to be read in: create the project in the language the author wants (`novel_init language=…`) and import with `translate_from` (the manuscript's language, or `auto`). The names are settled out of the text first — the glossary —, every chapter is translated by it, and its original is kept as a version; the digests, cards and outline are then read off the translation. Look the glossary over with the author afterwards (`novel_translate action=terms`): a name rendered badly is corrected there (`action=set_terms`) and the chapters that use it translated again from their originals.
2. Read the result critically with the author. Imported cards describe what is on the page, not what the author intends — ask about arcs, secrets and the ending, and add them (`novel_bible`).
3. Confirm the threads. Import marks foreshadowing and open questions as unconfirmed; go through them (`novel_read what=threads`) and keep, rename or drop each.
4. From there the book continues like any other: outline the next chapters, then draft.

## What to leave to the author

The premise, a character's fate, the ending, anything in the "never" list of the style. Bring a recommendation and its cost; do not decide these alone.
