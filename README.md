# Novel Studio for DeepSeek Harness

**English** | [简体中文](./README.zh.md)

`dsh-novel-writer` turns [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) into a studio for long-form fiction. It is not a role-play front end and not a "generate a chapter" button. It is a way to carry one long story — its people, its world, its promises to the reader — across hundreds of thousands of words without losing the thread, with you deciding and models doing the labour they are each good at.

<img src="./docs/images/icon.png" width="96" alt="Novel Studio's icon: DeepSeek-chan, the whale-girl maid, reading a novel" align="right" />

![Novel Studio beside the conversation: the showrunner reports, the writer's chapter is open in the editor](./docs/images/studio-session.jpg)

> **New here?** The [tutorial](./docs/tutorial.md) walks it through with screenshots: install → connect the models → bring in a finished book → derive, beats, write, digest, review, cards, portraits → the gallery and the album.

## The idea: a crew, not a model

Models that are excellent at planning, tool use and keeping a large project straight are often mediocre prose stylists, and the best prose models are often poor project managers. Novel Studio hands the work to a small company:

| Role | What it is | What it does |
|---|---|---|
| **Showrunner** (总编) | the agent you talk to — any model, selected per session | understands what you want, plans, decides what gets written next, gives the crew its work, reports back |
| **Writer** (写手) | a model you pick for prose (one call, no tools) | drafts, continues and rewrites the manuscript, from a context pack built for it |
| **Continuity** (场记) | an agent of DSH | digests each chapter into memory, reviews like an editor, takes in manuscripts |
| **Planner** (策划) | an agent of DSH | derives outlines and beats, develops characters and world entries, explores what-if branches, researches (on the web too) |
| **Director** (导演) | an agent of DSH | directs audio scripts and storyboards; plays the other characters when you step into a scene |
| **Post-production** (后期) | an agent of DSH | cuts voice, sound and storyboard pictures into a video: writes its own script, runs it, checks the result |

The showrunner never writes manuscript prose itself: it calls `novel_write` with a short brief, and the writer receives the story bible, the cast with their current states, the story so far, relevant earlier passages, the open threads, the chapter's outline and the style profile.

**Continuity, the planner, the director and post-production are not four prompts but four real agents** — each with a persona, rules, skills, tools and permissions of its own, on the agent loop of DSH (DeepSeek Harness) itself. When the showrunner or you give one of them work, the run is a **subagent of the conversation**: open it from the list of subagents in the conversation's header and read what it looked up in the book, what it searched for, what it handed in and what it cost. Which tools they have is yours to say: by default each has its own (plus the few its work calls for — the planner can search the web, post-production has a shell), and any role can be opened to all of DSH's tools. You can also skip the conversation and work in the Studio directly — every operation exists in both places.

## What you get

**One canon per book.** A project is a plain directory: Markdown for everything a human writes (character cards, world entries, style profiles, chapters), JSON for structure and machine memory. Edit it in the Studio, in your editor, or let the agent do it — all three see the same files, and it versions well with git.

**A story bible with people in it.** Character cards carry more than a biography: a structured persona (traits with intensity, values in priority order, speech habits, lines they would never cross, behaviour under pressure), relationships, a lifecycle status, a visual description and a voice. World entries are ranked — core canon always travels with the context, detail is fetched when relevant.

**Ensemble tracking.** No card carries a label like *active* or *dead*: a book is not one straight road, and one word does not tell a life. Everyone has a **life on the page** — the chapter they come on in, the chapters they are in, where they leave or die — read off the chapter digests along one line of the plot, and another life along another (dead on this line, somebody is alive on the one that parted earlier). The **People** page holds everything about the book's people in one place — everyone's card, with their portrait large beside who they are, the table of all their lives (on the page, coming on, leaving, dying, planned, planned-but-missing) and the relationship graph — and notes characters who vanished, plans that cast the dead, and leads without an arc (notes that fold to a line, or out of sight).

**Memory that scales with the book.** After a chapter is written, the analyst extracts a summary, hard facts, each character's state at the end, new entities and thread movements. Every ten chapters roll up into an arc summary. A context pack is then built per call as **an outline of what came before plus a window of the text itself**: the whole chapters nearest to this one verbatim (half of the model's context window by default, whole chapters only), one line per chapter for everything older, and passages retrieved by keyword and, optionally, by embedding — which is the whole manuscript while it fits. Rewriting a chapter in the middle of the book, **the chapters already written after it are given too**, and the chapter must lead into them. The request is laid out for the provider's prefix cache: writing the next chapter, hundreds of thousands of tokens of earlier text gain one chapter at the end and the rest is read from the cache — how much is recorded with the usage.

