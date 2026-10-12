# Project format

A book is a directory with a `novel.json` in it. Everything a human writes is Markdown; structure and machine memory are JSON. You can edit any of it by hand while the Studio is open — the directory is watched and the Studio follows.

```
my-novel/
├── novel.json
├── outline.json
├── bible/
│   ├── characters/<id>.md
│   ├── world/<id>.md
│   └── styles/<id>.md
├── manuscript/
│   └── ch001.md, ch002.md, …
├── assets/
│   ├── images/          portraits, scene illustrations, panels, backgrounds
│   ├── audio/           one WAV per script line and per generated sound cue (per chapter), joined chapter tracks
│   └── video/           <chapter>.mp4 cut by post-production; work/<chapter>/ is its working directory (material lists, its scripts, intermediate files)
├── references/          the books this one goes by: index.json, and <id>.txt for a manuscript taken in as plain text
├── jottings/            the author's loose notes: index.json
├── derivations/         how the outline came to be: index.json — a record a derivation
├── export/              <title>.md, .txt, .html, .epub
└── .novel/              machine memory (see below)
```

Novel Studio finds books by looking for `novel.json` in a workspace directory and in its direct subdirectories, so one workspace can hold several.

## `novel.json`

| Field | Meaning |
|---|---|
| `schema` | format version, currently `1` |
| `id` | stable id of the book (used in media URLs) |
| `title`, `author`, `genre` | as you would expect |
| `language` | language of the manuscript (`zh`, `en`, `ja`, …). Prompts are written in Chinese for `zh*` and in English otherwise; the prose follows this field either way. |
| `logline`, `premise`, `themes` | the hook, the core of the story, its themes |
| `targetWords` | planned total length |
| `chapterBudget` | the recommended length of a chapter that has none of its own in the outline. Absent: the writer judges. (`chapterWords`, written by earlier versions, is still read — except the 3000 and 2500 every book was stamped with, which nobody chose) |
| `activeStyle` | id of the style profile the writer uses |
| `artStyle` | the art direction appended to the subject of every picture of this book. A book that has none gets the one in force (the Studio-wide direction, else the built-in one) written here by its first picture, so what shapes its pictures is on record |
| `artAvoid` | list of what no picture of this book may show (motifs, objects, lettering, styles the setting does not have); sent as the negative prompt with every picture |
| `cover` | project-relative path of the picture shown as the book's cover. Unset, the latest cover drawn stands in |
| `storyboard` | how finely this book's motion comics are cut: `{ "density": "auto" \| "sparse" \| "balanced" \| "dense", "maxPanels": 24 }`, both optional |
| `models` | this book's own model routes: a role named here uses that model of DSH's for this book, whatever the Studio-wide settings say (see [configuration](./configuration.md)) |
| `image` | this book's own way with pictures, over the Studio-wide settings: `{ "lead": "sheet" \| "portrait" \| "none", "sheet": "turn" \| "front", "portraits": "both" \| "scene" \| "plain", "looks": "pictured" \| "always", "portraitScene": bool (older: `false` reads as `portraits: "plain"`), "panelThings": bool }` — which of a person's pictures the others are drawn against, whether a design sheet turns the person round or shows the front alone, whether a portrait shows a signature scene, whether a motion comic's panels take the art of the things in them. A key left out follows the Studio |
| | With a `provider`, `image` is the book's whole image service — `provider`, `baseURL`, `model`, `sizes`, `local`, `workflow`… as in the Studio's settings — and nothing of the Studio's service is mixed in; `kept` remembers the services the book was moved away from. Keys are never here: the one saved for the address is used. |
| `tts` | this book's own speech setup, whole (`provider`, `baseURL`, `model`, `narratorVoice`, `defaultVoices`, `speechTags`…), where it has one; absent, the Studio's speaks for it. |
| `sound` | this book's own way with effects, music and beds (`provider`, `model`, `effects`, `music`, `beds`), where it has one. |
| `vision` | this book's own model for looking at pictures (`{ "provider", "model" }` of DSH's), where it has one: it says in words what a picture given to steer a plan or a chapter shows, for a working model that takes no pictures. |
| `embedding` | this book's own semantic retrieval, whole (`provider`, `baseURL`, `model`, `dimensions`), where it has one; absent, the Studio's is used. Its key is the one saved for the address. |
| `context` | this book's own context budgets — any of `strategy`, `budgetTokens`, `tailChars`, `sideTokens`, `playTokens`; what is not named follows the Studio's. |
| `parallel` | how many requests of a kind go out at once for this book: `{ "text"?, "speech"?, "image"?, "sound"? }`. A kind named here is counted for this book alone; one left out is counted with every other book's. |
| `crew` | this book's own way of working its crew: per role `{ "mode": "agent" \| "call", "tools": "own" \| "all", "steps": n }`; a role not named follows the Studio-wide settings |
| `notes` | author notes that always travel with the context |

