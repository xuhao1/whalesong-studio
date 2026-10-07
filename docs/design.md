# Design notes

**English** | [简体中文](./design.zh.md)

Why Novel Studio is shaped the way it is: how a loose list of wishes was folded into a few mechanisms, and what each decision trades away. After reading it you should be able to tell where a new requirement belongs without reading the code first.

## 1. From thirteen wishes to five questions

The starting point was a list: separate the orchestrator from the prose writer; whole-book / outline / local / world / character revision modes; one-click outline and cast from an existing manuscript; ensemble casts with character lifecycles; a world and a persona system; retrieval and long context; style; a UI to manage characters and plot, skim, search and mark what to change; a reading mode and chapters; illustrations; audiobooks; motion comics; a way to step into a scene and role-play it, perhaps as a live visual novel.

Built one by one, these become thirteen features that do not know each other. Grouped by the question each one answers, there are five:

| Question | Wishes | In the design |
|---|---|---|
| **Who writes?** | orchestrator vs writer | five roles: showrunner, writer, architect, analyst, director |
| **What is remembered while writing?** | world, persona, ensemble lifecycle, retrieval / long context, style | one canon + layered memory + a context packer |
| **How is it changed?** | the five revision modes, one-click import | one proposal mechanism at five granularities; import is digest run backwards |
| **How is it seen and handled?** | management UI, reader, chapters, marking | the Studio: a global page and a tab beside the conversation |
| **What can it become?** | illustrations, audiobook, motion comic, role-play / visual novel | the Stage: pipelines that share the audio script as their hub |

The conclusion: these are **not several creative tools but several working modes over one canon**. A mode changes what the showrunner attends to and may touch; the data is always the same data.

## 2. Who writes

**The showrunner is the session's agent.** There is no separate orchestration service: the Harness agent already plans, calls tools, compacts context, tracks todos and asks questions. The plugin ships a preset that gives it the showrunner's instructions, the `novel_*` tools and a project digest that travels with the conversation.

**The writer is a model role, not an agent.** Prose needs no tool loop; it needs a context prepared for this one call and a stable system prompt. So the writer is one model call inside a pipeline: brief in, context packed, model called, output cleaned, text saved, memory digested.

The other three roles exist because their demands conflict: the **architect** must reason and diverge (outlines, bible development), the **analyst** must be fast, literal and structured (digest, review, scripts), the **director** must be quick (you wait for it on every move of an interlude). Each role takes its own model; unset roles fall back (architect → writer; director → writer or analyst) and finally to the conversation model. "One model for everything" and "the best model for each step" are the two ends of the same setting.

The showrunner is told not to *write* manuscript prose itself: prose that bypasses the writer's pipeline bypasses the bible, the characters' current states, the style. But a conversation is full of changes that are not writing — the author dictates a sentence, pastes a paragraph of their own, wants a name put right — and routing those through a model that rewrites is slow, costs money and is not exact. So the showrunner has hands of its own for exactly that (`novel_edit`: replace, insert, append, delete, set), and uses them when the words are the author's, when the change is mechanical, or when the author asks it, in so many words, to write something itself.

### One road for every change

The first version drew the line between the showrunner and the book by prohibition: use the tools, do not touch the files. Used for real, that left the showrunner with too little it could do directly — and nothing stopped it from reaching for a raw file tool when its own tools did not fit, changing a chapter with no version kept and with memory still describing the old text. The author's words for it: the main agent "偷偷暗改", out of step with memory and the bible.

The answer is not more prohibition but one road, wide enough for everything:

- **Every kind of change has a tool**, and each tool does the bookkeeping: the text as it was becomes a version, the chapter's memory is digested again, search is re-indexed, and the result tells the showrunner where the change leads — the cards of the characters it names, the chapters written after it. What memory records wrongly can be corrected directly (`novel_memory`) rather than by hoping a second digest reads better.
- **The road around is closed, gently.** A raw `write` or `edit` (or a shell redirect) aimed at a book's own files is refused with the name of the tool that does the same thing properly. It is the author's setting, not the showrunner's, and can be loosened to "ask me" or "let it through".
- **What gets around anyway is seen.** The Studio tells its own writes from anyone else's by the state of the file, not by timing; a chapter changed by an editor, a script or a tool that was let through goes on the record and is digested again, and the showrunner's context says that it happened.
- **Nothing changes the book unseen.** The overview carries the book's record — what the showrunner did with its tools, what was done from another device, what changed from outside — with one-press undo for manuscript edits.