**Style as a first-class object.** A style profile holds point of view, tense, tone, diction, rhythm, imagery, dialogue habits, hard rules, a "never" list and sample passages. Learn one from a text you love, try it on a test scene, switch per book.

**Five ways to change a book** — the modes the author thinks in:

| You want to… | In the Studio | Through the showrunner |
|---|---|---|
| derive what happens next | Outline → Derive (next chapters, beats, what-if branches); from after any chapter, appending, **replacing** what followed, or **opening a plot line** beside it | `novel_derive` |
| fix a passage | select it in Write → polish / expand / tighten / your instruction | `novel_revise scope=passage` |
| rework a chapter | Write → revise the whole chapter | `novel_revise scope=chapter` |
| change something across the book | Review → Book-wide revision | `novel_revise scope=book` |
| change the world or a character, and carry it through | Review → "carry a world / character change through" | `novel_bible` + `novel_revise scope=book` |

Revisions arrive as **proposals** with a diff; you accept or reject. Every applied change snapshots the previous text, and any version can be compared and restored.

**One-click import.** Hand it an existing manuscript (`.txt` / `.md`, UTF-8 or GBK). An editor agent finds its real chapters — reading the text, working out how the headings are written, removing what a web page left in it — then the Studio digests them, merges the cast into character cards, collects the world entries, works out how they stand to each other (what place is in what, who lives where and belongs to which house, what happens to the places over the story), rebuilds the outline with threads, learns the style, and settles the look of the book's pictures.

**To read, and to listen — one page.** A reader with real typography, embedded illustrations, themes, and a selection toolbar — "edit here", "illustrate this", "discuss with the showrunner". A switch at the top turns the same page from **Read** to **Listen**: the prose stays, the sentence being spoken is lit in it, any sentence is a place to start from, and one chapter follows another. The author also gets the production desk of the audio version above the page.

**The people and the world are for looking at, too.** Beside the text the viewer has two more halves. **People**: everybody laid out by the weight of their part, the leads large; somebody's page has their picture large (portrait, design sheet and further looks to change between), how they look and are, where they come from, what they go through — where they come on, what happens to them, where they leave — and the house they belong to, where they live, what they hold. **World**: step into a city, a house, a garden — what is in it, who is there — each place with its design art and what is written of it — and where a place has design art, the picture is a **scene**: its courtyards and whoever lives there are marked on it, each mark a way in (the author can drag the marks to where the things are in the picture); a slider shows all of it as the story stood at a chapter. *Edit* at the top right of any page leads to where that thing is made, and *View* there leads back. A phone on the network and a published site show the same pages — with what a reader should see (who and what the text has come to; what somebody wants, their secrets and the author's notes stay with the author).

**On a phone.** One button in the reader opens the book to phones and tablets on the same Wi-Fi: scan the code or type the address, and both modes are there. Off by default, switched on book by book, read-only, behind an address with a random token that can be replaced at any time; models, keys and books you have not shared are out of reach.

**A stage.**