## `outline.json`

```jsonc
{
  "schema": 1,
  "volumes": [
    {
      "id": "v1", "title": "第一封死信", "synopsis": "…", "goal": "where this volume must leave the story",
      "chapters": [
        {
          "id": "ch001",                 // also the manuscript file name
          "title": "代笔人的规矩",
          "status": "drafted",           // idea | outlined | drafted | revised | final
          "synopsis": "…", "purpose": "what the chapter does for the book",
          "pov": "沈蘅",                  // character id
          "location": "…", "time": "…",
          "characters": ["沈蘅", "周衡"], // character ids planned to appear
          "threads": ["th_ab12cd"],      // thread ids it touches
          "beats": [{ "id": "b_…", "summary": "…", "conflict": "…", "outcome": "…", "emotion": "…" }],
          "targetWords": 3000,           // recommended length; absent: the book's, else the writer judges
          "guides": [{ "path": "assets/guides/1a2b….png", "note": "the last image of the chapter" }], // pictures to write it by
          "referenceNotes": "…",         // what the planner took from the book's references for this chapter (or the author wrote): handed to the writer
          "referencesRead": true,        // somebody looked in the references for it — nobody looks again by itself, whatever came of it
          "fromText": ["location", "time"], // fields above that were blank and were filled from the chapter's digest (synopsis, location, time, characters, threads): what the chapter turned out to be, not what was meant — left out when the chapter is drafted anew, emptied when its memory is cleared; a field somebody sets is taken off the list
          "notes": "for the writer"
        }
      ]
    }
  ],
  "threads": [
    {
      "id": "th_ab12cd", "title": "妹妹失踪前寄来的无名信",
      "kind": "mystery",                 // foreshadow | mystery | subplot | promise | motif
      "status": "open",                  // open | paid | dropped
      "description": "…",
      "planted": ["ch001"], "advanced": ["ch002"], "paid": [],
      "auto": true                       // found by digest, not confirmed by a human yet
    }
  ],
  "lines": [                             // absent in a book that has only ever gone one way
    {
      "id": "ln_mzr2nh", "title": "她把信寄了出去",
      "premise": "what sets this line apart",
      "from": "ch003",                   // the chapter it leaves after; absent: another telling from page one
      "choice": "把信寄出去",              // what is decided at the end of `from` to go this way
      "chapters": [ /* chapters, exactly as in a volume */ ],
      "into": "ch012",                   // optional: the chapter of another line it arrives at
      "origin": "planner",               // author | planner | interlude | replaced (what an outline rewrite or a promotion set aside) | main
      "play": "play_…",                  // the interlude it grew out of, when origin is interlude
      "shelved": false,                  // put aside: kept and shown, not offered for the next chapter
      "createdAt": "2026-10-07T…"
    }
  ]
}
```

Reading order is the order of volumes and of chapters inside them: that is the **main line**. A plot line is read as the chapters before and including `from` (on whichever line `from` is), then its own, then — if it has `into` — that chapter and what follows it. Chapter ids are unique across the whole outline and never change when chapters move, also from a line to the main line and back; the manuscript, memory and media of a line's chapter are stored exactly like any other chapter's.

## Bible entries

Each entry is a Markdown file with YAML front matter. The id is the file name; ids are derived from names, so files stay readable.

**Character** (`bible/characters/<id>.md`):