This is what "agent-native" comes to here: the conversation can do everything the screens can, and what it does is as visible and as reversible as what a hand does on a screen.

## 3. What is remembered

**A book is a directory.** Markdown for what a human writes, JSON for structure and machine memory, so the author can open their book in any editor, version it with git, and the agent's file tools can read it when needed. All writes go through one locked project object that also watches the directory, so outside edits show up live.

**Personas.** Beside the biography, a character card has a structured persona: traits with intensity, values in priority order, speech habits, lines never crossed, behaviour under pressure. Its purpose is concrete: voices blur in an ensemble when cards hold only adjectives; the writer needs executable constraints. The same card carries the character's visual anchor, design sheet and voice. Consistency of looks and voice does not rely on model memory — every call restates the same anchor and sends the same reference picture or clip (see *One look per book* below).

**Lifecycle.** A character is planned, active, offstage, retired or dead, and the status decides what the writer sees: characters in the scene get the full card, their state after their last chapter and a line of theirs from the text; other active and offstage characters get one line; the dead appear only on a list of people who must not appear alive; planned and retired ones are absent unless the outline casts them. Statuses are not maintained by hand: digest detects entrances, exits, deaths and returns, and proposes the change. Presence is computed from digests, so "who has been away for ten chapters" is a fact, not a recollection.

**Layered memory.** After each chapter the analyst extracts a one-line brief and a summary; hard facts; each character's state, place, mood, what they learned and a representative line; entities new to the bible; threads planted, advanced and paid off; the reader's open questions. Every ten chapters roll into an arc summary. Far-away story is coarse, recent story is fine, the last pages are verbatim. Memory carries a hash of the text it came from, so edited prose shows as undigested.

**Context packing — long context and retrieval are not a choice.** Every call gets a pack in a fixed order — book, core world, cast overview, characters in play, the story so far, open threads, relevant lore, retrieved passages, the outline ahead, the preceding text, the chapter so far, this chapter's plan — stable parts first so provider prefix caches hit. "The story so far" is the whole manuscript while it fits the budget — 500,000 tokens by default, since current models read about a million and nothing retrieves as reliably as having read it — and arc summaries + chapter summaries + retrieved passages once it does not. The budget is held to 70 % of what the model can read; the window comes from the role's own figure, the Harness, the endpoint or a table of common model families, and a model nobody can place is taken to read 200,000. Retrieval is hybrid: BM25 over CJK bigrams and Latin words, optional embeddings, fused by reciprocal rank.

**Style** is its own object: point of view, tense, tone, diction, rhythm, imagery, dialogue, rules, a "never" list, sample passages. The "never" list does the most work. Styles can be learned from a sample, tried on a test scene, and switched per book.

## 4. How it is changed

| The author's mode | What happens |
|---|---|
| derive the outline | the architect reads memory and threads and proposes chapters, beats or what-if branches; you review before anything enters the outline |
| local revision | select a passage → the writer rewrites only that, with its surroundings as context → a proposal |
| chapter revision | the writer rewrites one chapter to an instruction → a proposal |
| whole-book revision | the architect triages which chapters are affected, the writer changes only those, one proposal per chapter, grouped as a batch |
| world / character revision | change the bible first, then start a whole-book revision that carries the change through |