- *Illustrations* — select a passage and get a picture embedded right after it. A book keeps one look, and none of it is hidden: one **art direction** per book (written into `novel.json`, shown where pictures are made), an **avoid list** for what the setting does not have, one **appearance** per character that the writer and every picture go by, and a **design sheet** — front, side, back — that travels with every later picture of that character as a reference image. Outfits get sheets of their own derived from the main one, places get reference art, and every picture records what its prompt was assembled from.
- *Audio drama* (the reader's Listen mode) — the director cuts a chapter into narration, dialogue and inner voice with delivery directions and ambience cues. A **voice sheet** keeps every speaker — with a character card or without — in one voice across the book, its chapters and its interludes. Every synthesized line is **listened to by measurement**: cut short, silent, or plainly not in its speaker's voice, and it is spoken again, the best take kept; all lines are brought to one level. Ambience beds (rain, tavern, night, tension… 18 presets) are synthesized live in the browser. Speech providers are pluggable: Qwen Omni realtime over WebSocket, DashScope Qwen-TTS over HTTP (with voice design), any OpenAI-compatible `/audio/speech`.
- *Motion comic* — a storyboard tied to the audio script, panels drawn with consistent characters, played with slow camera moves under the voices. How finely it is cut is yours to say: sparse, balanced, dense, or left to the director, with an optional ceiling on panels; a long stretch of narration changes picture midway.
- *Video* — a chapter as a video file, cut by the **post-production agent**: the voice, sound and storyboard pictures the chapter already has are only material, which the Studio lays out on one timeline and hands over; the agent writes its own script with a shell (ffmpeg), cuts, checks and hands an MP4 in — taken only once it passes the checks (a picture, a sound, the right length, no long black stretches). When the work is beyond it, it can call in outside help (Claude Code, Codex). Say what you want of the cut in your own words: pace, subtitles, a title card.
- *Interludes* — step into a scene as one of the characters (or direct it from outside) while the director plays everyone else: backgrounds, portraits, voices, ambience, choices — a visual novel generated on the fly. An interlude never touches the canon unless you turn it into a chapter; otherwise keep it as a side story or discard it.

**The plot graph — a story may go more than one way.** The volumes of the outline are the **main line**; beside it there can be other plot lines — another way things could go that the planner derived, a stretch played in an interlude, the plan that was there before the outline was rewritten. A line leaves after a chapter (with the choice made at the fork) and may join another line again, so the plot is a graph, and *Outline → Plot graph* draws it: the main line is starred, and any station or line can be handled — rename, join, shelve, remove, or **make it the main line** (the stretch it replaces becomes a line of its own; nothing written is lost). The next chapter can be written on any line; reading reaches a fork and is offered the ways on. What happens on a side line stays there: someone who dies on one is not dead in the book.

**One click, and many at once.** "The same thing for many chapters" is one job: **Stage → Produce** takes the chosen chapters from script through voice, sound, storyboard and pictures to the video; **Write → Write a run** writes chapter after chapter (beats derived where missing, each chapter digested before the next); **Gallery → Draw a batch** draws design sheets and place sheets first, then portraits, illustrations and the cover from them. Only what is missing is made, so running a stopped or partly failed batch again finishes it; a failed step holds back only what depends on it; every step of every chapter is a cell of one live table. How many requests are out at once is decided by four gates for the whole Studio (speech, pictures, sound, text — 8 by default, up to 256), which slow down, resend and recover by themselves when a service limits its rate, and say so.

**Length is a budget you may give — or not.** A chapter can carry a recommended length and a book a default; give neither and the writer judges from the plan and from how long the book's chapters run. The Studio does not make up a figure for you.

**Sound design.** Besides its lines an audio script says what each scene sounds like: the bed of the place, spot effects, music. These show as notes beside the text — when reading, too — and a sound model can make them audible under the voices; with Bailian audio generation as the speech model, nothing more needs setting up. The narrator no longer starts over at every paragraph: neighbouring narration is spoken in one take, and a "he said" between two spoken lines is left unspoken by default.

**Reading along with the model.** While a chapter is written, or any other job runs, the model's chain of thought (or the summary of it, where the model gives only that) can be read as it thinks.

**The showrunner has hands of its own, and one road.** A sentence you dictated, a name, a slip of fact: the showrunner changes it exactly with `novel_edit`, without going through the writer; what has to be *written* still goes to the writer. Every change keeps a version, digests memory again and goes on the book's record on the overview, with one-press undo for manuscript edits. A raw file tool aimed at the book's files is refused with the name of the right tool; files changed outside the Studio are noticed, recorded and digested again.

**The small parts of the ensemble.** People the page names who have no card — the clerk, "that lady" — are gathered under People → Walk-ons: a card for those worth tracking, an alias for those who are a known character under another name, nothing for the rest. The character list shows everyone's portrait by default, or names only.

**More than reading on a phone.** A book shared to a phone is read-only or changeable: changeable, its text can be edited and its interludes played there. The motion comic plays on the phone as well.

**Sealed books.** A book can be sealed whole: text, bible, memory, pictures and audio are ciphertext on disk, file names included. **A new book can be sealed as it is created** — what is drafted or imported is ciphertext from its first file on. It opens with its password or with the computer's own unlock (Touch ID or the Mac's password); while it is locked not even the showrunner sees it. A phone shows the password once. **The conversations about the book are sealed with it**: the conversation with the showrunner about this book and the runs of the agents that worked on it are taken out of DSH's session store and encrypted when the book is locked, and put back as they were — ready to go on — when it is unlocked.

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

