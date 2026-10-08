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
  prompt: lean woman in her late twenties, black hair coiled flat at the nape, grey cheongsam   # the visual anchor
  negative: loose hair, heavy makeup       # never drawn on them
  sheet: assets/images/sheet-….png         # design sheet: front, side, back
  portrait: assets/images/portrait-….png
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

`bible/relations.json` holds the ties of the book's world — what is in what, who belongs where, lives where, holds what — each `{id, kind, from, to, since?, until?, note?}` with `kind` one of `within`, `seat`, `member`, `resides`, `holds`, the ends `{type: "world" | "character", id}`, and `since` / `until` chapter ids.

`visual.prompt` is written for an image model, not for a reader: concrete phrases for what can be seen, restated as is in every picture of the character. Looks are matched by name: one written by hand needs only `name` and `prompt`, and gets its `id` when the card is next read; a look that is saved again keeps the sheet drawn for it.

**Style profile** (`bible/styles/<id>.md`): front matter `id`, `name`, `pov` (`first`, `third-limited`, `third-omniscient`, `second`, `multi`), `tense`, `tone`, `diction`, `rhythm`, `imagery`, `dialogue`, `pacing`, `rules`, `avoid`, `exemplars` (`[{ label, text }]`); the body holds further notes.

## Manuscript

`manuscript/<chapter id>.md` is plain prose: paragraphs separated by blank lines, no heading (the title lives in the outline). Three kinds of lines have meaning:

- `![caption](assets/images/….png)` on its own line — an embedded illustration;
- `***` or `---` on its own line — a scene break;
- `# …` headings — rendered as sub-headings by the reader and the exporters.

Word counts, audio scripts and exports ignore image lines.

## `.novel/` — machine memory

| Path | Content |
|---|---|
| `memory/<chapter>.json` | the digest of a chapter: brief, summary, story time, locations, facts, character moments, new entities, thread movements, open questions, and the hash of the text it was taken from |
| `memory/arcs.json` | arc summaries (one per ten chapters) |
| `versions/<chapter>/<timestamp>__<reason>.md` | snapshots taken before a draft, revision, restore or edit sitting (40 kept per chapter) |
| `proposals.json` | revision proposals and their status |
| `suggestions.json` | bible and thread suggestions left by digest |
| `reviews/<chapter>.json` | the latest editorial review |
| `audio/<chapter>.json` | the audio script: lines, cues, and which clip belongs to which line. A line that was spoken more than once says so (`takes`), and one whose kept take the listening check still faults says how (`check`: `silent`, `short`, `long`, `drift`). `degraded` is set when part of the chapter could not be directed by the model and was cut by rule (how many passages, and why) A script shaped for speaking has `shape: 2`: narration is in whole takes, and a narration line that only says who spoke carries `tag: true` (left unspoken unless `voiced: true`, or the book reads every word; `voiced: false` silences any line). Cues have a `kind` (`bed`, `effect`, `music`), a `caption` for the reader, a `prompt` for the sound model and, once generated, the clip (`audio`, `duration`, `renderKey`) |
| `activity.json` | the book's record: what changed it that the author did not do by hand on the panel — the showrunner's tool calls (`by: agent`), edits from another device (`device`), files changed outside the Studio (`outside`) — newest first, 300 kept. A manuscript edit carries the `version` that undoes it |
| `walkons.json` | names of people without a card that the author took off the walk-on list |
| `voices.json` | the book's voice sheet: for one speech provider and model, which voice each character was cast with (`characters`), which voice each speaker without a card got (`extras`), and the usual pitch of each voice (`prints`), which is what a take is compared with |
| `comic/<chapter>.json` | the storyboard: its panels, each with the lines it covers and — when it starts or ends inside a long line — `begin` and `end` as fractions of that line; the `density` and `maxPanels` it was cut with; and a `note` when the cut came out other than asked |
| `play/<id>.json` | interludes with every turn |
| `video/<chapter>.json` | the record of the chapter's video: its path under `assets/video/`, length, size, what post-production said about its cut, and what it was cut from |
| `illustrations.json` | the gallery index. Each picture keeps the `prompt` as the Studio put it together and the `parts` it was assembled from: `subject` — and, for the kinds that are put together from parts, its `pieces` in the order sent (`of`: `frame`, `look`, `outfit`, `expression`, `ask`, `composed`; a `look` says where its words are `from`: `anchor` or `card`), `clipped` where the subject was cut to fit —, `style` with `styleSource` (`book`, `studio` or `default`), the `avoid` list, the `references` (path and label of each reference image that went) and the `referenceNote` (what the prompt said they are for). Beside them: the `model` and the `provider` it was drawn with, the `size` asked for, and `sent` — what reached the image service word for word (`prompt`; `negative` where the service takes it as a field of its own; `size` in the service's terms). Pictures drawn before a field was kept simply lack it |
| `reading.json` | where the book was last read, on whichever device: `{chapter, at, by}` — what the next device picks up. Written without touching the book's revision |
| `graph.json` | where the author moved people to on the picture of who is what to whom: a person's id to `{x, y}` in the units of its layout; whoever is not in it stands where the layout puts them |
| `index/` | the search index and embedding cache — rebuildable, safe to delete |

`.novel/` is safe to commit except `index/`, which is better ignored. Deleting `.novel/memory` loses nothing that cannot be recomputed with a digest; deleting `versions/` loses your undo history.

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

Nothing in a sealed book can be edited by hand, and the watch that follows hand edits has nothing to follow. To work on the files directly, unseal the book first.

## Outside the book

A few things about your books are kept under the Harness home (`~/.dsh/novel-writer/` by default), not in the book:

| Path | Content |
|---|---|
| `settings.json` | the Studio settings, including the prices you entered for models and — once you have switched reading on other devices on — which books are shared, the port and the token of the address. Never a key |
| `removed/` | books taken off the shelf while the system trash could not be reached; each in a folder of its own, complete |
| `sessions.json` | for each conversation: its working mode, the book in play, the books it has been on, and who last moved it |
| `session-books.json` | which conversations have worked on which book — the showrunner's and the crew's — so that they can be sealed with it |
| `sealed-sessions/<book id>/` | the conversations of a sealed book while it is locked: per conversation `<id>.nvd` (its files, encrypted to the book's `drop` key: `NVD1` · an ephemeral public key · nonce · tag · ciphertext) and `<id>.json` (where it goes back to). Unlocking the book returns them to DSH's session store and empties this folder; deleting the folder while the book is locked deletes those conversations for good |
| `usage/<YYYY-MM>.jsonl` | the usage ledger: one line per model call (time, kind, model, role, book, tokens or pictures or seconds) |