```markdown
---
id: 沈蘅
name: 沈蘅
aliases: [沈小姐]
role: protagonist            # protagonist | deuteragonist | antagonist | supporting | minor | cameo
tagline: 替别人写爱，替自己留白。
gender: 女
age: "27"
appearance: …
personality: …
background: …
motivation: …
flaw: …
arc: …
voice: how they sound in dialogue
abilities: …
secrets: …
persona:
  traits: [{ name: 克制, level: 5 }, { name: 敏锐, level: 4 }]
  values: [体面, 真相]
  speech: [短句, 公文腔, 从不直说"我想你"]
  taboos: [替人把话说满]
  underPressure: 话变得更少，格式更严
relationships:
  - { target: 周衡, kind: 委托人, note: 第一个让笔失控的人 }
tags: []
visual:
  negative: loose hair, heavy makeup       # never drawn on them
  sheet: assets/images/sheet-….png         # the main design sheet (front, side, back): `mainSheet` where one is chosen, else the one it was — a sheet newly drawn where none is chosen (written by the Studio, not by hand)
  sheets: [assets/images/sheet-….png, …]   # every sheet kept of them that is not of a look, the newest first: the main one, the sheets of their stages, and ones kept without being in use; left out while the main one is the only one
  mainSheet: assets/images/sheet-….png     # the sheet the author chose as the main one — it stays whatever is drawn after; left out: see `sheet`
  fronts: [assets/images/sheet-….png]      # which of `sheets` show the front view alone (`sheetFront` says it of the main one)
  portrait: assets/images/portrait-….png   # the portrait that stands for them: `face` where one is chosen, else the first of `portraits` (written by the Studio, not by hand)
  portraits: [assets/images/portrait-….png, …]   # every portrait kept of them, in the author's order, the newest first until reordered; left out while there is one
  face: assets/images/portrait-….png       # the one the author chose to stand for them — it stays whatever is drawn after; left out: the first of `portraits`
  scenes:                 # the moments they are remembered by, the most theirs first; the director finds them, the author rewrites them
    - id: scene_k3x9
      title: 夜校
      chapter: ch003       # the chapter it is from
      text: 灯下，她俯身在旧账本上…   # the moment as a picture
      why: 她一生都在这本账里      # the director's sentence
      portrait: assets/images/portrait-….png   # the portrait drawn of it
  sceneAt: scene_k3x9     # which one a portrait shows by default; left out: the first (`scene`, one paragraph, is how releases before kept a single moment — read as a list of one)
lines: [ln_j4d6]           # the lines of the plot they belong to (`main` = the main line); left out: the lines whose chapters have them (every line while none does). World entries take the same key; left out there: every line
stages:                    # the stretches of their life in the book, in the order they come; the planner finds them, the author rewrites them
  - id: stage_a1
    title: 幼年
    age: 约七八岁（幼年）    # no `from`: as they are when the story begins
  - id: stage_b2
    title: 入园之后
    from: ch023              # the chapter it begins with
    age: 约十三岁（少年）
    what: 搬进大观园，自己住一处院子
    appearance: 身量长开，束发戴冠      # only where it differs from the stretch before
    persona: 痴性未改而心事渐深        # only where it differs from the card
    visual: { prompt: …, negative: …, sheet: assets/images/sheet-….png, portrait: assets/images/portrait-….png }   # `sheet`: one of the card's `visual.sheets`, used for this stretch (it is then not the main one)
  looks:                                   # further outfits, each with a sheet derived from the main one
    - id: 雨夜外出
      name: 雨夜外出
      prompt: dark grey wool coat over the cheongsam, black cloth umbrella
      when: 夜里出门、赴约
      sheet: assets/images/sheet-…-雨夜外出-….png
voiceProfile:
  voice: Serena              # provider voice id, or a designed voice id
  instructions: baseline delivery
  designPrompt: description a designed voice is created from
firstAppearance: ch001       # maintained by digest
lastAppearance: ch002
life: what they go through in the book, in a paragraph
lifeMarks:                   # what the author wrote down of their life themselves; it holds over the digests
  - { chapter: ch002, kind: exit, what: 说完旧事就走了 }   # kind: enter | return | exit | death — one mark a chapter
  - { kind: death, what: 故事开始前就病故了 }               # no chapter: before the story begins (death or exit only)
---

Free-form notes in Markdown.
```

**World entry** (`bible/world/<id>.md`): front matter `id`, `name`, `aliases`, `category` (`setting`, `location`, `faction`, `system`, `item`, `history`, `culture`, `rule`, `term`, `other`), `importance` (`1` core — always in context; `2` normal — when relevant; `3` detail — on demand), `summary`, `related`, `tags`, `visualPrompt` (what the place or thing actually looks like, for pictures), `visualImage` (its reference art, sent along with pictures set there), `weight` (`core`, `major`, `minor`, `once` — how much of the story it carries; absent: counted from the chapters that name it), `events` (its course: a list of `{chapter, kind, what, image?}` with `kind` one of `begin`, `change`, `decline`, `end`, and `image` the picture of it as it is from that turn on), `spots` (where the author pinned the marks of its scene: `"world:<id>"` or `"character:<id>"` to `{x, y}`, each 0–1 from the left and the top of its picture); the body is the entry.

`bible/glossary.json` holds how the book's names and its own words are written in other languages — what a translation goes by: `{schema: 1, to: {<language>: [{source, target, kind?, note?, of?, by?}]}}`. `kind` is `person`, `place`, `house`, `thing` or `term`; `note` says what the thing is, for the translator; `of` names the card or the entry it is a name of (`character:<id>`, `world:<id>` — that card takes `target` as another name once chapters are translated); `by: "author"` marks a rendering set by hand, which no pass over the names writes over. One rendering a word: of two terms with one `source`, the first stands.