- An **agent preset**, *小说家 Novelist*: sessions that select it get the showrunner persona, the 26 `novel_*` tools, a live project digest in the prompt, the `/novel` command and five workflow skills. Other sessions are untouched.
- **The crew are subagents of the conversation.** Every run of continuity, the planner, the director or post-production goes through DSH's own delegation seam (`ctx.subagents`) under the conversation that asked for it: it joins that conversation's tools, skills and permission mode, and is entered in the catalog of subagents in the conversation's header, every step on record. Work that has no tool of its own is handed to a role in words with `novel_crew` ("have the planner look into how the Shanghai post worked and propose two scenes for chapter four").
- **Outside help is DSH's own subagent.** With `@deepseek-ai/dsh-subagent-claude-code` or `@deepseek-ai/dsh-subagent-codex` installed, post-production can hand what it cannot do well to Claude Code or Codex — the preset already mounts DSH's `@deepseek-ai/dsh-tool-subagent` for both, and nothing happens while they are absent.
- **The conversation is the interface.** Everything the Studio's screens can do can simply be said: "bring this epub in and continue it", "make the knock in chapter three a phone ringing", "draw a portrait of Shen Heng", "show me the outline", "set speech up with Bailian". The showrunner calls the right tool and opens the screen you need to look at.
- **Novel Studio as a tab** in the right sidebar of a session: the book beside the conversation, opening by itself when the showrunner goes to work. What it does appears live (a chapter streams into the editor as the writer produces it), and anything you select can be handed to the conversation. For room to read and write, go **full screen** (the rightmost button of the Studio's header, or the sidebar's own switch) and come back with the same button.
- The screens — people, bible, outline, write, view (the text as prose, script and motion comic with one player under them; the people; the world), review, stage, settings — are where you **fine-tune and review by hand**: whatever a model did can be seen, changed and taken back there. Anything that takes a moment says so: the button that was pressed shows what it is doing, and a bar at the foot of the Studio lists everything in progress for the book, each with a way to stop it.
- **Novel Studio as a page** in the left sidebar: the bookshelf, the settings and any book, without a conversation.
- **Tool rows** in the transcript that say which model was asked to do what, with a door into the Studio at that place.
- **One book in play.** A conversation is on one book at a time and the Studio beside it shows the same one. Open another book in the Studio and the conversation follows — the showrunner is told which book it is on now and which one the earlier turns were about; ask the showrunner to switch and the Studio follows. To touch another book once, any tool takes a `book`.
- **Text models are DSH's models** — a key under *Settings → Models*, or a sign-in such as a ChatGPT subscription through Codex Connect; connect whichever vendor there, and choose among them per role in the Studio. The Studio configures only what is its own: the models that draw, speak and search, with keys in DSH's credential store.
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