Shared rules: changes are **proposals** with a diff (revisions started in the Studio always; the showrunner's apply directly unless you ask to review them); the previous text is **snapshotted** before anything applies; a passage proposal goes **stale** when its target text has since changed — better that than pasting a rewrite in the wrong place; mutating tools **ask first** in read-only sessions.

**Import** is digest run backwards: split chapters → digest each → merge character moments into cards and entities into world entries → rebuild the outline and threads from the summaries → learn the style. It reuses the everyday memory pipeline, so an imported book is indistinguishable from one written here.

## 5. How it is seen and handled

One component tree, two doors: a **page** in the left sidebar (the bookshelf, no session needed) and a **tab** in a session's right sidebar. The tab is where the integration lives: when the showrunner calls the writer, the chapter streams into the editor beside the conversation; a selection can be rewritten directly or handed to the conversation with its chapter reference; each `novel_*` call in the transcript reads as "which model was asked to do what" and opens the Studio at that place.

Principles that run through the eight views (overview, bible, outline, write, read, cast, review, stage):

- tell the author the next step — the overview is a to-do list, not a dashboard;
- selection is the entry point to change — not "enter a mode, then find the place";
- model output is a suggestion by default — bible suggestions, revision proposals, derived plans all wait for a yes;
- long work is visible and stoppable — and stopping a draft keeps what was written when that overwrites nothing;
- narrow rooms are first-class — layouts follow the container's width, because the tab is often 450 px wide.

### Conversation first; screens for seeing and fine-tuning

This is an agent-native application, so the most direct way to use it is not to click through screens but to talk to the showrunner in a session. Three rules follow:

- **Whatever a screen can do, the conversation can do.** Every operation behind a screen has a tool, including the settings (`novel_settings`: read and change the model roles, run a one-click setup, edit the book's own information) and the small hand edits (`novel_manage`: restore a version, change a line of the audio script or a panel of the storyboard, settle a review issue…). A screen is not the only door to a feature; it is where a person **sees, checks and fine-tunes**.
- **The showrunner can show you a screen.** `novel_show` opens a screen, a chapter or a tab of the stage in the author's window — "show me the outline" opens it rather than describing where to click. The Studio appears beside the conversation the first time the showrunner goes to work; after that, keeping it open is the author's call.
- **Full screen is the host's.** The right sidebar already has a full-screen mode; the Studio only puts the same switch in its own header, closer to where the author is looking. No overlay of its own, hence no second copy of the state.

The one thing that does not go through the conversation is a key: the showrunner neither takes nor repeats one; it opens the settings and lets the author paste it.

### One conversation, one book in play

A workspace holds several books; a conversation and the Studio beside it must not each have their own idea of which one is meant. So there is one fact — **the book in play of a session** — and both sides read and write it.

- *Changing book in the Studio moves the conversation.* The alternative, a panel that can look at one book while the showrunner works on another, makes every "write the next chapter" ambiguous. Looking is switching; the Studio says so when it happens.
- *The showrunner must be told, durably.* The Harness turns a changed runtime context into a message in the conversation's own history, so the switch is on record where the earlier turns are: which book is in play now, which one the turns before were about, and that leftovers of the earlier book are to be finished by naming it, not carried across. It survives compaction because it is restated with every digest.
- *A call acts on the book its model was last told about* — not on whatever is in play at the instant it runs. An author who opens another book while the showrunner is mid-step has not redirected the calls it already decided on; the next step tells it, and it decides anew.
- *Several books in one conversation remain possible* — by naming, not by guessing. Every tool takes an optional `book`; the row in the transcript shows it; once a conversation has been on more than one book, every result says which book it is about. Reaching outside the conversation's workspace to change a book asks first.

### Nothing fails quietly

Most buttons start a job and return. A job nobody waits on that fails must still reach the author, least of all silently when the cause is that something was never set up. Two rules: the ending of every job this Studio saw start is reported; and a failure that means "not set up" — no speech model, no key, a subscription not signed in — is not an error message but a prompt with the way forward (one-click setup, or the settings opened at the right section). Long jobs say what they are doing: voicing a chapter shows the lines done, the line in the booth, time taken and time left.

The same goes for the half-second scale. A button that starts work shows itself working, in words, until the work ends; and one bar at the foot of the Studio lists everything in progress for the book — requests the Host has not answered yet, and running jobs whoever started them — with what each is doing, for how long, and a way to stop it. A click that seems to do nothing is a bug, whatever the code behind it was doing.

And for degraded results. A step that could not do its job properly and fell back on something lesser — a passage of an audio script cut by rule because the model's reply was cut off — writes that into what it produced, with the reason, and the screen shows it. The Studio also sets no cap of its own on how long a model's reply may run: a model that reasons spends its reasoning out of the same allowance, and a cap sized for the answer silently truncates it. That one mistake had produced scripts without speakers and storyboards of two panels, both looking like finished work.

### Connecting models: one click, or slot by slot

Setup serves two kinds of people. **Those who would rather not study it**: the first time the Studio opens with nothing configured, it opens on a guide — pick a service, paste one key, click once, and writing, images, speech and retrieval are set as recommended; the key is checked against the service first, and a refused key changes nothing. **Those who want to decide**: every slot (four roles, images, speech, retrieval) names its own service, endpoint, key, model and reasoning level; a text role may use a model configured in the Harness or point straight at any OpenAI-compatible endpoint.

Keys are kept **per endpoint host**, one record each, in the Harness credential store. Several capabilities of one service therefore need the key once — and a key only ever travels to the host it was entered for: moving a slot's address elsewhere does not carry the key along.

A ChatGPT subscription is the odd one out: it can draw, but it has no API key. The Studio adds no sign-in of its own and rides on one that exists — the image service the Codex Connect plugin exposes to companion plugins, or a Codex CLI already signed in on the machine. A subscription has no embedding or speech endpoint, and the Studio says so instead of pretending.

## 6. What it can become

Four things share one model, with the **audio script** as the hub:

```
manuscript ──analyst──▶ audio script (per line: narration/dialogue/thought, speaker, delivery;
                │                      per scene: ambience)
                ├── speech ──▶ audio drama   (a clip per line, one voice per character)
                └── storyboard ──▶ motion comic (a panel per few lines + a camera move)
```

- **Audio drama.** A speaker's voice is resolved in a fixed order: the voice on the card → a voice designed for them → a voice cast by gender and age. What is cast is written into the book's voice sheet and read from it ever after, so casting does not depend on who happens to speak first in a chapter, and speakers without a card get a lasting voice too. Clips are cached by a hash of provider, voice, direction and text, so editing three lines re-renders three lines. Speech providers implement one small interface.
- **Listening without ears.** A generative speech model does not always do what it was asked: a line comes back in another voice, cut short, or twice as loud as its neighbour — and it is at its least steady on lines of a few syllables. The pipeline therefore measures every take (duration against the words, level, median pitch against the voice's reference clip or its own long lines), takes a failing line again, keeps the best take, marks what still stands out, and brings every kept line to one level. The script helps from its side: narration is kept whole rather than chopped into fragments, and delivery notes are not reinvented on every line. None of this needs another model, and none of it claims more than it measures: a syllable says more about its tone than about its speaker, so very short lines are not judged on pitch.
- **Ambience** uses no model: the browser synthesizes it with Web Audio — filtered noise as the bed, slow modulation for breath, scheduled one-shots (thunder, crackle, drips, crickets). The script only says "this scene is a rainy night".
- **Motion comic.** The script is cut into beats — a short line whole, a long one sentence by sentence — and the storyboard director arranges beats into panels, so a panel may change in the middle of half a minute of narration. How many panels is the author's call (a density that names how long a picture stays, or `auto`, and a ceiling that always holds), because every panel is a picture to pay for. The chapter is boarded a window at a time; a director that stops early is asked for the rest instead of having its last panel stretched over everything left. Prompts include each character's visual anchor and the book's art direction, and each panel is drawn against the design sheets of the people in it; playback follows the lines with slow camera moves.

### One page to read and to listen

The audio drama used to be a tab on the stage, away from the reader. But listening is reading by ear: it is the same chapter, and what a listener wants on screen is the text, not a table of takes. So the reader has two modes. In *Listen* the page is still the prose; each script line is located in it (lines ignore paragraph breaks and dialogue has lost its quotation marks, so the match leaves white space out and falls back on how a line begins and ends), the sentence being spoken is lit, and any sentence starts playback. The author's tools — make, check and repair, export, the script line by line — sit above the same page instead of on another screen.

The same page is what a phone gets. A reader served to other devices cannot be the Harness (which stays on its machine, behind its own authentication), so the plugin runs a small server of its own for it: off until switched on for a book, read-only by construction (there is no route that writes or reaches a model, a key or an unshared book), and addressed by a random token that can be replaced. It is assembled from the very components the Studio's reader uses, so the two cannot drift apart.

### One look per book, and none of it hidden

Two things go wrong when a book is illustrated one prompt at a time. Words mean something else to an image model — a story's "church" becomes a cathedral, "white armour" a crusader — and a model that has never seen a character draws a new person each time. And the fixes tend to be hidden: a style phrase appended behind the author's back decides the look of a whole book without ever being shown.

So the look of a book is made of parts the author can read, and every picture records which parts it was made of:

- an **art direction** per book. A book without one starts from the Studio-wide direction or the built-in one — and the first picture writes that text into the book, where it is shown with its origin and can be changed. A default that shapes everything is a default that must be on record;
- **avoid lists** — per Studio, book, character and call — for what the setting does not have. They go to the image model as the negative prompt and to the model that writes scene descriptions, which is also told to replace loaded proper nouns with what the thing actually looks like;
- a **visual anchor** per character: the prose of the card distilled, once, into phrases an image model draws the same way every time, and restated as is in every picture;
- **design sheets**: the same person from the front, the side and the back, sent with every later picture of them as a reference image. Outfits are *looks* with sheets derived from the main one — the same face in other clothes — and places have reference art of their own.

The order matters and the Studio says so: direction and avoid list, then anchors and sheets, then pictures.

### Interludes, and why this is not a role-play front end

In a role-play tool the chat is the product and the story a by-product. Here it is the reverse: the story is the product and playing is a way to probe it — rehearse a confrontation before writing it, or try the branch where she never left.

So an interlude is a fork off the canon. It is anchored after a chapter, and the director knows the canon only up to there. You play one character or direct from outside ("someone knocks"). Each turn the director returns narration, lines with actions, optional choices, scene changes (place, time, mood, ambience) and the variables it tracks. The Studio presents it as a visual novel — background, portrait, dialogue box, choices, voice, ambience — with pictures and speech generated on demand. When it ends it is discarded, kept as a side story, or **novelized**: the writer turns the transcript into a chapter in the book's style. Only the last changes the canon, and that chapter is digested like any other.

### What it costs

Staging is where the money goes, and a writer's model at a million tokens of context is not free either. The Studio keeps a ledger of every model call it makes — tokens per role, pictures, seconds of speech — and adds it up by model, role, book and day. It counts and does not guess prices: money appears for the models the author has priced, in the currency they entered, and an unpriced model is reported as unpriced. The showrunner's own turns belong to the Harness's count and are named as the one thing the ledger leaves out.

## 7. Fitting into the Harness

- **One npm package, three entry points**: Host (project, pipelines, jobs, API), agent (tools, prompt, command — mounted inside the preset), browser (the Studio). It ships its own configuration patch.
- **Official seams only.** Model calls go through the Harness model runtime, so every route under *Settings → Models* works; keys go through the credential store; UI registers through slots; browser and Host talk over the Harness connection, so Web and Desktop behave the same.
- **Two prompt layers.** A fixed description of the division of labour sits in the system prompt (cache-friendly); the project digest and the working mode are dynamic context, re-sent only when they change.
- **Working mode is session state** — ideate, bible, outline, draft, revise, review, stage, play — switched in the Studio or by the showrunner.

### Sealed books

A book is plain files so that anything can read it; a sealed book is one its author does not want read by anything — a backup, a sync service, whoever opens the folder. Encrypting "the manuscript" would not be enough: a portrait, a voiced line, a memory digest, the name of a character's file say as much. So sealing is done underneath everything else: every read and write of a book goes through one small interface, and a sealed book's implementation of it encrypts content and names alike. The rest of the code neither knows nor cares.

The book's key is random and exists unwrapped only in the memory of a running Harness. On disk it is wrapped once per way of opening the book — a password, a computer's own unlock, a device that showed the password once — in the one file that stays readable. Presence is asked of the operating system (Touch ID, Windows Hello, the computer's password) by a helper that answers yes or no and holds no secret; the secret it gates sits in the account's credential store. The showrunner is on the outside of all of this by design: it can lock a book, never unlock one, and a password is never typed into a conversation.

## 8. Deliberately not done

Collaborative editing (one author per book); bundled models or keys; video generation (the motion comic is a moving storyboard); a rich-text editor (chapters must stay plain text you can open anywhere); encryption in transit for the reader on other devices (it is plain HTTP inside the local network, and says so — a certificate a phone trusts is not something a plugin can conjure).