`bible/relations.json` holds the ties of the book's world — what is in what, who belongs where, lives where, holds what — each `{id, kind, from, to, since?, until?, note?}` with `kind` one of `within`, `seat`, `member`, `resides`, `holds`, the ends `{type: "world" | "character", id}`, and `since` / `until` chapter ids.

A world entry's design pictures: `visualImage` is the main one — what pictures showing it are held against; `visualImages` lists every design picture kept of it, the newest first (left out while the main one is the only one), and `visualMain` is the one the author chose as the main one (left out: the newest, or what it was). The picture of a turn of its course is `events[].image`, and none of these.

How a character looks is their `appearance` — one paragraph, in the book's language; pictures are drawn by it. `visual.prompt` is read from cards of an earlier version only (phrases written for image models, a "visual anchor"): while a card has it, pictures go by it; nothing writes it any more, and it goes when it is folded into the appearance. A signature scene (`visual.scenes[]`) may carry `shot` — the moment framed for a picture: `{action, outfit?, look?, setting?, people?, place?, things?, why?, of}`, `of` saying which words of the moment it was framed from (it is made again when they change). Looks are matched by name: one written by hand needs only `name` and `prompt`, and gets its `id` when the card is next read; a look that is saved again keeps the sheet drawn for it.

**Style profile** (`bible/styles/<id>.md`): front matter `id`, `name`, `pov` (`first`, `third-limited`, `third-omniscient`, `second`, `multi`), `tense`, `register` (the kind of language it is written in — classical, the vernacular of the old chaptered novels, modern prose… — with what marks it), `tone`, `diction`, `rhythm`, `imagery`, `dialogue`, `pacing`, `rules`, `avoid`, `exemplars` (`[{ label, text }]`); the body holds further notes.

## Jottings

`jottings/index.json` holds the author's loose notes — a turn of the plot not thought through, a setting not settled, a line for some day. They are ideas and no part of the book's canon.

```jsonc
{
  "schema": 1,
  "search": false,                 // absent: the agents find them; false: none is found, whatever each says
  "items": [
    {
      "id": "jt_ab12cd",
      "title": "后院的井",          // optional: where none is given, the first line stands for it
      "text": "断肠斋的后院也许该有一口井……",
      "kind": "setting",           // plot | setting | other
      "hidden": true,              // absent: found; true: kept from the agents
      "createdAt": "…", "updatedAt": "…"
    }
  ],
  "removed": [ { /* a jotting taken away, with "removedAt" — the last 60, to be put back */ } ]
}
```