For the same with screenshots, step by step, see the [tutorial](./docs/tutorial.md); what follows is the shortest version.

1. Open **Novel Studio** in the left sidebar. The first time, it opens on **"Connect the models first"**: pick a service, paste one API key, click **Set up** — writing models, images, speech and semantic retrieval are configured as recommended. If the Harness already has a chat model you can skip this and come back any time.
2. **Start a new book**: a sentence or a paragraph about the story is enough. With "draft the foundation" ticked, the architect proposes a premise, the main cast, the world, volumes and the opening chapters — all editable.
   Or **bring in an existing novel**: drop a `.txt`, `.md`, `.epub` or `.docx`. The Studio splits it into chapters, digests each one, merges character cards and world entries, builds the outline and learns the style — after which you can continue it, revise it or turn it into an audio drama.
   Books live in workspaces; if none fits, choose **New workspace** under "Workspace".
3. Start a session with the **小说家 Novelist** preset and say what you want: "把第二章写出来，结尾停在敲门声", "the antagonist feels flat — give him a reason", "what if she refuses the deal?", "turn chapter one into an audio drama". The Studio appears beside the conversation as the showrunner starts working.
4. Read the chapter in the Studio. Select anything you would change. Settle the proposals and suggestions in *Review*. Go full screen when you want the room.

`/novel status`, `/novel mode <ideate|bible|outline|draft|revise|review|stage|play>`, `/novel digest` and `/novel export <format>` are available in the composer.

## Configuration

Everything is in *Novel Studio → Settings*, and the showrunner can do all of it for you in the conversation; see [docs/configuration.md](./docs/configuration.md) for each field, deployment defaults and per-book overrides.

**Text models come from DSH.** The showrunner, the writer and the crew all run on models from DSH's *Settings → Models*; in the Studio you only choose — each role follows the conversation's model or is given one of its own.

**One-click setup** — paste one key and get the Studio's own three capabilities configured as recommended:

| Service | Images | Speech | Retrieval |
|---|---|---|---|
| Aliyun Bailian | Qwen-Image 3.0 | qwen-audio-3.1-tts-next | qwen3.7-text-embedding-flash |
| OpenRouter | **GPT Image 2.5** | Gemini 3.8 Flash TTS | Qwen3 Embedding 8B |
| OpenAI | GPT Image 2 | gpt-4o-mini-tts | text-embedding-3-small |
| ChatGPT subscription (Codex) | the subscription's GPT Image, no key | — | — |

**Slot by slot:**

