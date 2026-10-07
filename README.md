# Novel Studio for DeepSeek Harness

**English** | [简体中文](./README.zh.md)

`dsh-novel-writer` turns [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) into a studio for long-form fiction. It is not a role-play front end and not a "generate a chapter" button. It is a way to carry one long story — its people, its world, its promises to the reader — across hundreds of thousands of words without losing the thread, with you deciding and models doing the labour they are each good at.

<img src="./docs/images/icon.png" width="96" alt="Novel Studio's icon: DeepSeek-chan, the whale-girl maid, reading a novel" align="right" />

![Novel Studio beside the conversation: the showrunner reports, the writer's chapter is open in the editor](./docs/images/studio-session.jpg)

## The idea: a showrunner and a writer

Models that are excellent at planning, tool use and keeping a large project straight are often mediocre prose stylists, and the best prose models are often poor project managers. Novel Studio separates the two jobs:

| Role | Who | What it does |
|---|---|---|
| **Showrunner** (编排器 / 总编) | the agent you talk to — any model, selected per session | understands what you want, plans, decides what gets written next, briefs the other models, reports back |
| **Writer** (写手) | a model you pick for prose | drafts, continues and rewrites the manuscript, from a context pack built for it |
| **Architect** (架构) | a strong reasoner | derives outlines and beats, develops characters and world entries, explores what-if branches |
| **Analyst** (分析) | a fast, literal model | digests each chapter into memory, reviews like an editor, cuts audio scripts and storyboards |
| **Director** (导演) | a responsive model | plays the other characters in real time when you step into a scene |

The showrunner never writes manuscript prose itself: it calls `novel_write` with a short brief, and the writer receives the story bible, the cast with their current states, the story so far, relevant earlier passages, the open threads, the chapter's outline and the style profile. You can also skip the conversation and work in the Studio directly — every operation is available in both places.

## What you get

**One canon per book.** A project is a plain directory: Markdown for everything a human writes (character cards, world entries, style profiles, chapters), JSON for structure and machine memory. Edit it in the Studio, in your editor, or let the agent do it — all three see the same files, and it versions well with git.

**A story bible with people in it.** Character cards carry more than a biography: a structured persona (traits with intensity, values in priority order, speech habits, lines they would never cross, behaviour under pressure), relationships, a lifecycle status, a visual description and a voice. World entries are ranked — core canon always travels with the context, detail is fetched when relevant.

**Ensemble tracking.** Every character has a lifecycle (planned → active → offstage → retired / dead). Digest notices entrances, exits and deaths in the prose and proposes the status changes. The Cast view shows the lifecycle board, a presence grid (written, planned, planned-but-missing) and the relationship graph, and warns about characters who vanished, plans that cast the dead, and leads without an arc.

**Memory that scales with the book.** After a chapter is written, the analyst extracts a summary, hard facts, each character's state at the end, new entities and thread movements. Every ten chapters roll up into an arc summary. A context pack is then built per call: the whole manuscript while it fits — up to 500,000 tokens by default, and never more than 70 % of what the model can read — otherwise layered memory (arc summaries → chapter summaries → the last pages verbatim) plus passages retrieved by keyword and, optionally, by embedding.

**Style as a first-class object.** A style profile holds point of view, tense, tone, diction, rhythm, imagery, dialogue habits, hard rules, a "never" list and sample passages. Learn one from a text you love, try it on a test scene, switch per book.

**Five ways to change a book** — the modes the author thinks in:

| You want to… | In the Studio | Through the showrunner |
|---|---|---|
| derive what happens next | Outline → Derive (next chapters, beats, what-if branches) | `novel_derive` |
| fix a passage | select it in Write → polish / expand / tighten / your instruction | `novel_revise scope=passage` |
| rework a chapter | Write → revise the whole chapter | `novel_revise scope=chapter` |
| change something across the book | Review → Book-wide revision | `novel_revise scope=book` |
| change the world or a character, and carry it through | Review → "carry a world / character change through" | `novel_bible` + `novel_revise scope=book` |

Revisions arrive as **proposals** with a diff; you accept or reject. Every applied change snapshots the previous text, and any version can be compared and restored.

**One-click import.** Hand it an existing manuscript (`.txt` / `.md`, UTF-8 or GBK). An editor agent finds its real chapters — reading the text, working out how the headings are written, removing what a web page left in it — then the Studio digests them, merges the cast into character cards, collects the world entries, rebuilds the outline with threads, and learns the style.

**To read, and to listen — one page.** A reader with real typography, embedded illustrations, themes, and a selection toolbar — "edit here", "illustrate this", "discuss with the showrunner". A switch at the top turns the same page from **Read** to **Listen**: the prose stays, the sentence being spoken is lit in it, any sentence is a place to start from, and one chapter follows another. The author also gets the production desk of the audio version above the page.

**On a phone.** One button in the reader opens the book to phones and tablets on the same Wi-Fi: scan the code or type the address, and both modes are there. Off by default, switched on book by book, read-only, behind an address with a random token that can be replaced at any time; models, keys and books you have not shared are out of reach.

**A stage.**

- *Illustrations* — select a passage and get a picture embedded right after it. A book keeps one look, and none of it is hidden: one **art direction** per book (written into `novel.json`, shown where pictures are made), an **avoid list** for what the setting does not have, a **visual anchor** per character written for an image model rather than for a reader, and a **design sheet** — front, side, back — that travels with every later picture of that character as a reference image. Outfits get sheets of their own derived from the main one, places get reference art, and every picture records what its prompt was assembled from.
- *Audio drama* (the reader's Listen mode) — the analyst cuts a chapter into narration, dialogue and inner voice with delivery directions and ambience cues. A **voice sheet** keeps every speaker — with a character card or without — in one voice across the book, its chapters and its interludes. Every synthesized line is **listened to by measurement**: cut short, silent, or plainly not in its speaker's voice, and it is spoken again, the best take kept; all lines are brought to one level. Ambience beds (rain, tavern, night, tension… 18 presets) are synthesized live in the browser. Speech providers are pluggable: Qwen Omni realtime over WebSocket, DashScope Qwen-TTS over HTTP (with voice design), any OpenAI-compatible `/audio/speech`.
- *Motion comic* — a storyboard tied to the audio script, panels drawn with consistent characters, played with slow camera moves under the voices. How finely it is cut is yours to say: sparse, balanced, dense, or left to the director, with an optional ceiling on panels; a long stretch of narration changes picture midway.
- *Interludes* — step into a scene as one of the characters (or direct it from outside) while the director plays everyone else: backgrounds, portraits, voices, ambience, choices — a visual novel generated on the fly. An interlude never touches the canon unless you turn it into a chapter; otherwise keep it as a side story or discard it.

**Sound design.** Besides its lines an audio script says what each scene sounds like: the bed of the place, spot effects, music. These show as notes beside the text — when reading, too — and a sound model can make them audible under the voices; with Bailian audio generation as the speech model, nothing more needs setting up. The narrator no longer starts over at every paragraph: neighbouring narration is spoken in one take, and a "he said" between two spoken lines is left unspoken by default.

**Reading along with the model.** While a chapter is written, or any other job runs, the model's chain of thought (or the summary of it, where the model gives only that) can be read as it thinks.

**The showrunner has hands of its own, and one road.** A sentence you dictated, a name, a slip of fact: the showrunner changes it exactly with `novel_edit`, without going through the writer; what has to be *written* still goes to the writer. Every change keeps a version, digests memory again and goes on the book's record on the overview, with one-press undo for manuscript edits. A raw file tool aimed at the book's files is refused with the name of the right tool; files changed outside the Studio are noticed, recorded and digested again.

**The small parts of the ensemble.** People the page names who have no card — the clerk, "that lady" — are gathered under Cast → Walk-ons: a card for those worth tracking, an alias for those who are a known character under another name, nothing for the rest. The character list shows everyone's portrait by default, or names only.

**More than reading on a phone.** A book shared to a phone is read-only or changeable: changeable, its text can be edited and its interludes played there. The motion comic plays on the phone as well.

**Sealed books.** A book can be sealed whole: text, bible, memory, pictures and audio are ciphertext on disk, file names included. It opens with its password or with the computer's own unlock (Touch ID or the Mac's password); while it is locked not even the showrunner sees it. A phone shows the password once.

**Export** to Markdown, plain text, HTML or EPUB.

## A look around

| | |
|---|---|
| ![Overview: the book at a glance and what to do next](./docs/images/overview.jpg) | ![Write: chapter list, editor, review issues with one-click fixes](./docs/images/write.jpg) |
| *Overview — where the book stands and the next step* | *Write — editor with the review panel; select text to revise it* |
| ![Read: the manuscript as a reader meets it](./docs/images/read.jpg) | ![Motion comic: a drawn panel with subtitle, voice and ambience](./docs/images/comic.jpg) |
| *Read — typography first* | *Stage — motion comic playback* |
| ![Setup guide: pick a service, paste one key, everything is configured](./docs/images/setup.jpg) | ![Conversation and settings side by side: the showrunner has drawn a portrait, the Studio's settings are open on the right](./docs/images/settings.jpg) |
| *Connect the models — one click, or slot by slot* | *The conversation is the interface; the Studio stays beside it to look and adjust* |

![Interlude: a scene played as a visual novel, with a painted background, a portrait, choices and free input](./docs/images/interlude.jpg)

*An interlude: you play one character, the director plays the rest.*

## How it fits into the Harness

Writing a novel here is a conversation with the showrunner, with the book open beside it.

- An **agent preset**, *小说家 Novelist*: sessions that select it get the showrunner persona, the 24 `novel_*` tools, a live project digest in the prompt, the `/novel` command and five workflow skills. Other sessions are untouched.
- **The conversation is the interface.** Everything the Studio's screens can do can simply be said: "bring this epub in and continue it", "make the knock in chapter three a phone ringing", "draw a portrait of Shen Heng", "show me the outline", "set speech up with Bailian". The showrunner calls the right tool and opens the screen you need to look at.
- **Novel Studio as a tab** in the right sidebar of a session: the book beside the conversation, opening by itself when the showrunner goes to work. What it does appears live (a chapter streams into the editor as the writer produces it), and anything you select can be handed to the conversation. For room to read and write, go **full screen** (the rightmost button of the Studio's header, or the sidebar's own switch) and come back with the same button.
- The screens — bible, outline, write, read (and listen), cast, review, stage, settings — are where you **fine-tune and review by hand**: whatever a model did can be seen, changed and taken back there. Anything that takes a moment says so: the button that was pressed shows what it is doing, and a bar at the foot of the Studio lists everything in progress for the book, each with a way to stop it.
- **Novel Studio as a page** in the left sidebar: the bookshelf, the settings and any book, without a conversation.
- **Tool rows** in the transcript that say which model was asked to do what, with a door into the Studio at that place.
- **One book in play.** A conversation is on one book at a time and the Studio beside it shows the same one. Open another book in the Studio and the conversation follows — the showrunner is told which book it is on now and which one the earlier turns were about; ask the showrunner to switch and the Studio follows. To touch another book once, any tool takes a `book`.
- Text models can come from any provider the Harness already reaches — a key under *Settings → Models*, or a sign-in such as a ChatGPT subscription through Codex Connect — or every role can name an endpoint of its own; keys go into the Harness credential store.
- **Usage and cost.** Every model call the Studio makes is counted — tokens per role, pictures, minutes of speech — by model, book and day; enter what you pay per model and it becomes money.

It works in the Web UI (`dsh web`) and the Desktop app.

## Install

Requires DeepSeek Harness `0.2.0-rc.2` or later (`< 0.3`).

### Desktop app

The Desktop app owns its `desktop` profile, so plugins are installed from inside the app — `dsh plugin --profile desktop …` is refused by design.

1. Open **Plugins** in the left sidebar and choose **Add plugin**.
2. Enter one of:
   - the absolute path of a release tarball, e.g. `/Users/you/Downloads/dsh-novel-writer-0.1.0.tgz`;
   - the absolute path of a built checkout, e.g. `/Users/you/src/dsh-novel-writer` — it is linked rather than copied, so rebuilding the checkout updates the plugin;
   - `github:xuhao1/dsh-novel-writer` — the app asks before it runs the package's build script.
3. Install. *Novel Studio* appears in the left sidebar and *小说家 Novelist* in the preset menu of a new session; restart the app if they do not.

To upgrade, uninstall the plugin on the same page and add the new version. Your books are ordinary directories in your workspaces and are not touched.

### Web UI and other profiles

`dsh plugin` runs pnpm, which must be on your `PATH`.

```sh
dsh plugin --profile web add /absolute/path/to/dsh-novel-writer-0.1.0.tgz
dsh plugin --profile web remove dsh-novel-writer
```

A built checkout path or `github:xuhao1/dsh-novel-writer` works in place of the tarball; for the latter pnpm must be allowed to run the build script, see [Package and install a plugin](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish).

### Building it yourself

Needs Node.js 22+.

```sh
git clone https://github.com/xuhao1/dsh-novel-writer.git
cd dsh-novel-writer
npm install     # installs dependencies and builds lib/
npm pack        # writes dsh-novel-writer-<version>.tgz
```

## Quick start

1. Open **Novel Studio** in the left sidebar. The first time, it opens on **"Connect the models first"**: pick a service, paste one API key, click **Set up** — writing models, images, speech and semantic retrieval are configured as recommended. If the Harness already has a chat model you can skip this and come back any time.
2. **Start a new book**: a sentence or a paragraph about the story is enough. With "draft the foundation" ticked, the architect proposes a premise, the main cast, the world, volumes and the opening chapters — all editable.
   Or **bring in an existing novel**: drop a `.txt`, `.md`, `.epub` or `.docx`. The Studio splits it into chapters, digests each one, merges character cards and world entries, builds the outline and learns the style — after which you can continue it, revise it or turn it into an audio drama.
   Books live in workspaces; if none fits, choose **New workspace** under "Workspace".
3. Start a session with the **小说家 Novelist** preset and say what you want: "把第二章写出来，结尾停在敲门声", "the antagonist feels flat — give him a reason", "what if she refuses the deal?", "turn chapter one into an audio drama". The Studio appears beside the conversation as the showrunner starts working.
4. Read the chapter in the Studio. Select anything you would change. Settle the proposals and suggestions in *Review*. Go full screen when you want the room.

`/novel status`, `/novel mode <ideate|bible|outline|draft|revise|review|stage|play>`, `/novel digest` and `/novel export <format>` are available in the composer.

## Configuration

Everything is in *Novel Studio → Settings*, and the showrunner can do all of it for you in the conversation; see [docs/configuration.md](./docs/configuration.md) for each field, deployment defaults and per-book overrides.

**One-click setup** — paste one key and get all four capabilities configured as recommended:

| Service | Writing | Images | Speech | Retrieval |
|---|---|---|---|---|
| Aliyun Bailian | qwen3.8-max / qwen3.8-flash | Qwen-Image 3.0 | qwen-audio-3.1-tts-next | qwen3.7-text-embedding-flash |
| OpenRouter | Claude Sonnet 5.5, DeepSeek V4 | **GPT Image 2.5** | Gemini 3.8 Flash TTS | Qwen3 Embedding 8B |
| OpenAI | GPT-6.1 Sol, GPT-6 Luna | GPT Image 2 | gpt-4o-mini-tts | text-embedding-3-small |
| ChatGPT subscription (Codex) | — | the subscription's GPT Image, no key | — | — |

**Slot by slot** — every slot names its own service, endpoint, key, model and reasoning level:

- **Model roles** — writer, analyst, architect and director can each follow the conversation model, use a model from *Settings → Models*, or name an OpenAI-compatible endpoint directly (Bailian, OpenRouter, OpenAI, DeepSeek, a local server, a company gateway). The model can be picked from what the endpoint lists or typed. Reasoning models think before they write: for the writer and the analyst pick a low reasoning level — it is the difference between seconds and minutes per call.
- **Context** — `auto` (whole manuscript while it fits, retrieval after), `retrieval`, or `full`; token budget; how much preceding text is carried verbatim.
- **Images** (optional) — OpenRouter's `/images` (GPT Image, Gemini, Seedream, FLUX…), any OpenAI-compatible `/images/generations`, Aliyun Bailian (Qwen-Image, Wan, Z-Image), or a ChatGPT subscription.
- **Speech** (optional) — Bailian audio generation `qwen-audio-3.1-tts-next` (voices are described in words; one reference clip per character keeps them steady), Qwen Omni realtime, Bailian Qwen-TTS (voice design), OpenRouter's `/audio/speech`, or any OpenAI-compatible `/audio/speech`.
- **Semantic retrieval** (optional) — any OpenAI-compatible `/embeddings` endpoint, fused with keyword search.

**Keys** are typed into the settings and saved with everything else. They go to the Harness credential store (one record per endpoint host), never into the settings file and never back to the page; every slot on the same service shares one key, so it is entered once. If you prefer environment variables, `DASHSCOPE_API_KEY`, `OPENROUTER_API_KEY` and `OPENAI_API_KEY` are picked up by themselves, and any slot can name another variable.

**ChatGPT subscription** — with the [Codex Connect](https://github.com/franksong2702/dsh-codex-connect) plugin installed and authorized, or the Codex CLI on the same machine signed in with ChatGPT, illustrations use the subscription's GPT Image: no API key, and no sign-in of the Studio's own. The Openai-Codex text models Codex Connect provides can be assigned to the roles like any other Harness model. A subscription has no embedding and no speech endpoint; use a service above for those.

## What a book looks like on disk

```
my-novel/
├── novel.json                 title, premise, language, targets, active style
├── outline.json               volumes → chapters → beats, and plot threads
├── bible/
│   ├── characters/<name>.md   front matter (persona, lifecycle, looks, voice) + notes
│   ├── world/<name>.md        ranked world entries
│   └── styles/<name>.md       style profiles
├── manuscript/ch001.md …      the prose, one chapter per file
├── assets/                    images and audio
├── export/                    exported books
└── .novel/                    machine memory: per-chapter digests, versions, proposals,
                               reviews, audio scripts, storyboards, interludes, search index
```

Details: [docs/project-format.md](./docs/project-format.md).

## Design and internals

[docs/design.md](./docs/design.md) explains the reasoning behind the split of roles, the working modes, the memory layers, the context packer, the ensemble lifecycle and the stage pipelines ([中文](./docs/design.zh.md)).

The package is one npm module with three entry points: a Host half (project store, pipelines, jobs, the Studio's API), an agent half mounted inside the preset (tools, prompt, command), and a browser half (the Studio). See [CONTRIBUTING.md](./CONTRIBUTING.md) for the layout, the dev server and the tests.

## What is sent where

- Text goes to the models you chose for the roles: a role that follows the conversation model or uses a Harness model goes through the Harness LLM runtime (the same routes, credentials and retry policy as your conversations); a role with an endpoint of its own is called by the Studio directly.
- Image prompts, the text of lines to be spoken and (if enabled) text chunks to be embedded go to the media endpoints you configured. Nothing is sent to any endpoint you did not configure; there is no telemetry.
- Keys stay in the Harness credential store on your machine and are only ever sent to the endpoint host they were entered for.
- Books stay in your workspace. Settings live in `$DSH_HOME/novel-writer/`.

## License

[GNU Lesser General Public License v3.0 or later](./LICENSE) (the LGPL supplements the [GNU GPL v3](./COPYING)). You may use the plugin with any Harness setup and combine it with other plugins under their own terms; changes to the plugin itself stay under the LGPL.

**Icon.** DeepSeek-chan, the "maid whale-girl" (女仆鲸鱼娘), drawn for this project with GPT Image through Codex. Character reference: 溟月 by 上善无形, in the DeepSeek maid design by ZipZipPipe.

The novels you write with it are yours.

---

By Dr. Xu · Project home: <https://dsh-novel-studio.xuhao1.me>
