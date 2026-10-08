---
name: novel-stage-production
description: Use when turning finished chapters into media or play — illustrations embedded in the text, an audio drama with one consistent voice per character and ambience, a motion comic, or an interlude the author plays as a visual novel and may turn back into a chapter.
---

# Staging a book

Everything here costs the author money and minutes per chapter. Produce it when they ask, in the order below, and tell them where to look after each step: the audio drama is the reader's listening mode (`novel_show view=listen`), the motion comic, the interludes and the pictures are on the Stage (`novel_show view=stage`).

## Consistency is built before the first picture

An image model reads prose loosely: "a church-style bun" becomes any bun, "white armour kept like new" becomes a crusader. And a model that has never seen a character draws a new person every time. So a book's pictures are consistent only when four things exist before you illustrate. Set them up in this order, and show the author each one:

1. **The art direction.** `novel_settings action=show` says what direction the book's pictures get and where it comes from. A book that has none starts from the Studio-wide one or the built-in one, and its first picture writes that text into the book. Agree on it with the author and save it (`novel_settings action=book fields={artStyle: …}`) before anything is drawn.
2. **The avoid list.** What this world does not have and an image model will draw anyway: `novel_settings action=book fields={artAvoid: ["crosses", "gothic cathedral", "stained glass"]}`. Proper nouns pull pictures toward their real-world namesakes; whenever a picture goes wrong that way, add what crept in.
3. **A visual anchor per recurring character** — `novel_bible action=derive_visual kind=character ref=<name>` distills the prose appearance into short, concrete, drawable phrases (build, face, hair as a shape, clothing by cut and material, signature items) plus what must never be drawn on them. Read it back to the author: once drawn from, it is canon. Write it yourself (`fields.visual.prompt`, `fields.visual.negative`) when you know better.
4. **A design sheet per recurring character** — `novel_illustrate kind=sheet target=<character>`: front, side and back on one sheet. Every later picture of them is drawn with it as a reference image. A character with more than one outfit gets **looks**: `novel_illustrate kind=sheet target=<character> look="丧服" prompt="plain black mourning robe, hair unbound"` creates the look and derives its sheet from the main one, so it is still the same person. Places the story returns to get reference art the same way: `novel_illustrate kind=location target=<world entry>`, from the entry's `visualPrompt` — say what the place actually looks like there, not what it is called.

The Studio keeps this order by itself: a portrait asked for somebody without a sheet draws the sheet first, and a scene, a panel or a cover does the same for whoever comes back in the book (a part that carries it, or in two chapters or more) — one more image call each, named in the tool's result, which you pass on to the author. **Ask first**: unless the author already said to go ahead, call the tool with `sheet_first=ask` — it draws nothing and says whose sheets the picture (or a chapter's panels, `novel_comic action=render sheet_first=ask`) would draw — tell them "this will first draw N design sheets: …", and draw on their answer with `sheet_first=draw`, or `skip` for "not this time". Somebody seen once and gone gets none. The author can turn it off (`image.sheetFirst = false`); drawing the sheets up front, where the author can look at each before anything is drawn against it, is still the better way.

When the author says what they want of a sheet or a portrait in one breath — some of it about the person, some of it about this picture ("a scar through the left brow, always the grey robe; this one on a snowy night") — pass it on as it came in `notes`: the director sorts it, works what is of the person into their look for good, and uses the rest for this picture only. The result says how it was sorted; tell the author. Use `prompt` for a direction you know is for this picture alone.

A **portrait** (`kind=portrait`) is drawn against the sheet and becomes the character's face in the Studio and their sprite in interludes. A **voice** — a stock voice id (`novel_audio action=voices`, `action=set_voice`), or one designed from the persona (`action=design_voice`) — is theirs for the whole book; without either, a voice is cast by gender and age the first time they speak and kept in the book's voice sheet (`novel_audio action=cast`), as it is for speakers who have no card at all.

## Illustrations