- **Models** — two rows to begin with: the writer's model, and one model for the crew (continuity, planner, director, post-production). Each can follow the conversation model or use any model configured in DSH. *Advanced* opens a block per role: its own model, reasoning level, temperature and output cap, and — for a role of the crew — whether it works as an agent or by plain one-question-one-answer calls, which tools it may use (its own, or all of DSH's) and how many steps a run gets. Whether outside help (Claude Code, Codex) and ffmpeg are installed is shown here too.
- **With this book, or for every book** — the models and the crew's ways can apply to every book, or travel with the open one (written into its own `novel.json`).
- **Recommended setup** — which models each service is used with is published with every version as `recommended.json`, not written into the code. Settings that are a recommendation follow the next issue (and the Studio says what moved, with a way to take it back) — or not, if you switch following off.
- **Context** — `auto` (an outline of what came before plus a window of the text; the whole manuscript while it fits), `retrieval`, or `full`; the budget for the text (unset: half of the model's window); how much preceding text is carried verbatim. The page shows, per role, how much its model reads and how much text it will be given.
- **How many at once** — requests out at the same time for speech, pictures, sound and text: 8 by default, up to 256, one place for the whole Studio.
- **Images** (optional) — OpenRouter's `/images` (GPT Image, Gemini, Grok, Seedream, FLUX…), any OpenAI-compatible `/images/generations`, Aliyun Bailian (Qwen-Image, Wan, Z-Image), or a ChatGPT subscription.
- **Speech** (optional) — Bailian audio generation `qwen-audio-3.1-tts-next` (voices are described in words; one reference clip per character keeps them steady), Qwen Omni realtime, Bailian Qwen-TTS (voice design), OpenRouter's `/audio/speech`, or any OpenAI-compatible `/audio/speech`.
- **Semantic retrieval** (optional) — any OpenAI-compatible `/embeddings` endpoint, fused with keyword search.

**Keys** are typed into the settings and saved with everything else. They go to the Harness credential store (one record per endpoint host), never into the settings file and never back to the page; every slot on the same service shares one key, so it is entered once. If you prefer environment variables, `DASHSCOPE_API_KEY`, `OPENROUTER_API_KEY` and `OPENAI_API_KEY` are picked up by themselves, and any slot can name another variable.

**ChatGPT subscription** — with the [Codex Connect](https://github.com/franksong2702/dsh-codex-connect) plugin installed and authorized, or the Codex CLI on the same machine signed in with ChatGPT, illustrations use the subscription's GPT Image: no API key, and no sign-in of the Studio's own. The Openai-Codex text models Codex Connect provides can be assigned to the roles like any other Harness model. A subscription has no embedding and no speech endpoint; use a service above for those.

## What a book looks like on disk

```
my-novel/
├── novel.json                 title, premise, language, targets, active style
├── outline.json               volumes → chapters → beats, plot threads, and the plot lines beside the main one
├── bible/
│   ├── characters/<name>.md   front matter (persona, life, looks, voice) + notes
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

[docs/design.md](./docs/design.md) explains the reasoning behind the split of roles, the working modes, the memory layers, the context packer, the lives of an ensemble and the stage pipelines ([中文](./docs/design.zh.md)).

The package is one npm module with three entry points: a Host half (project store, pipelines, jobs, the Studio's API), an agent half mounted inside the preset (tools, prompt, command), and a browser half (the Studio). See [CONTRIBUTING.md](./CONTRIBUTING.md) for the layout, the dev server and the tests.

## What is sent where

- Text goes to the models you chose for the roles: a role that follows the conversation model or uses a Harness model goes through the Harness LLM runtime (the same routes, credentials and retry policy as your conversations); a role with an endpoint of its own is called by the Studio directly.
- Image prompts, the text of lines to be spoken and (if enabled) text chunks to be embedded go to the media endpoints you configured. Nothing is sent to any endpoint you did not configure; there is no telemetry.
- Keys stay in the Harness credential store on your machine and are only ever sent to the endpoint host they were entered for.
- Books stay in your workspace. Settings live in `$DSH_HOME/novel-writer/`.

## License

[GNU Lesser General Public License v3.0 or later](./LICENSE) (the LGPL supplements the [GNU GPL v3](./COPYING)). You may use the plugin with any Harness setup and combine it with other plugins under their own terms; changes to the plugin itself stay under the LGPL.

**Icon and art.** DeepSeek-chan, the "maid whale-girl" (女仆鲸鱼娘): the icon drawn for this project with GPT Image through Codex, the pictures on the Studio's home page with Qwen-Image after it. Character reference: 溟月 by 上善无形, in the DeepSeek maid design by ZipZipPipe.

The novels you write with it are yours.

---

By Dr. Xu · Project home: <https://dsh-novel-studio.xuhao1.me>