A jotting that is found is a source of the book's search (`jotting`), is listed by the crew's `book_read what=jottings` (the showrunner's `novel_read`, `novel_jot`), and — where it shares more than a stray word with what a chapter is about — goes along when that chapter is planned or written, named as an idea and not as canon. One that is `hidden`, and every one while `search` is `false`, is in no index and in no list an agent reads; the author sees them all on *Bible → Jottings*. A book taken as a reference does not open its jottings to the book that goes by it.

## Derivations

`derivations/index.json` holds one record for every derivation — what the author gave it to go by, what the planner handed in and said of it — and for what the author wrote down themself of a stretch of chapters.

```jsonc
{
  "schema": 1,
  "items": [
    {
      "id": "dv_ab12cd",
      "at": "…", "changed": "…",
      "kind": "chapters",          // chapters | beats | beat | whatif | foundation | note
      "by": "author",              // author (a page of the Studio) | showrunner (the conversation)
      "line": "ln_…",              // the line of the plot, where not the main one
      "direction": "这三章要阴暗：压着写。",   // the author's words: a direction, a sentence for a beat, a what-if's question, a book's idea, a note's text
      "mode": "append",            // chapters: append | replace | branch; a beat: add | change
      "after": { "id": "ch004", "title": "…", "index": 4 },   // the chapter the derived ones follow, as it was then
      "guides": [ { "path": "assets/…", "note": "…" } ],
      "turns": [                   // every hand-in: the first, and one more for each word the author had it adjusted by
        { "at": "…", "rationale": "…", "chapters": [ /* as handed in */ ] },
        { "at": "…", "feedback": "渡口之后加一章夜里过河", "rationale": "…", "chapters": [ /* … */ ], "resumed": true }
      ],                           // a turn holds `chapters`, `beats`, or `branches` + `recommendation`
      "state": "entered",          // chapters only: waiting (still looked at) | entered (in the outline) | discarded
      "chapters": ["ch005", "ch006", "ch007"],   // the chapters of the outline it is the thinking behind
      "note": "顾七的玩笑要带刺。",   // what the author added afterwards
      "carry": false,              // absent: it goes along; false: kept back
      "pictures": { /* how the guide pictures were read */ }, "referenced": { /* what was read in the references */ }
    }
  ],
  "removed": [ { /* a record taken away, with "removedAt" — the last 60, to be put back */ } ]
}
```

A record that stands (not `waiting`, not `discarded`, `carry` not `false`) is handed to whoever lays out the beats of one of its chapters and to whoever writes or revises it — with which chapters of the line it covers and where the one in hand stands among them — and the latest stretches of a line go to whoever plans what comes next on it. Records are read on *Outline → Derivation records*, by the crew's `book_read what=derivations` and the showrunner's `novel_read`. Chapters planned before records were kept have none: the author can write one down for them (`kind: "note"`).

## References

`references/index.json` lists the books this one goes by — what its crew may read in while it works — and `references/<id>.txt` holds a manuscript that was taken in for this book alone.

```jsonc
{
  "schema": 1,
  "guide": "世界观照《……》；文风只学《……》；人物不从任何一本里搬",   // what the author asks of them all, in their words: said to everybody who works with them
  "beforeWriting": false,          // absent: the planner reads the references for a chapter before it is written
  "beforeDeriving": false,         // absent: a derivation (chapters, beats, what-if) is held to read in them first
  "beforeReviewing": false,        // absent: a review is held to read in them first, and holds the chapter against them
  "items": [
    { "id": "ref_ab12cd", "kind": "book",            // a book of the shelf, consulted as it is organised there
      "title": "红楼梦", "root": "/path/to/that/book", "book": "novel_…",   // its folder, and its id (found again by id where the folder moved)
      "scope": ["style", "text"],                    // what of it is open: world, characters, style, plot, text — absent: all
      "note": "只学它章回体的口吻；不要用它的人物", // how the author wants it used, in their words
      "off": true,                                   // set aside: kept on the list, not consulted
      "addedAt": "2026-10-11T05:25:27.119Z" },
    { "id": "ref_ef34gh", "kind": "text",            // a manuscript, as plain text: read and searched, no cards
      "title": "代笔行旧例", "file": "references/ref_ef34gh.txt", "chars": 197, "parts": 1,
      "note": "写到行规时照它来，可以引原话" }
  ]
}
```

Nothing of a reference is copied into this book's bible, and nothing of one is put into a task whole: the crew reads in them with tools of its own, as far as each is open, and what it took for a chapter is on that chapter's plan (`referenceNotes`). A review made with the references looked at first says what was read (`referenced: { calls, read, cannot? }` in `reviews/<chapter>.json`). A reference that is a sealed book says only its id here, and is read while that book is unlocked.

## Manuscript

`manuscript/<chapter id>.md` is plain prose: paragraphs separated by blank lines, no heading (the title lives in the outline). Three kinds of lines have meaning:

- `![caption](assets/images/….png)` on its own line — an embedded illustration;
- `***` or `---` on its own line — a scene break;
- `# …` headings — rendered as sub-headings by the reader and the exporters.

Word counts, audio scripts and exports ignore image lines.

## `.novel/` — machine memory

| Path | Content |
|---|---|
| `memory/<chapter>.json` | the digest of a chapter: brief, summary, story time, locations, facts, character moments (each with `seen` — how the chapter shows them: age, face, dress — and `manner` — how they bear themselves — where the text says; with the card it is of, or the name where nobody is on file; `by` says who settled that card as the chapter was read — `story`: somebody of the chapter's own story, `over`: somebody of another story the digest was asked about and said had come over. A note without `by` is of an older digest: its id holds only within the stories that card is of), new entities (each, in a book of several lines, with the `scope` the digest gave it: `line` — of that story alone, `world` — of the world the lines share), the moments somebody would be remembered by (`scenes`: whose, what it is called, the moment as a picture, a weight of 1–3 — what a card's signature scenes are put together from), thread movements, open questions, and the hash of the text it was taken from |
| `memory/arcs.json` | arc summaries (one per ten chapters) |
| `versions/<chapter>/<timestamp>__<reason>.md` | snapshots of a chapter's text taken before a draft, revision, restore or edit sitting (400 kept per chapter). A draft written to be compared with others is one too (`…__trial-<model>[-<level>].md`), with `<same name>.json` beside it saying how it was made: `{ how: "trial", label, provider, model, effort?, round?, brief? }` — the model by its own name, and the comparison it is one of |
| `history/<kind>/<id>/<timestamp>__<why>.md` · `.json` | the versions of everything else that is written: `character`, `world` and `style` cards (the card's file as it was, `.md`), a chapter's `plan` and a `thread` of the outline, the `book`'s own info (`history/book/novel/`, the manifest as it was), a `volume` and a `line` of the plot (their own words and the order of their chapters), the table of `ties` (`history/ties/all/`), and a chapter's audio `script` and story`board` (what they say; the takes and the pictures are no part of a version) as `.json`. A version is the thing as it was *before* a change, named by when it was changed and by what: `edit` (the author, on the panel — one a sitting: none is kept while the latest is an `edit` less than five minutes old), `agent` (a tool call of the showrunner), `job-<title>` (a job of the Studio, by its title as far as a file name keeps it: `job-appearance`), `restore` (a version was put back), `removed` (the card was deleted — its last version is what brings it back). One is kept only when what the thing *says* changes: not for its pictures (`visual.portrait`, `visual.sheet`, `visualImage`, `cover`… — a picture stays until somebody deletes it, and a version put back leaves the pictures as they are now), not for what the Studio keeps by itself (`firstAppearance`, `lastAppearance`, a plan's `status`), not for `updatedAt`. 400 kept per thing |
| `translations.json` | which chapters' text is a translation made here: chapter id to `{from, to, at, version, title}` — the languages, when, the version of the chapter that holds the original, and the title the original had. Taken out again when the original is put back |
| `proposals.json` | revision proposals and their status: `pending`, `accepted` or `rejected`, with `settledAt` once settled. All that wait are kept; of what was settled, the latest 500 — what *Review → Archive* shows, and what a proposal turned down is put back from. One taken into a later proposal carries `supersededBy` (and is that proposal's to bring back) |
| `derived.json` | chapters the planner derived to be looked at first, neither added to the outline nor discarded yet (`at`, `job`, `chapters`, `rationale`, `volume`, `line` and `after` — the line of the plot and the chapter it was derived to follow, where one was named —, `direction`, `feedback` — what the author said of the plan, in turn — and how its pictures and references were read). The same plan whether the author derived it on the Outline page or the showrunner did (`novel_derive apply=false`). One at a time; gone when the plan is taken or let go. Safe to delete: the plan is then simply not waiting. |
| `plans-read.json` | for each chapter whose plan was set by its text: a hash of the text it was read from — so that a plan is not read from the same text twice, and one the author changed by hand since is not read over. Safe to delete: plans are then read again when their chapters are next changed or digested again. |
| `suggestions.json` | bible and thread suggestions left by digest |
| `settled.json` | what became of suggestions the planner settled without the author being asked: entered, folded into something there, left out — each with its reason, the latest first (600 at most) |
| `figures-hidden.json` | the portraits the author keeps out of the text, by path — ones that would stand there by themselves. By itself a portrait of one of somebody's moments stands where the chapter tells the moment, and one portrait of the person where they first come on (a period's, where the period begins) unless a moment of theirs is shown in that chapter; of several of one moment the first in the card's order is the one, and of the person the portrait that stands for them (`visual.portrait`). A picture that is both — a moment's, and the one that stands for the person — has two places: the moment's is listed by the path, the other by the path with `#face` after it. Pictures drawn to compare services are listed here until one is taken. |
| `figures-shown.json` | the portraits the author asked into the text beside those: ones the rule leaves out (a second picture of a moment, another portrait of the person), by path (or path and `#face`, as above). |
| `guide-notes.json` | what the model that looks at pictures wrote of the pictures given to steer by, by picture, model and what was said of it — so that none is looked at twice. Safe to delete. |
| `reviews/<chapter>.json` | the latest editorial review: a verdict and the issues, each with what the author said of it (`note`), the batch of changes it was handed over with (`mending`), and what a later look found (`checked`). An issue found by something the author had noticed themselves carries that sentence (`lead`) and stays through a new review while it is open; a chapter that was never reviewed and holds only such issues says so (`unread`). |
| `audio/<chapter>.json` | the audio script: lines, cues, and which clip belongs to which line. A line that was spoken more than once says so (`takes`), and one whose kept take the listening check still faults says how (`check`: `silent`, `short`, `long`, `drift`). `degraded` is set when part of the chapter could not be directed by the model and was cut by rule (how many passages, and why) A script shaped for speaking has `shape: 2`: narration is in whole takes, and a narration line that only says who spoke carries `tag: true` (left unspoken unless `voiced: true`, or the book reads every word; `voiced: false` silences any line). Cues have a `kind` (`bed`, `effect`, `music`), a `caption` for the reader, a `prompt` for the sound model and, once generated, the clip (`audio`, `duration`, `renderKey`) |
| `activity.json` | the book's record: what changed it that the author did not do by hand on the panel — the showrunner's tool calls (`by: agent`), edits from another device (`device`), files changed outside the Studio (`outside`) — newest first, 300 kept. A manuscript edit carries the `version` that undoes it |
| `walkons.json` | names of people without a card that the author took off the walk-on list |
| `voices.json` | the book's voice sheet: for one speech provider and model, which voice each character was cast with (`characters`), which voice each speaker without a card got (`extras`), and the usual pitch of each voice (`prints`), which is what a take is compared with |
| `comic/<chapter>.json` | the storyboard: its panels, each with the lines it covers and — when it starts or ends inside a long line — `begin` and `end` as fractions of that line, and what it shows that is not the usual — `looks` (character id → the name of the look worn in it) and `things` (entries of the bible it shows, by name); the `density` and `maxPanels` it was cut with; and a `note` when the cut came out other than asked |
| `play/<id>.json` | interludes with every turn |
| `video/<chapter>.json` | the record of the chapter's video: its path under `assets/video/`, length, size, what post-production said about its cut, and what it was cut from |
| `illustrations.json` | the gallery index. Each picture keeps the `prompt` as the Studio put it together and the `parts` it was assembled from: `subject` — and, for the kinds that are put together from parts, its `pieces` in the order sent (`of`: `frame`, `look`, `outfit`, `expression`, `ask`, `composed`; a `look` says where its words are `from`: `card` — the appearance — or, on a card of an earlier version, `anchor`; a `setting` and an `outfit` of a moment's frame say `shot`), `clipped` where the subject was cut to fit —, `style` with `styleSource` (`book`, `studio` or `default`), the `avoid` list, the `references` (path and label of each reference image that went) and the `referenceNote` (what the prompt said they are for). A reference that is a design sheet says so (`sheet`), and that only its front view went (`front`). Panels of motion comics are on record like any picture (kind `panel`, `target` the chapter; pieces `composed`, `look`, `place`, `thing`). A picture that is another one changed in one thing has the change as its `subject` (one piece, `of: change`), the picture it came from as its one reference, no `style` and no `avoid` — nothing else was sent — and a `base`: what it shows in words (`subject`, `style`, `styleSource`, `avoid`, `references`), unsent, which it is drawn from when its words are rewritten. Beside them: the `model` and the `provider` it was drawn with, the `size` asked for, and `sent` — what reached the image service word for word (`prompt`; `negative` where the service takes it as a field of its own; `size` in the service's terms). Pictures drawn before a field was kept simply lack it A picture brought in from the author's computer has `imported: true` and no prompt. `kind` and `target` say what a picture is for *now*: where the author has said that one drawn here is for something else (*Use as…*), `madeAs` — `{ kind, target? }` — keeps what it was drawn as, which the rest of its record is of. A picture made of another by hand has `edited` — `{ of, flip?, turn?, crop? }`: the path of the picture it was made of, whether that was mirrored left to right, by how many quarter turns clockwise (1–3) it was then turned, and the part kept of the turned picture in fractions of it (`x`, `y`, `width`, `height`); the rest of its record is that picture's. |
| | A portrait of one of somebody's moments also keeps `moment` — `{ title, scene, chapter }`: which moment, and the chapter it stands in. A picture drawn to compare services keeps `trial` — `{ id, label }`: the comparison it is of, and which service drew it. The picture of a passage keeps `passage` — `{ quote, why }`: the passage, and the director's account of whom and what it means. |
| | The pieces of a prompt are laid out a line each (`label` is what the line began with), and say more of themselves: `of` is also `use` (what the picture is for), `picture` (the picture in the author's words), `scene`, `place`, `thing`, `change`; a `look`, `place` or `thing` has the `name` it is said by, a person beside the subject is `secondary`, and a `look` keeps the `path` of the picture that shows the person. Where that picture went along the line only points to it — `byPicture: true`, `text` the pointer as sent ("见图1") — and `words` keeps, unsent, what it would have said (what the picture is drawn from again where no picture can go). |
| | `written` is the prompt as it was handed to the image service where that is not `prompt` (the director wrote it out, or fitted it); `verbatim: true` marks a picture drawn from its author's own whole prompt, to which the Studio added nothing. |
| `reading.json` | where the book was last read, on whichever device: `{chapter, at, by}` — what the next device picks up. Written without touching the book's revision |
| `graph.json` | where the author moved people to on the picture of who is what to whom: a person's id to `{x, y}` in the units of its layout; whoever is not in it stands where the layout puts them |
| `calls/` | the record of calls: every call the Studio made to a text model for the book. `index.json` lists them (`calls`: when, the job and its step, the chapter, the role, provider, model, reasoning level, temperature, output limit, characters sent and received, tokens, milliseconds, how it ended, bytes; `parts`: the shared parts and their sizes); `<id>.json` is one call with `prompt` and `reply`, and `system` / `stable` either in it or — where long — named by `systemPart` / `stablePart`; `parts/<hash>.json` holds such a stretch once for every call that sent it. Held to `callsMb` megabytes (settings), the oldest calls going first. Safe to delete whole |
| `index/` | the search index and embedding cache — rebuildable, safe to delete |

`.novel/` is safe to commit except `index/` and `calls/` (large, and of use only where the calls were made), which are better ignored. Deleting `.novel/memory` loses nothing that cannot be recomputed with a digest; deleting `versions/` or `history/` loses your undo history.

## A sealed book

A sealed book keeps the same folders, but every file in them is encrypted (AES-256-GCM) and so is its name:

```
my-novel/
├── novel.json                       the one readable file: id, shelf name, wrapped keys
├── <52+ letters and digits>.nvs     the manifest, the outline
├── manuscript/<…>.nvs
├── bible/characters/<…>.nvs
├── assets/audio/ch001/<…>.nvs
└── .novel/memory/<…>.nvs
```

- A sealed file is `NVS1` · a 12-byte nonce · a 16-byte tag · the ciphertext. Its content is bound to its place in the book (the path is authenticated with it), so a file moved to where another belongs does not open.
- A sealed name is the base32 of nonce · tag · ciphertext of the real name, with a nonce derived from the name and its folder, so the same name always seals to the same file name. Folder names are not sealed.
- `novel.json` of a sealed book is `{ schema, id, title, sealed: { v, slots, pending? } }`. `title` is the name the shelf shows while the book is locked. Each slot wraps the book's 32-byte key once: `password` (with its scrypt `salt` and cost `n`), `device` (unwrapped by a secret in one computer's credential store; `id` names the computer), `grant` (unwrapped by the secret in a device's cookie). `pending` is set while files are being sealed or unsealed, and has the work finished at the next unlock. `drop` is `{ publicKey, wrapped }`: an X25519 public key anything may encrypt *to* while the book is locked, and its private half wrapped with the book's key — it is how conversations about the book are put away when the key is not at hand (see *Outside the book*). A book sealed by an earlier version gets one the first time it is unlocked.
- A book on the private shelf carries `sealed.shelf: { id, own?, slot? }` in that file: the shelf it is on; `own: true` where it keeps a password of its own on top (then the shelf only hides it); otherwise `slot` wraps the book's key by the shelf's key, so that the open shelf opens the book. While the shelf is closed such a book is in no list, and its `title` is not shown.

Nothing in a sealed book can be edited by hand, and the watch that follows hand edits has nothing to follow. To work on the files directly, unseal the book first.

## Outside the book

A few things about your books are kept under the Harness home (`~/.dsh/novel-writer/` by default), not in the book:

| Path | Content |
|---|---|
| `settings.json` | the Studio settings, including the prices you entered for models and — once you have switched reading on other devices on — which books are shared, the port and the token of the address. Never a key |
| `removed/` | books taken off the shelf while the system trash could not be reached; each in a folder of its own, complete |
| `private-shelf.json` | the private shelf, once one was set up: `{ schema, id, slot }` — its id and its 32-byte key wrapped by the shelf's password (scrypt). No book is named in it: a book says of itself that it is on the shelf |
| | `ways` (optional) in the same file: other ways in than the password, as a sealed book's slots — the shelf's key wrapped by a secret this computer's credential store keeps (`{ kind: "device", id: "host:<name>", wrapped }`), handed over once the system confirmed its owner. |
| `sessions.json` | for each conversation: its working mode, the book in play, the books it has been on, and who last moved it |
| `session-books.json` | which conversations have worked on which book — the showrunner's and the crew's — so that they can be sealed with it |
| `sealed-sessions/<book id>/` | the conversations of a sealed book while it is locked: per conversation `<id>.nvd` (its files, encrypted to the book's `drop` key: `NVD1` · an ephemeral public key · nonce · tag · ciphertext) and `<id>.json` (where it goes back to). Unlocking the book returns them to DSH's session store and empties this folder; deleting the folder while the book is locked deletes those conversations for good |
| `pictures/<book id>.json` | for a book: the copies DSH's attachment store keeps of its pictures (one is kept of every picture shown to a model) — by the hash that names the object, with `shown` where a conversation holds it. Written only for the sake of sealing; nothing but hashes is in it. |
| `sealed-pictures/<book id>/` | those copies while a sealed book is locked: per picture `<sha256>.nvp` (the object, encrypted to the book's `drop` key like a conversation) and `<sha256>.json` (which object it is). The plain objects are removed from `attachments/v1/objects/` — the ones a conversation shows only once the book's conversations are under the seal — and DSH's cache of request-sized versions is cleared; unlocking puts the objects back and empties this folder. Deleting the folder while the book is locked leaves the book's conversations without those pictures. |
| `usage/<YYYY-MM>.jsonl` | the usage ledger: one line per model call (time, kind, model, role, book, tokens or pictures or seconds) |