`novel_illustrate kind=scene target=<chapter> quote="…" insert=true` draws the quoted moment and embeds the picture in the chapter right after it. The analyst composes the description from the passage, the cast's anchors and the places' looks, picks each character's look by the occasion (or takes yours: `looks={"沈砚": "丧服"}`), and the sheets of the people in it go along as references. Add `avoid=[…]` for what this one picture must not show. Choose moments with a strong image and few people — three references is what one picture can hold; two or three pictures per chapter is plenty. `kind=cover` makes a cover, `kind=custom` anything else (`characters=[…]` brings their anchors and sheets; `raw=true` sends your prompt exactly as written).

The result of every call says what the picture was made of: the art direction and its source, what was kept out, and which reference images went along. When a picture comes out wrong, that is where to look first — then fix the anchor, the avoid list or the place's description rather than rewording one prompt.

## Audio drama

1. `novel_audio action=script chapter=<n>` — the analyst cuts the chapter into narration, dialogue and inner voice, attributes every line to a speaker, adds delivery directions, and designs the sound: the bed of each scene, spot effects, music, each with a caption the reader sees beside the text. Narration that follows narration is joined into takes spoken in one breath; a "he said" stranded between two spoken lines is marked as a tag and left unspoken unless the author has every word read (`tts.speechTags`). No audio yet; the author can correct speakers, directions and cues in the Studio (the reader's Listen mode opens on the script).
2. `novel_audio action=synthesize chapter=<n>` — renders the lines that have no current audio. Unchanged lines are reused, so fixing three lines re-renders three lines. Every take is checked by measurement and spoken again when it is cut short, silent or not in the speaker's voice; lines rendered earlier that fail the check are redone as well. The result says how many were retaken and how many still stand out — pass that on.
3. `novel_audio action=sound chapter=<n>` — generates the clips of the sound cues with the sound model: effects, music, and the beds unless the author keeps to browser-synthesized ones. It needs a sound model, which is the speech model itself when that is Bailian audio generation; without one the cues remain captions and beds are synthesized by the player — say so rather than promising sound. Sound models are uneven: tell the author that any cue can be heard in the script view, reworded (`novel_manage action=edit_cue`) and made again on its own (`cues=[id]`).
4. `novel_audio action=export chapter=<n>` — joins the voice track into one WAV. Sound is laid under the voices at playback and is not in the file.

A script made before narration was spoken in whole takes sounds choppy — the narrator starts over at every paragraph. `novel_audio action=reshape` brings it into the new shape without calling a model: dialogue keeps its recordings, joined narration is voiced again at the next synthesize.

**Read what the script step says.** If it warns that passages "could not be directed" and were cut by rule, the dialogue in them has no speakers and will be read in the narrator's voice — synthesizing then wastes the author's money on a flat reading. The reason is given: most often the analyst's reply was cut off by an output cap someone set on that role (`novel_settings action=show`; remove it with `action=studio patch={models: {analyst: {…, maxTokens: null}}}`). Fix the cause, run `action=script` again with `force=true`, and only then synthesize.

If a speaker is misattributed everywhere, the character card is probably missing an alias; add it and rebuild the script.

The author can read, listen and watch the motion comic on a phone: `novel_share action=on` opens the book in play to devices on the same network and gives the address (they are asked to confirm first). `mode=edit` also lets the phone edit the text and play the book's interludes — offer it when they want to play an interlude on the sofa, and say that each turn uses the models set up on their computer.

## Motion comic

`novel_comic action=storyboard chapter=<n>` cuts the audio script into panels (what is shown, who is in it, camera move) with prompts that already contain each character's anchor; `action=render` draws the panels that have no picture, each against the design sheets of the people in it and the art of its place. The Stage player shows each panel with a slow camera move while its lines are spoken. A chapter needs its audio script first; the storyboard builds it when missing.

How finely to cut is the author's decision, and every panel is a picture they pay for — ask, or use what the book is set to. `density=sparse|balanced|dense` names how long a picture stays (about 26, 13 or 6–7 seconds), `density=auto` leaves it to the storyboard director, and `max_panels` is a ceiling that always holds. Say how many panels came out before rendering them; to change the cut of a board that exists, pass `force=true`.

## Video

`novel_video action=produce chapter=<n>` turns a chapter's voice, sound and storyboard pictures into an MP4. You do not assemble it: the crew's post-production agent gets the material on one timeline and a shell, writes its own cut, checks it and hands it in — its run is a subagent of this conversation the author can open. It needs every line voiced and the panels drawn (`action=status` says what there is, and whether this computer has ffmpeg); it takes minutes and many steps of its model. Pass what the author wants of the cut in `direction` (pace, subtitles, a title card). Relay post-production's note — it says what was missing and what it chose, such as subtitles carried as a track because this ffmpeg cannot draw text.

## Interludes

An interlude is a scene the author steps into: they play one character (or direct from outside) while the director model plays everyone else from their cards, their memory up to a chosen chapter, and the situation. It never changes the canon by itself.

- Set one up with `novel_play action=start`: the `situation` in two sentences, the `cast`, the `player` (omit to let the author direct), the `anchor` chapter it branches from. Good interludes test something: a confrontation the outline skipped, a what-if, a relationship the author wants to feel before writing it.
- The author plays in the Studio with backgrounds, portraits, voices and ambience. You can also run turns in the chat (`action=turn`) when they prefer text.
- Afterwards ask what it was: `discard` (it never happened), keep as a side story, or `action=novelize` — the writer turns the transcript into a chapter in the book's style. As a chapter (the default) it goes after the anchor on the main line and is canon: digest it and adjust the outline that follows. With `as=line` it opens a **plot line** that leaves after the anchor, the session as its first chapter and the player's first move as the choice at the fork: the book keeps going the way it went, and this way stands beside it — to be continued (`novel_derive line=…`, `novel_write line=…`), or made the main line later. Offer the line when what was played contradicts what is already written after the anchor.

## Order of work for a chapter

art direction and avoid list → anchors, design sheets and voices on cards → audio script → author corrects → synthesize → storyboard → render → watch → (when asked) video. Skipping the sheets makes every panel a different person; skipping the correction step multiplies every mistake by the cost of rendering it.

## Many chapters, or everything for one chapter, in one go

When the author wants a stretch of the book staged — "voice the first ten chapters", "make chapter 3 a motion comic, the whole thing" — do not walk the steps above chapter by chapter. `novel_batch` runs them as one job with a table the author can watch (Stage → Produce in the Studio):

- `novel_batch what=stage chapters=[…] steps=[script, voice, sound]` is the audiobook of those chapters; add `storyboard, panels` for the motion comic and `video` for the cut. Left out, `steps` is everything that can be made with what is set up, without the video; left out, `chapters` is every chapter that has text. Once a chapter's script stands, its voices, its sounds and its storyboard are made side by side, and several chapters are on the line at once.
- `novel_batch what=stage action=status` says where every chapter's production stands and which steps cannot run for lack of a model. Look before a large run.
- `novel_batch what=art sheets=[all] places=[all] portraits=[all] voices=[all]` is the set-up of *Consistency is built before the first picture* for the whole cast at once: sheets and places are drawn first, portraits (and `scenes`, `cover=true`) against them. The anchors must exist before it — a sheet drawn from prose appearance is the mistake this skill starts with.

A batch only makes what is missing, so running the same call again after a stop or after failures does the rest; `redo=true` makes again what is there and pays for it again. A step that fails holds back only the steps of that chapter that needed it; the result lists what did not come about and why — pass that on rather than "done".

The step the single-chapter order protects is still the author's: a batch voices whatever the script says. For a book whose speakers the analyst has not met yet, run `steps=[script]` over the chapters first, have the author look at one or two scripts, then run the rest.

How many requests go out at once is the author's setting (8 by default; `tts.concurrency`, `image.concurrency`, `sound.concurrency`, `textConcurrency` in `novel_settings`), counted over everything that runs, not per job. When a service limits its rate the Studio slows down, resends and recovers by itself and says so in the job dock — that is not a failure to report, and not a reason to lower the figure.

Media is where the money goes. `novel_settings action=usage` says what the book has used so far — tell the author before a bulk run when they have asked about cost.
