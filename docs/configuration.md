# Configuration

Everything described here can be changed in *Novel Studio → Settings* (the gear icon), and the showrunner can change it for you in the conversation ("set speech up with Bailian", "use Claude for the writer"). This page is the reference: what each field means, where it is stored, and the other places a setting can come from.

## Two kinds of model

**Text models are DSH's.** The showrunner, the writer and the crew all run on models configured in DSH (DeepSeek Harness) itself — *Settings → Models* there: every provider connected by key or by sign-in. The Studio does not connect text endpoints of its own. This is what lets every role of the crew work as an agent (the agent loop takes DSH's models and no others), and it means a vendor is configured once. In the Studio you only choose, per role, which of DSH's models it uses — or leave it to follow the conversation's.

**Pictures, speech and search are the Studio's.** They are what the Studio configures itself, in one of two ways:

**One click.** *Settings → One-click setup* (also the first-run guide, which opens by itself while nothing is configured): pick a service, paste its key, choose which slots it should fill, click **Set up**. The key is checked against the service first; a key that is refused changes nothing.

| Service | Images | Speech | Retrieval |
|---|---|---|---|
| Aliyun Bailian | `qwen-image-3.0` | `qwen-audio-3.1-tts-next` | `qwen3.7-text-embedding-flash` |
| OpenRouter | `openai/gpt-image-2.5-sunburst` | `google/gemini-3.8-flash-tts` | `qwen/qwen3-embedding-8b` |
| OpenAI | `gpt-image-2` | `gpt-4o-mini-tts` | `text-embedding-3-small` |
| ChatGPT subscription (Codex) | the subscription's GPT Image | — | — |

The models in this table are the recommendations at the time of writing. They are not written into the code: see [*The recommended setup*](#the-recommended-setup) below.

**Slot by slot.** Below the cards, images, speech and retrieval each have their own service, endpoint, key and model. The model field suggests what the service offers and can list what the endpoint itself serves; any id can be typed.

## Where settings come from

Three layers, later ones win:

1. **Deployment defaults** — the `settings` key of the `novel-writer` row in the Harness configuration. Useful for a shared machine or to pre-wire endpoints. In a profile's `cordis.patch.yml`:

   ```yaml
   - id: novel-writer
     name: dsh-novel-writer
     config:
       settings:
         models:
           writer: { provider: deepseek, model: deepseek-v4-pro }
         tts:
           provider: qwen-audiogen
           baseURL: https://dashscope.aliyuncs.com
           model: qwen-audio-3.1-tts-next
   ```

   A patch replaces a row's whole `config`, so restate everything you keep.

2. **User settings** — what you save in the Studio, in `$DSH_HOME/novel-writer/settings.json` (`~/.dsh/novel-writer/settings.json` by default). Shared by every book. It never contains a key.

3. **A book's own settings** — the `models` and `crew` keys of a book's `novel.json`: which model a role uses and how a role of the crew works, for this book only. A role named there is set so for this book whatever the layers above say; a role not named follows them. They travel with the book.

   ```json
   {
     "models": { "writer": { "provider": "deepseek", "model": "deepseek-v4-pro", "temperature": 0.9 } },
     "crew": { "architect": { "tools": "all" } }
   }
   ```

   In *Settings*, the switch at the top of *Models* says where the models and the crew's ways of working are saved: **for every book** (layer 2) or **with this book** (this layer). In a book's own settings "not set" reads "as set for every book". Pictures, speech and retrieval are always Studio-wide — a book's own look, storyboard density and voices live in its information and on their own screens.

### The settings page

The page starts short. *Models* has two rows: the **writer's model**, and one **crew model** that continuity, the planner, the director and post-production all take — with, beside it, **what the crew may do**, one choice for all four: *agent, with its own tools* (the default), *agent, with all tools*, or *not an agent* (see *The crew* below for what each means). Where the four differ, the row says so and leaves them as they are until one is chosen here. Pictures, speech, sound and retrieval are each a line that says what is in use and unfolds when pressed. That is what most authors ever set.

**Advanced**, a switch at the top right that stays as it was left, brings the rest: a block per role with everything about that role in one place — its model, reasoning level, temperature and output cap, and, for a role of the crew, what it may do (the same three-way choice, for that role alone) and how many steps a run gets; how many requests go out at once; the context budgets (`context.budgetTokens`, `context.sideTokens`, `context.playTokens`, `context.tailChars`); the shape of each kind of picture and how many reference images a picture carries. A link that leads to a part of the page ("speech is not set up") opens that part, Advanced included, whatever was folded.

A crew whose roles are on different models shows as such on the short page, and choosing a crew model there sets all four.

## The recommended setup

Which image model a service is best used with, which models are worth offering beside a field, how large the window of a model family is — all of it ages by the month. None of it is written into the code. It is **`recommended.json`**, a file at the root of the package that is published with every version, carries an issue number and a date, and is read when the Studio's Host half starts.

```json
{
  "schema": 1,
  "version": 1,
  "date": "2026-10-08",
  "notes": { "zh": "…", "en": "what this issue changed, for the author" },
  "services": {
    "bailian": {
      "image": { "provider": "dashscope", "model": "qwen-image-3.0", "label": "Qwen-Image 3.0", "suggestions": ["qwen-image-3.0", "qwen-image-3.0-pro"] },
      "tts": { "provider": "qwen-audiogen", "model": "qwen-audio-3.1-tts-next" },
      "embedding": { "provider": "openai", "model": "qwen3.7-text-embedding-flash" }
    }
  },
  "providers": { "tts": { "dashscope": { "model": "qwen3-tts-instruct-flash", "designedVoiceModel": "qwen3-tts-vd-2026-01-26", "narratorVoice": "Serena" } } },
  "unlisted": { "bailian": { "tts": ["qwen-audio-3.1-tts-next"] } },
  "windows": [{ "match": "(^|/)deepseek-v4", "tokens": 1000000 }],
  "maxOutput": [{ "match": "(^|/)deepseek-(flash|v4)", "tokens": 384000 }]
}
```

| Part | What it decides |
|---|---|
| `services.<service>.<slot>` | what a one-click setup of that service fills a slot with (`provider`, `model`, for speech a `narratorVoice`), the model's name as people say it (`label`), and the models offered beside the field (`suggestions`) |
| `providers.<part>.<kind>` | the model a kind of endpoint is used with when a slot names none, and — for Qwen TTS — the model that speaks in designed voices |
| `unlisted` | models a service serves without listing them |
| `windows`, `maxOutput` | context windows and reply ceilings of model families, told by a pattern over the model's id; used where neither DSH nor the endpoint says |

Addresses are not in the file: where a service is reached is the Studio's own knowledge, and a custom address typed into a card still applies.

**Following.** *Settings → One-click setup* shows the issue in force and a switch, **Follow updates**, on by default.

- *Following*: when a new issue recommends another model for a service, a setting that **still is what the earlier issue recommended** moves to the new one. A model you chose instead is yours and is never touched. With the speech model moves the narrator's voice, when that too was the recommended one — a voice belongs to its model; a voice never moves on its own.
- *Not following*: nothing is changed. You are told what the issue would change, and choose **Adopt** or **Keep mine**.

Either way it is said: a notice at the top of the Studio (and on the settings page) names the issue and each setting with its old and new value, until you have settled it — **Got it**, or **Take it back**, which restores the old values. Settings taken back, or kept, count as your own choice from then on: later issues leave them alone and do not ask again. Pictures and audio already made are not redone; what is made from then on uses the new models — worth knowing in the middle of a book, where a different model can draw or sound a little different.

What is known about model families (`windows`, `maxOutput`), the models suggested beside the fields and the defaults of a slot that names no model are not settings: they are simply what the issue in force says.

Where the settings stand is kept in `settings.json` under `recommended`: `follow`, the `version` they were last brought up against, and which values were a recommendation when they were set (`adopted`).

**Publishing an issue** (for whoever maintains the package): edit `recommended.json`, raise `version`, set `date`, and say in `notes` what changed. It ships with the package (it is in `files`); nothing else needs to change, and the tests check that the file still names a model for every kind of endpoint the code can ask about. An issue older than the one a build was made with is ignored.

Session state (the working mode and which book a session is on) lives in `$DSH_HOME/novel-writer/sessions.json`.

## The book in play

A conversation is on one book at a time, and the Studio beside it shows that same book. The two move together:

- **Open another book in the Studio** and the conversation follows. The showrunner is told at its next step — in the conversation's own record, so it holds after a long session too — which book is now in play, which one the earlier turns were about, and that unfinished work on the earlier book must be named explicitly rather than carried over.
- **Ask the showrunner to switch** ("切到《…》") and the Studio follows: it moves the session with `novel_status project=…`, and the panel opens that book.
- **Touching another book once** does not need a switch. Every tool takes an optional `book` (a title or a path): "copy this character over from 《…》" reads there and writes here, and the conversation stays where it is. The tool row in the conversation shows the book such a call named, and in a conversation that has been on more than one book every result says which book it is about.
- **An agent at work for the conversation** — a role's run, a subagent the showrunner sends out — is on the book its work is about: the one its task names, else the conversation's own. It has the conversation's folder, and that says nothing here: a folder can be a book of its own with other books inside it.

Two safeguards: a call acts on the book the showrunner was last *told* is in play, so changing book in the Studio while it is mid-step cannot land a half-finished task on the other book; and changing a book outside the conversation's workspace on the showrunner's own initiative asks for confirmation first.

## Keys

A key is typed into the slot that needs it and saved with the rest of the page.

- It is stored in the **Harness credential store** (`$DSH_HOME/.credentials.yaml`) as one record per endpoint host, under this plugin's scope: `novel-writer/key-<host>`. It is not written to `settings.json` and is never sent back to the browser — the page only learns whether a key exists and where it comes from.
- **One key per host.** Every slot that talks to the same service shares it, so it is entered once; and a key is only ever sent to the host it was entered for. Changing a slot's endpoint to another host does not carry the key along.
- **Environment variables are picked up by themselves.** Without a saved key the usual variable of the service is used: `DASHSCOPE_API_KEY` for `*.aliyuncs.com`, `OPENROUTER_API_KEY` for `openrouter.ai`, `OPENAI_API_KEY` for `api.openai.com`. A saved key wins over the variable.
- **A slot can name its own variable.** *Use env* on a key field (or `apiKeyRef` in the file) makes that slot read the key by name — resolved through the Harness credential service, which reads the environment of the process that started the Harness, then its own store.
- *Check* asks the endpoint whether the key opens it; *Forget* removes the saved key of that host.

The showrunner never takes a key through the conversation. Asked to set something up without one, it opens the settings and asks you to paste the key there.

## Model roles

| Role | In the Studio | Used for | Falls back to | Default temperature |
|---|---|---|---|---|
| `writer` | 写手 Writer | drafting, continuing, rewriting, style samples, novelizing interludes | conversation model | 0.85 |
| `analyst` | 场记 Continuity | digest and arc summaries, review, taking in manuscripts, learning a style from a sample | conversation model | 0.2 |
| `architect` | 策划 Planner | foundation, chapters, beats, what-if, expanding bible entries, scoping book-wide revisions, merging cast and outline on import, research | writer → conversation model | 0.8 |
| `director` | 导演 Director | audio scripts, storyboards, a character's visual anchor, illustration prompts, interlude turns | writer → analyst → conversation model | 0.9 |
| `producer` | 后期 Post-production | cutting a chapter's video | conversation model | 0.2 |

"Conversation model" is the model of the conversation the work belongs to: the session whose showrunner called a tool, or the session the Studio sits beside when you start work from one of its screens. Work started on the Studio's own page, beside no conversation, uses DSH's default model.

A role is one of two things:

- **unset** — it follows the conversation model;
- **a model of DSH's** — a route (`provider`, `model`) called through DSH's model runtime with its credentials and retry policy. The role's list names every provider DSH reaches, one entry each: those with a key under *Settings → Models*, and those that came with a sign-in — the ChatGPT subscription of Codex Connect appears as `OpenAI Codex`.

| Field | Meaning |
|---|---|
| `provider`, `model` | a route of DSH's |
| `temperature` | optional override of the role default |
| `maxTokens` | optional cap on how long a reply may run. Unset by default: see *How long a reply may run* below |
| `reasoningEffort` | one of the levels the model declares. Omitted = the model's default |
| `contextWindow` | how many tokens the model can read, when DSH does not say. It decides how much of the book a call is given — see below |

**Direct endpoints of earlier versions.** A role saved with a `baseURL` of its own (an OpenAI-compatible endpoint the Studio called itself, with a key entered in the Studio) keeps working as it did — by plain calls. It cannot work as an agent, and the Settings screen says so on that role, with a button back to the conversation's model. New ones cannot be made: connect the vendor in DSH instead. For such a route `apiKeyRef` reads the key from a variable instead of the one saved for the host, and `reasoningEffort` is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, translated per service.

## The crew

Continuity, the planner, the director and post-production are **agents of DSH**: each a persona, rules, skills, tools and permissions of its own, on the model chosen for it above. (The writer is not one of them: it writes, and has nothing to look up or call.) When the showrunner — or a button in the Studio — gives one of them work, the run is a **subagent of the conversation** the work belongs to: it is listed under *subagents* in that conversation's header, where every step of it can be opened and read, with its tokens and its time. A finished job also names the roles that worked in it, and how (*Jobs*, the clock at the top of the Studio).

*Settings → Models* has this as one choice beside the crew's model — **what the crew may do**: *agent, with its own tools* (`mode` and `tools` both left at their defaults), *agent, with all tools* (`tools: all`), *not an agent* (`mode: call`) — and, with *Advanced* on, the same choice and the step limit on each role's own block. As settings they are:

| Setting | Values | |
|---|---|---|
| `mode` | `agent` (default), `call` | As an agent the role looks things up, tries, and hands its result in through a tool that checks it. `call` is one request and one answer, as it was before there was a crew: faster and cheaper, blind to the rest of the book, without tools — and a task given in words (`novel_crew`) or a video cannot be done that way at all |
| `tools` | `own` (default), `all` | `own`: the tools the Studio gives the role — reading the book, handing in — and those few of the conversation's tools its work calls for (the planner: `web_search`, `web_fetch`, `skill`; post-production: `bash`, the file tools, `skill`, job control, and the outside agents below). `all`: whatever the conversation itself has — a shell, files, the web, MCP servers — except the showrunner's own `novel_*` tools and the tools that need a person in the room |
| `steps` | a number | Tool calls one run may make before it is told to wrap up (continuity and the director 30, the planner 40, post-production 200 by default). Past it, only the tool that hands the work in still answers |

In `settings.json` (or, for one book, in its `novel.json`):

```json
{ "crew": { "architect": { "tools": "all", "steps": 60 }, "director": { "mode": "call" } } }
```

What a role's tools reach is what the conversation's preset mounts — the plugin's own preset (小说家 Novelist) mounts files, search, the web, a shell, skills and job control; add MCP servers or other tools to it in your profile and a role set to `all` has them too. A role runs under the permission mode of its conversation, and anything that would ask for approval is refused outright — nobody is there to answer. Whatever tools a role has, a book's own files change only through the Studio's tools: a raw write to a chapter is refused for a role as it is for the showrunner.

**When a role is not an agent.** If a role is set to `call`, if its model is a direct endpoint of an earlier version, or if its agent run hands nothing in, the work is done in one plain call instead — and the job says which, and why. Nothing falls back silently.

**Skills.** A role's skills ship with the package under `crew/<role>/skills/<name>/SKILL.md` and are registered for that role's runs alone: post-production has `novel-video-editing`, the planner `novel-trend-research`. They are ordinary skill files; edit them where the package is installed to change how a role works.

**Outside help.** Post-production may hand work to another coding agent when it cannot do it well itself. This is DSH's own subagent, not a mechanism of the Studio's: install `@deepseek-ai/dsh-subagent-claude-code` or `@deepseek-ai/dsh-subagent-codex` (Plugins → Add plugin, or `dsh plugin --profile <name> add …`) and `subagent_claude_code` / `subagent_codex` appear among post-production's tools — the preset already mounts `@deepseek-ai/dsh-tool-subagent` for both, and those rows do nothing while the providers are absent. For outside help to write files and run ffmpeg, set that provider's `permissionMode` to `acceptEdits` or `auto` (its default, `dontAsk`, denies what your Claude settings do not already allow). It runs on your own Claude Code or Codex sign-in and quota. *Settings → The crew* shows which are installed.

## A chapter's video

*Stage → Motion comic → Video* (or `novel_video` in the conversation). The chapter's voice, sound cues and storyboard pictures are material, not input to a renderer: the Studio lays them out on one timeline and hands them to post-production, which cuts the video with a shell — `ffmpeg` and `ffprobe` have to be on this computer (macOS: `brew install ffmpeg`; Windows: `winget install ffmpeg`; Linux: your distribution's package manager).

What post-production finds in its working directory, `assets/video/work/<chapter>/` inside the book:

| File | |
|---|---|
| `materials.json` | the whole timeline: every line (start, end, speaker, text, the path of its take), every panel (start, end, picture, description, camera move), every sound cue, the cover and other pictures |
| `voice.wav` | the telling as one track, every take where the timeline puts it |
| `subtitles.srt` | the lines, cut for the screen |
| `panels.tsv`, `cues.tsv` | the panels and the cues as tables a shell reads |
| `cut-base.sh` | a script that makes a plain first cut from the above — a starting point the agent may run, change or ignore |

A result is taken only if it passes the Studio's checks: a picture and a sound, a sound that is not silence, a length that matches the telling (a title before it is welcome), no long black stretches — and, unless *With subtitles* is unticked, the lines where a viewer gets them. The file becomes `assets/video/<chapter>.mp4`; what post-production says about its cut is shown with it. *What you want of this cut* — pace, a title card, the look — is passed to the agent in your words.

**Subtitles.** The Studio gives post-production the lines cut for the screen and timed (`subtitles.srt`), says that the viewer must see them, and checks that they are there: drawn into the picture — which goes wherever the file goes — or carried in the file as a subtitle track. Which of the two, and by what means, is post-production's to decide on the computer it finds itself on: many ffmpeg builds (Homebrew's current one among them) cannot draw text, and an agent may then draw the words as pictures with whatever that computer has, or settle for the track and say so. The Studio writes no tool of its own for this and prescribes no command. Its player shows a subtitle track that the file carries (a web player does not show one by itself, so the Studio keeps the track's words beside the file as `assets/video/<chapter>.vtt`; a video cut before this gets that copy the first time it is opened), and the line under the player says which kind this cut has.

A sealed book cannot be cut — its material is ciphertext, and a shell cannot be handed that.

**How long a reply may run.** The Studio sets no limit of its own on what a model writes. A model that reasons spends its reasoning out of the same allowance as its answer, so a cap sized for the answer alone — a few thousand tokens for a script, a storyboard, a chapter — cuts the answer off; that is how an audio script loses its speakers and a storyboard ends after two panels. With `maxTokens` unset, a Harness route uses the limit its provider is configured with (256,000 tokens for the DeepSeek models, whose own maximum is 384,000 of a 1,000,000-token window), and a direct endpoint uses its own default — except DeepSeek's own API, whose default is 8,000 tokens with reasoning off, where the Studio asks for the model's documented limit instead. The settings show, per role, what applies. Set `maxTokens` only to hold a model back on purpose.

A reply that is cut off at a limit all the same is not patched up and passed along: the step fails, or falls back visibly, and says that the limit was the reason.

**When a call fails.** A model service is busy, limits its rate or drops a stream now and then; and now and then a model completes a reply that has reasoning in it and no answer. The Harness makes such a request again for its own agent, by the retry policy of the provider (`retryPolicy` on the provider in the Harness configuration; by default five more tries, waiting half a second and then longer, for `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT` and `TRANSPORT`). It does not do so for calls a plugin makes — so the Studio runs the same policy itself, for every call: Harness routes use their provider's policy, direct routes the defaults. While it waits, the job's progress line says what happened and which try is next; every attempt is in the usage ledger, because every attempt was a call. A reply with no answer is asked for again unchanged, three times at most, since each of those cost its reasoning. What trying again cannot mend — a wrong key, an unknown model, an allowance spent entirely on reasoning, a provider's content filter — fails at once and says which it was.

**Reasoning models.** A model that thinks before answering can take minutes per chapter and per digest. Lower or switch off reasoning for the writer and continuity; keep some for the planner and for post-production, where it pays. If the levels list of a Harness model is empty, declare them on the provider in the Harness configuration (`reasoningEfforts` on the model entry — see the Harness provider documentation).

## Context and memory

| Field | Default | Meaning |
|---|---|---|
| `context.strategy` | `auto` | `auto`: an outline of what came before plus a window of the text itself — the whole manuscript while it fits. `full`: give the text all the room the model has. `retrieval`: no window of text; summaries and retrieved passages only (the cheapest). |
| `context.budgetTokens` | unset | how much of the story's own text one call carries. Unset: **half of what the model can read** (500,000 tokens for a model that reads a million). Whole chapters only — the figure is rounded down to a chapter boundary. |
| `context.tailChars` | `3000` | characters of the text just before the writing position that are always carried verbatim, even when the chapter they belong to is outside the window |
| `autoDigest` | `true` | digest a chapter right after it is written or a revision is applied |
| `reviewAgentRevisions` | `false` | when on, revisions requested by the showrunner wait as proposals instead of applying |

**What a call is given.** The story before a chapter comes in two layers: the chapters nearest to it, whole and verbatim, within the budget above; and one line per chapter for everything older. Beside that, at most 22 % of the window (120,000 tokens at most) goes to the bible, threads, lore and retrieved passages, and about 12 % is kept free for the instructions and the reply. When a chapter in the middle of the book is rewritten or revised, the chapters written after it are given too — nearest first, at least three tenths of the text budget. *Settings → Context* shows the figures that apply to each role's model as it is set up now.

**Where the window comes from.** In this order: the role's own `contextWindow`, DSH (for its models), the endpoint (OpenRouter publishes one per model), and the table of model families in the recommendations (`windows` in `recommended.json`; at the time of writing the Qwen 3.5+, DeepSeek V4, Kimi K3, GPT-6, Claude 5 and Gemini 3 families are taken as one million). A model nobody can place is assumed to read 200,000 tokens — set `contextWindow` on its role when it reads more.

**Built for the provider's cache.** The part of a request that does not depend on the chapter — book, world, cast, the outline of what came before, the text — is sent first and as a block of its own, and grows only at its end from one chapter to the next. The window does not slide by a chapter each time: it keeps its starting chapter until the text no longer fits, then lets go of the oldest quarter at once. A provider that caches prefixes (DeepSeek, Bailian, OpenAI, Anthropic and Gemini all do, each in its way) therefore re-reads most of every request from its cache; what it reports as cached is in the usage ledger, priced with the `cached` price when you have entered one.

Settings files saved by earlier versions carry budgets nobody chose (48,000, later 500,000). They are dropped once, when the file is first read by this version (`revision` in the file records that it happened); a budget set afterwards is kept whatever its value.

**Chapter length.** There is no setting for it. A chapter's recommended length is in its plan, a book's default in the book (*Overview → book details*, or `chapterBudget` in `novel.json`); with neither, the writer judges from the plan and from how long the book's chapters run.

## Images (optional)

| Field | Meaning |
|---|---|
| `image.provider` | `none`; `openrouter` (`POST <baseURL>/images`); `openai` (`POST <baseURL>/images/generations`); `dashscope` (Bailian's native API: Qwen-Image, Wan, Z-Image); `codex` (a ChatGPT subscription) |
| `image.baseURL` | `openrouter`, `openai`: the `/v1` base. `dashscope`: only the origin matters (`https://dashscope.aliyuncs.com` or a workspace domain). `codex`: unused |
| `image.model` | e.g. `openai/gpt-image-2.5-sunburst`, `gpt-image-2`, `qwen-image-3.0`, `z-image-turbo` |
| `image.size` | default `WIDTHxHEIGHT`; panels and interlude backgrounds ask for 1280x720, portraits for 1024x1024 |
| `image.quality` | `openrouter`, `openai`: `low`, `medium`, `high`; omitted = the model's default |
| `image.bridge` | `codex` only: `auto` (default), `connect` or `cli` — see below |
| `image.stylePrompt` | *legacy*: a Studio-wide art direction from before the look became each book's own. Still what a book without one starts from; no longer offered in the settings, which show it — with a way to clear it — while it is set. See *How a book keeps one look* below |
| `image.resolution` | how fine pictures are drawn: `720p`, `1080p`, `2k` or `4k` — as many pixels as a screen of that name, in each picture's own shape. Unset: each kind of picture at its usual size |
| `image.aspects` | the shape of each kind of picture — `cover`, `portrait`, `sheet`, `location`, `scene`, `panel` — as an aspect (`1:1`, `3:4`, `4:3`, `16:9`, `9:16`, `3:2`, `2:3`) or exact pixels (`1600x900`). Unset: a cover stands (2:3), a stage lies (16:9), a portrait is square, a design sheet 3:2 |
| `image.negativePrompt` | what no picture of any book may show; each book adds its own list |
| `image.sheetFirst` | `false`: do not draw a missing design sheet before a picture that shows somebody. Unset: the sheet comes first (see *One look per book*) |
| `image.apiKeyRef` | read the key from this variable instead of the saved one |

How sizes travel: OpenRouter gets the nearest aspect ratio and a resolution tier, which every model there understands; GPT Image models on an OpenAI endpoint get the nearest of their three classic sizes; other models get the size as written; a subscription gets the framing in words, because its endpoint takes a prompt and nothing else.

Generated images are downloaded into the book (`assets/images/`), so a book never depends on an expiring URL.

### A character's life

A card carries no status — no *active*, *offstage* or *dead*. (Cards written by earlier versions have a `status:` line in their front matter; it is no longer read, and is left out the next time the card is saved.) Where somebody is in the book is their **life on the page**, which nobody sets: it is read off the chapter digests along a line of the plot — the chapters they are in, where they come on, return, leave or die, and what each digest noted of them. A person's page says it in a line under their name and shows it chapter by chapter; *Tell it in a paragraph* has continuity write that life out (kept as `life` on the card, and the author's to edit). *People → Lives* is everyone's life in one table: a row a person, a column a chapter of the line — on the page, coming on or back, leaving, dying, planned by the outline, planned but missing. A book with more than one line of the plot offers the line to read along; a chapter that was not digested is a chapter nothing is known of, and is shown as such. A death or a leaving that is missing or wrong is the digest's to put right: digest the chapter again.

The notes on the ensemble above the page (*Scheduling notes*) are one line by default; they unfold, and *Hide* puts them out of the way — a small mark at the end of the tabs brings them back. The choice is kept on the device.

### The world along a line of the plot

A story that parts is two stories from where it parts. *Outline → Plot graph*, with a line chosen, shows **the world along that line**: everybody the digests along it name, as they stand where its digests end — present, away, gone for good, dead — and its threads, paid off or still open (`line.world`). *Hold another line against it* compares two: where they part, how many chapters each goes on by itself, and what is different after that — somebody for whom it **ended differently** (dead on one, alive on the other; gone here, still there), somebody **only one line** comes to, a thread paid off on one and open on the other. Being on the page lately or not is no difference of fate — a longer line has everybody away sooner or later — and what happened before the lines part is the same story. A name opens that person's page, read along the line the difference was found on.

**What each has come to know.** A digest notes what its people learn in the chapter; along a line that adds up to what each knows where the line ends (*What they know*, to be unfolded: person by person, chapter by chapter). Held against another line, a person's row says what they **learned after the parting** on each — what one of them knows that their other self never finds out — and somebody for whom it ends the same on both, but who came to know other things on the way, has a row of their own (*knows other things*).

All of it is read off the chapter digests, so it is as true as they are: a chapter that is written and not digested says nothing. Digesting (*Digest*, `novel_digest`, a batch) covers the chapters of every line, not the main one alone.

### Places and things

An entry of the bible that is a place or a thing can have design art of its own (*Bible → Places*, *Bible → Things*; `novel_illustrate kind=location` / `kind=item`): a place as somewhere to stand — wide, without people — and a thing alone, whole, on a plain ground. What the picture shows is the entry's *visual description* — and where that is empty, the **director writes it first**, from what the book says: handed the entry and the sentences of the text that name it, it writes a paragraph of what the place or the thing actually looks like, in the book's language, and that is kept on the entry (`visualPrompt`), to be read and changed. (*Have the director write it* beside the field does the same on request, following a wish written under *Direction*; `novel_bible action=derive_visual kind=world`; `ai.worldLook`.) A name alone would be drawn as the commonest real thing of that name; where no model can be had to write the look, the entry's own words stand in. Pictures set in the place, or showing the thing, are drawn with that art as a reference image — chapter illustrations and the panels of a motion comic alike: faces come first, the place keeps its seat among the references, and a thing the picture names takes one where there is room.

Not every place needs one. Entries that are somewhere or something carry a **weight in the story** — core, major, minor, passed once — read off how many chapters name them (`weight` in the entry's front matter overrides it). A batch draws art for the core and major ones — places (`places`) and things (`items`) alike; one passed once is drawn only when asked for by name.

### The course of a place, a house, a thing

Places are built and burn down, houses rise and fall, things are made and lost. An entry that is somewhere or something has a **course**: what happens to it at which chapter — it *begins* (built, founded, first there), *changes* (owner, name, shape), *declines* (left to ruin), *ends* (destroyed, lost, dissolved) — each with a few words of what happened (`events` in the entry's front matter). The planner writes these down with the ties when it works them out, from what the book says outright; under *Its course* on the entry's page they are added, changed and taken away by hand.

In the viewer the course is told on the entry's page, each event a way into its chapter, and it decides how the entry stands at the chapter the story is looked at: before it begins it is not there to be stepped into (nor marked on the scene of the place it will be in), in decline it says so, and once it has ended it stands back, greyed. A reader is given the course as far as the chapters they have; a book published a part at a time, as far as that part.

A turn of the course can have **a picture of its own** — the garden while it is still scaffolding, the same garden with its paint peeling and grass between the stones (*Draw it then* at the end of the turn's row; `image.create` with `event`; `novel_illustrate kind=location|item target=… event=<chapter>[:<kind>]`, the chapter alone meaning the first turn written in it). What happened is written down as a story — who did what — and an image model draws that as written: people, and the place as it ever was. So the director first writes what is there to be seen once it has happened, from how the place usually looks (its visual description) and from where that chapter names it, and that paragraph is drawn — without people. A *change* or a *decline* is the same sight altered, and is drawn against the entry's design art ("the same place at another time: where it lies and how it is laid out as the reference has it, the state it is in as described"); a *beginning* or an *end* is another sight altogether and is drawn from the words alone — with the design art before it, an image model hands the finished place back with a little rubble on the ground. The picture is kept with the turn (`image` on the event); the entry's design art and its visual description stay what they were. Rewording a course keeps the pictures of the turns that stay (a turn is the same turn by its chapter and its kind); the × beside a turn's picture takes it off the turn.

The viewer shows the picture that belongs to the chapter looked at. A turn that has one shows the entry from then on, and turns after it that have none leave it as it was drawn — a garden in ruins stays in ruins when its gate is locked. Two things put the design art back: the entry *begins* again (rebuilt, founded anew), and anything at all happening after a picture of its *beginning*, which shows it coming to be and holds until the next thing happens to it. Looked at "whenever", an entry is its design art. On a picture of a beginning or an end the marks of a scene are laid out afresh — those pinned by hand were put on the usual picture. A published site carries the pictures of the turns it tells of, and none of a turn after the last chapter published.

Where the book goes more than one way, **the album is of one line of the plot** — the main line, or another that has a chapter written (for readers: one that is not put aside). The bar that tells the story's time has the lines to choose from; on another device it is the line being read. Along a line other than the main one the story's time is that line's chapters (what comes before the parting, then its own), a life is what the digests along it note, an entry is named where that line's text names it, its course tells the turns that happen in that line's chapters, and a tie that begins in a chapter of another way does not hold (one that ends there goes on holding). `reader.album` takes `line`; other devices ask `api/books/<id>/album/<line>`; a published site carries `data/<book>/album/<line>.json` for every way it offers.

### One thing under several names

A book read in by import — and one written over years — has a place written down under every name the text calls it by, and an entry or two filed under the wrong kind. *Tidy* (above the lists under *Bible*) has the planner look all entries over and list what it is sure of: groups of entries that are **one thing** (each with a line of grounds from the text), and entries **filed wrongly**. It is a proposal: every line can be unticked, the name that stays in a merge can be chosen, and nothing is changed until *Do what is ticked* is pressed.

A merge (`world.merge`; *Merge…* on an entry's own page does one by hand; `novel_bible action=merge` for the showrunner) makes several entries one: the names folded in become other names of the entry that stays — the text is counted by them too — what the others say beyond its own line is kept under their name at the end of its text, a picture it lacks is taken over with its scene marks, it is as heavy as the heaviest of them, and every tie, every mark on another place's scene, every "goes with" and the gallery's record of their pictures point at it. A tie that became a double, or a thing tied to itself, is dropped. A merge is not undone with one press.

### How the things of the world stand to each other

`bible/relations.json` holds the **ties** of the book's world, five kinds, each from one thing to another:

| Kind | From → to | |
|---|---|---|
| `within` | a place → the place it is in; a branch → its house | a courtyard in a garden in a mansion in a city |
| `seat` | a house or organization → a place | where it has its seat |
| `member` | a character → a house or organization | |
| `resides` | a character → a place | the most particular place: the courtyard, not the garden |
| `holds` | a character → a thing | |

A tie may carry `since` and `until` (chapter ids): a move, an expulsion, a thing changing hands are two ties one after the other. The planner writes them from the bible and the chapter digests — as a pass of reading an imported book in (`ties`, after the cast and the world; an analysis begun before the pass existed is whole without it, and `novel_import action=analyze steps=ties` runs it by name) and whenever asked (*Have the planner work out the ties*, on the first page of the viewer's *World* and above the list under *Bible → Places* and *→ Houses*); a place, a house or a thing a tie names and the bible lacks is made an entry (of the lowest importance, so that it does not travel with every request), and the result says which. Ties already there are kept unless the planner calls one wrong. By hand, a tie is added or taken away under *In the world* on the page of either of its ends. Deleting a card or an entry takes its ties with it.

The viewer's *World* (see *The album* below) walks the world by these ties, and its slider chooses a chapter of the story: a tie holds from its `since` to its `until`, and a character stands as their life on the page has them at that chapter.

The showrunner has all of it at hand through `novel_bible`: `action=ties` lists the ties (all, or those that name `ref`), `action=tie` writes one down or says one again (`fields {kind, from, to, since, until, note}`, names or ids; chapters by id or number), `action=untie` takes one away, `action=derive_ties` has the planner work them out as the button does, `action=tidy` has it look for entries that are one thing and for entries in the wrong category (a proposal: nothing is changed until the showrunner merges and moves what it and the author agree with), and `action=pin` puts a mark onto a place's picture or lets it go (`ref` the place, `fields {mark, x, y}` with 0–1 from the left and the top, or `{mark, clear: true}`). A place's, a house's or a thing's course is saved with the entry: `action=save kind=world fields.events=[{chapter, kind, what}]`. Looking (`ties`, `tidy`) stays off the book's record; a tie written or taken away and a mark moved are on it, in words.

### How a book keeps one look

Nothing reaches an image model that the author cannot read and change. A prompt is assembled from parts, and every picture records the parts it was made of (*Stage → Illustrations*, open a picture):

- **Art direction** — one text per book (`artStyle` in `novel.json`), appended to the subject of every picture, with the book's own list of what no picture may show (`artAvoid`). It is a page of the book's bible — *Bible → Art* — where it is read, changed, or settled anew by the director (*Have the director settle it*, with a word on which way if you like). The director settles one by itself as part of importing a manuscript (the `art` pass of the analysis) and of drafting a new book's bible. A book that has none of its own starts from the built-in direction — or from `image.stylePrompt`, where one was entered in an earlier version — and its first picture writes whichever is in force into `novel.json`. It is also shown at the top of *Stage → Illustrations*, in *Book info*, and by `novel_settings action=show`.
- **Avoid list** — `image.negativePrompt` for every book, `artAvoid` per book, `visual.negative` per character and `avoid` per call. They are joined, sent as the negative prompt, and given to the model that writes scene descriptions so it steers around them. This is the place for what a setting does not have: a story's "church" that is nothing like a cathedral lists *crosses, gothic cathedral, stained glass*.
- **Visual anchors** — a character's `visual.prompt`: short, concrete, drawable phrases (English is steadiest) for build, face, hair as a shape, clothing by cut and material, signature items. It is restated as is in every picture of them, instead of the prose of the card, which an image model reads loosely. *Distill anchor* on the card (or `novel_bible action=derive_visual`) has the analyst write it; drawing someone without one distills it first.
- **Design sheets** — front, side and back of a character on one sheet (`visual.sheet`). Every later picture of them is drawn with the sheet as a reference image. Further **looks** (outfits: mourning dress, armour, travel clothes) get sheets of their own, derived from the main one so it stays the same person; a scene picks the look that fits its occasion, or is told which.
- **Place art** — reference art of a world entry (`visualImage`), sent along with pictures set there.

Reference images travel with the request where the model takes them: Bailian's multimodal generation, OpenRouter's image endpoint, GPT Image through the edits endpoint, and a ChatGPT subscription through Codex Connect or the CLI. At most three go with one picture — faces first, then the place.

**The sheet comes first.** A portrait asked for somebody who has no design sheet draws the sheet first and the portrait against it. A scene, a panel of the motion comic and a cover do the same for whoever of the people they show comes back in the book — a part that carries it (lead, second lead, antagonist, supporting), or anybody in two chapters or more, written or planned; somebody seen once and gone gets none. Each such sheet is one more image call; the job says so while it runs (*First the design sheet of …*) and the picture says so when it is done, and a batch of portraits shows the sheets as steps of their own. Two pictures that need the same sheet at the same time wait for one drawing of it. `image.sheetFirst = false` (Settings → Images) turns it off: pictures are then drawn from what there is.

A good order for a new book: write the art direction and the avoid list, make a design sheet for each main character, add looks and place art where the story needs them, then illustrate.

### Images from a ChatGPT subscription

`image.provider: codex` draws with the GPT Image included in a ChatGPT plan. The Studio has no sign-in of its own; it rides on one that already exists:

- **`connect`** — the [Codex Connect](https://github.com/franksong2702/dsh-codex-connect) plugin. It exposes a Host service for companion plugins (`ctx.openaiCodexTransport`); the Studio hands it a prompt and receives the image. Authorize once under Harness *Settings → Models → Openai-Codex*.
- **`cli`** — the Codex CLI on the machine that runs the Harness, signed in with `codex login`. One non-interactive run in a read-only sandbox, with the prompt passed on standard input, produces the image (about a minute each).
- **`auto`** uses Codex Connect when it is signed in, else the CLI.

A subscription has no embedding endpoint and no speech endpoint — retrieval and audio need a keyed service. Whether a plan includes image generation, and how much, is decided by OpenAI.

## How many at once

| Field | Default | Counts |
|---|---|---|
| `tts.concurrency` | `8` | lines being spoken |
| `image.concurrency` | `8` | pictures being drawn |
| `sound.concurrency` | `8` | ambiences and effects being made. When sound uses the speech service's own model and key, the two share one limit — the speech one |
| `textConcurrency` | `8` | pieces of text work running side by side: chapters being digested, reviewed or given beats, blocks of a script, agents of the crew |

Each figure is one limit for the whole Studio, not per job: three chapters being voiced at once share the eight. The ceiling is 256.

The figure is what the Studio *tries*. When a service answers that requests come too fast (HTTP 429, 503, 529, or its own throttling codes), the limit is halved, everything waits a moment (longer each time in a row, 30 seconds at most, or as long as the service asks), and the refused request is sent again — up to seven times — rather than failing the line. Each full round of requests that goes through raises the limit by one until it is back at your figure. While this lasts, the job dock says so ("speech is being rate-limited: 8 → 4"). A request that fails for another passing reason is tried twice more; one refused over the account's balance is not tried again.

So a high figure does no harm where the account's quota is lower — it is found by running into it. Settings files of earlier versions carried `tts.concurrency` 2 or 3 from the one-click setups; those are dropped once and the default applies.

## Speech (optional)

| Field | Meaning |
|---|---|
| `tts.provider` | `none`, `qwen-audiogen`, `qwen-realtime`, `dashscope`, `openrouter` or `openai` |
| `tts.baseURL` | `qwen-audiogen`, `dashscope`: the Bailian origin. `qwen-realtime`: the WebSocket URL (`wss://dashscope.aliyuncs.com/api-ws/v1/realtime`, or a bare origin). `openrouter`, `openai`: the `/v1` base |
| `tts.model` | e.g. `qwen-audio-3.1-tts-next`, `qwen3.8-omni-flash-realtime`, `qwen3-tts-instruct-flash`, `google/gemini-3.8-flash-tts`, `gpt-4o-mini-tts` |
| `tts.designedVoiceModel` | `dashscope` only: the model that speaks designed voices |
| `tts.narratorVoice`, `tts.narratorInstructions` | the narrator's voice and reading manner |
| `tts.defaultVoices` | fallback voices for `female`, `male`, `neutral` casting |
| `tts.concurrency` | how many lines are spoken at once, over everything that is speaking (1–256, default 8) — see *How many at once* below |
| `tts.retakes` | how many more times a line is spoken when a take fails the listening check (0–4, default 2) — see *One voice, one level* below |
| `tts.sampleRate` | `openrouter`, `openai`: rate of raw PCM when the endpoint does not state it (default 24000) |
| `tts.apiKeyRef` | read the key from this variable instead of the saved one |

Provider notes:

- **`qwen-audiogen`** is Bailian's audio generation model. It has no voice list: a voice is a description in words. A character's voice comes from the *voice* line of their card (else a stock description cast by gender and age); the first time a voice is needed the Studio generates a short reference clip from the description, keeps it in the book (`assets/audio/voices/`), and has every later line imitate that clip — which is what keeps a character sounding the same for the whole book. *Design a voice* on a character card does the same on purpose and lets you audition the result. Lines are spoken word for word, in pieces short enough for the model's two-minute limit; expect about fifteen seconds per line.
- **`qwen-realtime`** opens one realtime session per line, sends the line as text with the voice and delivery direction, and collects the PCM stream. It follows delivery directions well; it has no voice design.
- **`dashscope`** uses the HTTP TTS API. With an `instruct` model each line's delivery direction is honoured; it also supports **voice design**, which creates a persistent voice id from the persona and stores it on the card.
- **`openrouter`** calls `/audio/speech` and asks for raw PCM. Delivery directions go into the prompt for Gemini TTS models and into `instructions` for OpenAI ones; other models read the line as it is. Voices listed by the endpoint for the chosen model appear as suggestions.
- **`openai`** calls `/audio/speech` and asks for WAV; delivery directions are passed as `instructions`.

Audio is stored as WAV in `assets/audio/`.

### One voice, one level

What makes an audio drama sound like one production rather than a pile of clips is decided in four places.

**The script.** The director cuts the chapter into lines and says who speaks each. Narration is kept whole — a paragraph is a line, a fragment of a few syllables joins the narration beside it — because every line is a separate request to the speech model, and a script of fragments is a script of voices that do not quite match. Delivery notes are written for dialogue and inner voice, held steady within a scene, and left off the narration unless the telling really changes key. A passage the model could not deliver (its reply was cut off, or did not cover the text) is cut by rule instead, which knows no speakers; the script then says so on screen, with the reason and a way to direct it again, rather than quietly reading everyone's lines in the narrator's voice.

**The voice sheet.** Who speaks with which voice is decided once per book and kept in `.novel/voices.json`: the voice on a character's card if there is one, else a voice cast by gender and age, and — for speakers without a card, the shopkeeper and the passer-by — a voice of their own, cast by name. The next chapter, and the interludes, cast from the same sheet, so nobody changes voice because they happened to speak in a different order. Another speech provider or model starts a new sheet.

**The listening check.** Every take is measured before it is kept: how long it is against the words it was given, how loud, and how high the voice sits. A take that is silent, far too short for its text (most of the line is missing) or padded, or whose pitch sits well away from where that voice usually does (it came back as someone else), is spoken again — `tts.retakes` times at most — and the best take is kept. A voice is known by its reference clip where there is one, else by its own long lines. A syllable or two says more about its tone than about the speaker, so very short lines are not judged on pitch. A line that still stands out after its retakes is marked in the script, where it can be spoken again by hand; `tts.retakes: 0` keeps the marking and drops the retakes.

**The level.** Every kept line is brought to the same loudness, with peaks rounded off rather than clipped.

Running *Check and repair* on a chapter that is already voiced applies the same check to what is there: lines that fail are spoken again, the rest are only evened out, and nothing else is spent.

This narrows the gaps; it does not close them. A generative speech model such as `qwen-audio-3.1-tts-next` is expressive precisely because it is free, and on a line of one or two syllables it may still shade off. Where an unvarying timbre matters more than expressiveness, the Qwen-TTS models (`dashscope`) with a stock or designed voice hold one exactly.

**Choosing a speech model.** The model field lists every model of the endpoint that can speak, not only those of the service chosen above. On Bailian they speak three different protocols; each entry says which, and choosing a model switches the service to the protocol that drives it. Models served over a protocol the Studio does not speak yet (the streaming-synthesis sockets `…-tts-…-realtime` and `qwen-audio-…-realtime`, third-party models) are listed too, greyed out, so the list is the whole picture.

**While a chapter is voiced** the reader's listening mode shows how many lines are done, which one is in the booth (and when one is being taken again, and why), the time taken and an estimate of what is left; finished lines appear as they come and can be played at once. Stopping keeps what is voiced.

### A narrator who tells a story

How a script is cut decides how it sounds. Every line is spoken in a take of its own, and a narrator who starts over at each paragraph never sounds like one person telling a story — so the script is shaped for speaking:

- Narration that follows narration is spoken **in one take**, up to about 180 syllables; a paragraph too long for one take is cut at sentence ends, evenly. Paragraphs keep a break between them inside the take.
- A few words of narration that only say who spoke — "he said," between two spoken lines — are marked as a **speech tag**. With a voice per speaker they tell the listener nothing, and a clip of two or three syllables is where a speech model is least steady. `tts.speechTags` says what happens to them: `drop` (default) leaves them unspoken, as an audio drama would; `read` has every word read, as an audiobook would. In the script view any line can be switched either way.
- A script made before this (it says so above the script) is **reshaped** on request without calling a model: dialogue keeps its recordings, joined narration is voiced again.

### Sound design (optional)

Besides its lines a script says what each scene sounds like. A **bed** runs under the lines until the next bed; an **effect** is heard once where it is placed; **music** runs under a scene until the next music cue. Each cue has a *caption* — what the reader is shown beside the text, whether the chapter is being read or heard (the speaker button among the reader's controls switches these notes off) — and a *prompt*, what a sound model is asked for.

Where sound comes from is set under *Sound design* in the settings:

| Field | Meaning |
|---|---|
| `sound.provider` | `auto` (default): the speech setup's own model when it can generate sound as well as speech — Bailian audio generation, `qwen-audio-3.1-tts-next`. `qwen-audiogen`: an endpoint named for sound (`baseURL`, `model`, key). `none`: nothing is generated |
| `sound.model` | the sound model; with `auto`, left empty, the speech model |
| `sound.beds` | `generate` (default): beds are made by the model from each cue's description. `browser`: beds are synthesized by the player from a fixed set of presets |
| `sound.effects`, `sound.music` | whether the director places spot effects and music (both on by default) |

Without a sound model the cues are still captions, and beds are synthesized by the player; a bed that has no generated clip yet is synthesized the same way until it has one. *Make the sounds* on the production desk generates what is missing — clips are cached by what they were made from, so a second run only makes what changed. In the script view every cue can be heard, reworded, made again on its own, added or removed.

Sound models are young. Measured on 2026-10-07 with `qwen-audio-3.1-tts-next`: spot effects and music come out as asked and without voices; ambience beds are the least reliable of the three. That is why the browser's beds stay as a choice, and why each cue can be redone by itself.

## Reading and listening

*Read* is one page with three faces, and one play button.

- **Prose** shows the chapter as a reader meets it.
- **Script** shows it line by line: who says what, how, and over which sound — with the chapter's pictures where the prose has them.
- **Watch** plays what there is to watch of the chapter: its **finished video** — the file post-production cut (*A chapter's video* above), in the browser's own player, with the cut's subtitles as a track (off when the words are in the picture already) — or its **motion comic**, the panels following the voices as the page plays them. Where a chapter has both, a switch beside its title changes between them and the choice is kept on the device. A chapter with neither says so, and leads to where one is made. The video is made, cut again, downloaded and deleted under *Stage*; the viewer only shows it.

Under the prose and the script sits the **player** — whenever the chapter has an audio script — so a chapter is listened to on either face: press play, and the line being spoken is marked where it stands, by a tint that runs through it at the pace it is spoken (and holds when the voice is paused), and the page follows it. Pressing play over the prose turns to the script; *Turn to the script on play*, among the player's options, switches that off, and the prose stays, with the sentence being spoken marked in it and any sentence pressed to play from there. A chapter that ends goes on to the next. The sound notes of the chapter — the room, a door, the music — are shown beside the paragraphs they belong to, unless the reader switches them off.

**Reading settings** are one panel, opened from *Reading* in the reader's bar or from the player's own button, and the same panel stands under *Settings → Reading*: type size, paper, typeface and speed in sight; under *More*, whether play turns to the script, whether a chapter goes on to the next, the sound notes, the sound under the voice. They are kept on the device they were set on — a phone has its own, and so has whoever opens a published site.

Listening is for listening: the **production desk** of the audio version — make it, check and repair it, make its sounds, export it, see who was cast with which voice, and the tools on every line of the script to change a speaker, a delivery note, a take or a sound cue — comes with the *Produce* button in the reader's bar and goes with it; the choice is remembered. On the watch face the same button leads to the stage, where the comic is made.

### The album: the people and the world

The viewer (*View* in the Studio's navigation — what the book is to whoever reads it) has two halves beside the text: **People** and **World**. They are what a printed collection of settings would be, to be looked at rather than filled in:

- *People* lays everybody out by the weight of their part — the leads large — each with their picture where there is one. Somebody's page has the picture large (portrait, design sheet and the sheets of further looks to change between, each opening full size), who they are, how they look and are, where they come from, what they go through (the paragraph on their card, a strip of the chapters they are in, and the turns of their life chapter by chapter — each a way into that chapter), who they are to others, and what stands around them in the world.
- *World* lays the places, the houses and the things out by **how much of the story each carries**, wherever on the map it lies: what the story lives in first and large (*At the heart of the story*), then what it keeps coming back to (*Important*), then the rest — behind a fold where it is a long list of names, except what has a picture. So the garden half the book happens in is met on the first page although it is a part of a house that is a part of a city; a book with one country at the top of its map does not open on that one tile. Each tile says where the thing lies (*in …*), and a line above the places names the outermost ones, for whoever would rather walk in from the outside (`worldFront` in `shared/album.ts`). After them, the ideas of the world as cards of words. A place's, a house's or a thing's page has its design art large, what is written of it, the chapters that name it, and what stands around it by the ties — each to step into, with the way back above.
- **A place's picture is a scene.** Where a place (or a house) has design art and something stands in it, the picture is shown large with that marked on it — the places in it and the houses seated there first, then whoever lives there or belongs to it (with their face), up to twelve; each mark is a way in. The picture keeps its own shape; on a narrow screen it is moved sideways. The marks are laid out by themselves, the same every time (`shared/scene.ts`) — no model is asked where a courtyard is in a painting. The author may arrange them: *Arrange* at the scene's corner, then drag a mark to where the thing is in the picture; it is pinned there (kept with the place, as fractions of the picture's width and height: `spots` in the entry) for every reader. Pressed twice, a pinned mark goes back to being laid out by itself; *Let all go* does that for the whole picture.
- A slider chooses a chapter of the story on every page: what had not happened by then is not shown, and everybody says how they stand at that time. On another device and on a published site it also offers **where I am** — the chapter that reader last read — so that the people and the world can be looked at with nothing of what comes after.
- The album is **leafed through**: every person's and every entry's page ends with the page before and the page after it, in the order the first pages lay them out (the arrow keys do the same), and a page arrives softly — not at all for whoever asked their system for less motion.

One press leads from any page of the album to where that thing is edited (*Edit*, top right, where the reader has it for the chapter), and one press leads back (*View* on a person's, a place's, a house's and a thing's page). The pages a book is worked on have the same way over: *View* on a chapter's plan in the outline, on each chapter of the review (which opens it with what the review found marked in the text), and at the top right of *Stage* (the chapter to watch; from the interludes, the side stories).

The same album is what a phone on the network is served and what a published site shows — with this difference: a reader is given who and what the text **has come to**. Somebody with a card and no chapter yet is the author's plan, and so is a place nothing was set in; the author's own viewer shows those too. Ideas of the world are given whole. And of a card a reader is given what a collection of settings prints — names, a line of who they are, gender and age, appearance, personality, background, abilities, the paragraph of their life and its chapters, pictures, who they are to others. What somebody wants and lacks, the change planned for them, their secrets, how they are to be written, drawn and voiced, and the notes stay with the author; so does how an entry is to be drawn, and the notes on the ties.

### Side stories

An interlude is played with the models on the author's computer, so playing one is for the author (and for a device the book was made changeable from). An interlude **kept as a side story** (*Stage → Interludes → Keep as a side story*) is a finished text, and that is a reader's to read: the viewer has a fourth half, *Side stories*, wherever there is one — the list of them, and each as a transcript of how it went (the situation, the scenes, what was said and done, before the picture it was set before). What was of the playing — who the author played, what the director tracked, the choices that were offered — is not part of it. In the Studio, *Edit* on those pages leads to *Stage → Interludes*, where a side story is taken back by settling it otherwise.

### On another device

The phone button in the reader's bar switches on reading on other devices for the book: the Studio then serves a reader to phones and tablets on the same network — the chapters to read, their audio drama to listen to (with the sound notes beside the text), and their motion comic to watch.

- It is **off until you switch it on**, book by book, and stays on across restarts until you switch it off.
- A shared book is **read-only** unless you make it changeable. *Read only*: nothing can be changed from another device. *Read and change*: the chapters' text can be edited there — a version of the text as it was is kept before every save, and the change goes on the book's record (see *One road for every change*) — and the book's **interludes** can be played there, which calls the models set up on this computer, on your usage. In either mode the server reaches no key, no setting, and no book you did not share.
- The address carries a **random token**; whoever has the address can do what the book's mode allows. *New address* replaces the token, and every link given out before stops working.
- A **sealed book** asks every device for its password the first time. The device is then remembered by a grant of its own (a cookie holding a key that opens the book), listed under *Seal and lock*, where each can be withdrawn. A grant opens the book for devices even when it is locked on the computer — after the Harness was restarted, say — but **for devices only**: on the computer the book stays locked, to the Studio and to the showrunner alike, until you unlock it there. A book that only devices opened is locked again once none of them has asked for it for half an hour.
- It listens on port `4319` by default (`share.port`), on every network interface of the machine, over plain HTTP: what travels between the device and the computer — the text, and the password of a sealed book — is not encrypted on that stretch. On a network you do not trust, leave it off. The first time, the operating system may ask whether to allow incoming connections.
- The computer and the Harness must be running for the phone to read.
- **Where the book was last read is kept with the book** (its own state, sealed with it): the Studio's viewer and every device leave their place there as they come to a chapter, and the next to open the book is offered it — a phone's contents page says *Continue: chapter N* with where that was read (*in the Studio on the computer*, *on another device*), beside this device's own place; the Studio's shelf opens a book at the chapter read last anywhere. A read-only device may leave its place: it changes nothing of the book. A published site has nobody to leave a place with, and keeps it on the device.
- **On a tablet** the pages have room: upright, the contents page has the cover and the title large and a chapter is set in a column about thirty-three characters wide with a printed page's margins; on its side (and on any window that wide) the contents page is two columns — the book to the left, staying in place, what is in it to the right. **A phone on its side** gives the picture of a motion comic or a video the height there is, in its own shape. Nothing of this is another reader: the same pages, laid out by the room they find.
- **A story that goes more than one way** is read along a line of its plot. Where the book has lines beside the main one — not put aside, with a written chapter of their own — the contents page offers them to choose between (the choice is kept on the device), the chapter list is what is read along the line chosen, and at the end of the chapter where the story parts the other ways on are offered, each in the words of its choice. A chapter opened by a link is read along its own line. (`lines` beside `chapters` in what a book is answered with; `readAlong` in `shared/reader.ts`.)

| Field | Meaning |
|---|---|
| `share.enabled` | whether the reader for other devices is on |
| `share.books` | folders of the books that are shared |
| `share.edit` | folders of the shared books that may also be changed from another device |
| `share.port` | port to listen on (1024–65535, default 4319) |
| `share.token` | the secret part of the address; made the first time sharing is switched on |

The showrunner can do the same with `novel_share` (`mode`=read or edit); switching it on from the conversation asks you first.

### As a site of its own

The same dialog (*Show it to somebody*, the phone button in the reader's bar) has a second way out: **Publish as a site**. It writes a folder that any static host serves — GitHub Pages, Cloudflare Pages, a bucket, a server of your own — and that needs neither DSH nor this computer:

```
index.html                         the reader, the same page a phone gets
reader.js
data/books.json                    what the reader asks for, written out
data/<book>/book.json
data/<book>/chapters/<id>.json     text, script, storyboard of a chapter
data/<book>/album.json             the people and the world (see The album)
data/<book>/sides.json             the side stories, and data/<book>/sides/<id>.json each as a transcript
media/<book>/assets/…              the cover, pictures, voices and sound, the finished videos with their
                                   subtitles (assets/video/<chapter>.mp4, .vtt) — each under its own name
                                   (a voice the book keeps as .wav goes out as .m4a, see below)
site.json                          what this publication wrote, and what each pressed sound was made from
```

Only what a reader is given goes in: the text of the chapters that have any, the sound that plays, the pictures that are drawn, the cover, and the album of the people and the world as a reader is given it (*The album* above says what of a card that is). The outline, review notes, prompts, models and keys do not. The site is read-only — no editing, no interludes. The audio drama, the motion comic, the finished videos, the other lines of the plot, the album and the side stories can each be left out — the videos are the largest files a book has, and the dialog says what they weigh. A book published a part at a time (`chapters` of `site.publish`) has its album cut at the last chapter published: lives told up to it, ties that had begun by then, and nobody and no place the text has not come to by then.

The folder is one beside the book by default (`<title>-site`), or any path outside the book's own folder. Published into the same folder again, only what changed is written, and what the last publication wrote and this one does not is removed; files that were not published from here are never touched (a `CNAME`, a `robots.txt`). A sealed book is published **in the open**, and only after the author ticks that they know. To look at a site before uploading it, serve the folder (`npx serve`): a browser does not let `index.html` opened from disk read the data beside it. (`python3 -m http.server` shows it too, but answers no request for a part of a file — a video cannot be scrubbed, and an iPhone plays neither sound nor video from it; every real host does.)

**A part at a time.** *Publish as far as* takes the written chapters of the main line up to one chapter (`upto` of `site.publish`) — and the album with them, cut at that chapter. A part of the book is a part of its main line: the other lines of the plot go with the whole book only (*With the other lines of the plot*, ticked by default; `lines=false` keeps to the main line).

**Sound, smaller.** In the book a voice is kept as it was made — uncompressed WAV, so that it can be cut, joined and mixed again without loss. That is four times what a listener needs, so on the way out voices, ambience and effects are compressed: AAC in an MP4 file (`.m4a`), which every browser on every phone, tablet and computer plays, at a rate chosen for "sounds the same" rather than "as small as it goes" — four bits for each sample of each channel, 96 kbit/s for a voice at 24 kHz. Three chapters with their voices came to 25.9 MB in the book and 6.1 MB in the site. What is in the book is not touched; what the reader is told names the smaller file. Published again, only sound that changed is compressed again (`site.json` keeps what each file was made from). *Compress voices and sound* in the dialog is ticked by default; unticked — or `press=false` from the conversation — sound goes out as it lies in the book.

The work is ffmpeg's (its own AAC encoder, the same on every system). On a computer without ffmpeg the dialog says so beside the choice, the sound goes out as WAV, and the result says that it did — install ffmpeg (macOS: `brew install ffmpeg`; Windows: `winget install ffmpeg`; Linux: your distribution's package) and publish again to have it compressed. A sound ffmpeg cannot read is published as it is, and named in the result.

**Pictures, smaller.** A picture lies in the book as the image model made it: a PNG that loses nothing, two to three megabytes for one painted scene — most of it the grain of the paint — and after the sound was compressed, nine tenths of what a site weighed. On the way out a PNG becomes a JPEG (`.jpg`): the cover, the pictures a chapter's prose shows, the panels of the motion comic, portraits, design sheets, the art of places and things and of the turns of their course, a side story's backdrop. The setting is the encoder's finest, with colour kept for every pixel (no halving of it, which smears a red line on a pale wall) — again chosen for "looks the same": measured on the pictures of two books, 40 dB and more of the original, at a fifth to a tenth of the bytes. A book of eighty chapters with 108 pictures went from 273.7 MB of them to 47.2 MB. What is in the book is not touched; what the reader is told — and the line of a chapter's prose that shows a picture — names the smaller file. A picture that is see-through anywhere stays a PNG (a JPEG has no way to say so) and is counted in the result; one that carries a channel for it that says "solid" everywhere is compressed like any other. Pictures that are JPEG or WebP already go as they are. Published again, only pictures that changed are compressed again.

*Compress pictures to JPG* in the dialog is ticked by default; unticked — or `jpeg=false` from the conversation — pictures go out as they lie in the book, for whoever wants them without loss. It is ffmpeg's work as well: without it the dialog says so, the pictures go out as PNG, and the result says that they did.

**How it opens.** With *A visitor's first visit opens with my reading settings* ticked, the site is written with the publisher's own reading settings as they are at that moment — type size, paper, typeface, sound notes, whether play turns the page to the script, speed, volumes, going on to the next chapter (`<meta name="novel-defaults">` in `index.html`; only settings the reader knows, within what it allows). They are where a visitor starts; what a visitor changes is kept on their device and is theirs.

From the conversation: `novel_share action=on` shares on the network; `novel_share action=publish` writes the site (`out`, `upto`, `listen`/`watch`/`album`/`video`/`lines`=false, `press`=false to keep sound as WAV). A sealed book is published from the dialog only, where the author confirms that it goes out in the open.

## Motion comics: how finely to cut

A storyboard arranges the audio script into panels. How many is the author's call, set on the motion-comic screen and kept with the book (`storyboard` in `novel.json`):

| Density | A picture stays about | |
|---|---|---|
| `sparse` | 26 seconds | few pictures |
| `balanced` | 13 seconds | the default |
| `dense` | 6–7 seconds | many pictures |
| `auto` | — | the director decides where the picture should change, between one every 40 seconds and one every 4 |

`maxPanels` is a ceiling that holds whatever the density: when the director cuts more, the shortest neighbours are merged until it does. The screen shows what the choice comes to for the chapter before anything is drawn — every panel is a picture to pay for.

A panel may begin and end inside a long line, so half a minute of narration is not one frozen picture. A director that stops before the end of the chapter is asked for the rest; one that returns far fewer panels than asked for is told so once.

## The bookshelf

Each book on the shelf shows its cover: the picture chosen as cover (*Make it the cover* on any illustration), else the latest cover drawn. The overview has a button to paint one from the book's premise and art direction.

**Removing a book** (the bin on its shelf card, or the book menu) moves everything that is the book's own — `novel.json`, `outline.json`, `bible/`, `manuscript/`, `assets/`, `export/`, `.novel/` — into one folder in the system trash, from where it can be put back by moving those entries to a folder again. Nothing is erased. Anything else in the book's folder is yours and stays where it is; the folder itself is removed only when it is left empty and is not a Harness workspace. Where the system trash cannot be reached, the folder goes to `<Harness home>/novel-writer/removed/` and you are told the path. The showrunner can remove a book only when asked to, and you confirm it.

**Removing a chapter** (the bin on its row in either chapter list, *Choose several* on the outline page for more than one, or the chapter's menu) takes it out of the book and keeps it: its plan, where it stood and its text go under *Recently removed* at the foot of the outline's chapter list, and *Put back* returns it to its place. What was made from it — digest, review, voices, pictures, video — is not touched by the removal and is the chapter's again when it comes back. Its number is not given to another chapter.

**A plan's blanks.** A chapter that arrived written (an imported one above all) has no plan beyond its title. When a chapter is digested, what its plan leaves empty — a line of synopsis, place, time, who is in it, which threads it touches — is filled from the digest; a field with anything in it is left alone. For a book digested before this, the outline page offers *Fill from the digests*. The chapter's page shows the people and threads of the chapter only: those of the plan, those the digest found beyond it (to add with a click), and a picker for anyone else.

## When the plugin is updated while DSH runs

DSH puts the new Studio in the window at once; the Studio's Host half is still the one that was running. The Studio says so in a banner at its top, with a **Restart** button: it replaces the Studio's own Host half with the installed one — DSH and its conversations stay as they are, and the Studio stays on the same book and page. Jobs that are running are stopped (what they finished is kept) and sealed books that were unlocked lock again, as they would when DSH restarts; the button asks first when a job is running. If the installed Host half cannot be loaded, the running one stays and the banner asks for a restart of DSH instead. A Host half from before this feature has no such button: DSH has to be restarted once.

## One road for every change

A book is plain files, and everything that is known about it — versions of each chapter, the memory digested from the text, the search index — has to follow the files. So every change takes the same road, whoever makes it:

- **The showrunner** changes the book only through its `novel_*` tools. Prose that has to be written is briefed to the writer (`novel_write`, `novel_revise`); what is not writing — the words you dictated or pasted, a name, a slip of fact, a line you want gone — it changes exactly, with its own hands (`novel_edit`: replace, insert, append, delete, set). What the book remembers wrongly it corrects (`novel_memory`). Each of these keeps the text as it was as a version, digests the chapter's memory again, and tells the showrunner what to check next: the cards of the characters the change names, the chapters that come after.
- **Raw file tools** (`write`, `edit`, a shell redirect) aimed at a book's own files — `manuscript/`, `bible/`, `outline.json`, `novel.json`, `.novel/` — leave all of that out of step. `agentFiles` says what happens when the showrunner reaches for them: `guide` (default) refuses and names the tool to use; `ask` puts the question to you each time; `allow` lets it through. Reading the files is never stopped.
- **Files changed outside the Studio** — your own editor, a script, a file tool that was let through — are noticed. The change goes on the record, the chapter's memory is digested again (when automatic digest is on), and the showrunner is told in its context that it happened. No version of the earlier text exists in this case: the Studio only sees the file after it changed.
- **The record** on the overview lists what changed the book that you did not do by hand on the panel: the showrunner's tool calls, edits from another device, changes from outside. A manuscript edit is undone from there with one press (the text in place is kept as a version first).

With *agent revisions wait for review* switched on, the showrunner's exact edits are left as proposals like its revisions.

## Sealed books

A book can be **sealed** (the book menu → *Seal and lock*): every file of it is then encrypted where it lies — manuscript, bible, outline, memory, versions, pictures, audio, exports, the search index — with AES-256-GCM under a key of the book's own. File names are encrypted too; folders keep their names. What stays readable is `novel.json`, which for a sealed book holds only an id, the name the shelf shows while the book is locked (yours to choose, so the title can be hidden as well), and the book's key wrapped once per way of opening it.

- **Unlocking.** With the book's **password** (the key is derived with scrypt), or with **this computer's own unlock**: the system asks for a fingerprint or the computer's password, and only on a yes is a secret taken from the account's credential store that unwraps the book's key. On macOS that is Touch ID, falling back to the Mac's password, and the login keychain; the system's prompt names `osascript` as the one asking, because the Studio asks through the Mac's own script host instead of shipping a program of its own. On Windows it is Windows Hello and DPAPI, asked through PowerShell — written from the platform's documentation and not yet run on a Windows machine; where it does not work the password does. Elsewhere (Linux) a book opens with its password only.
- **While it is open** the book behaves like any other. Its key is held in memory by the Harness and nowhere else. **Locking** (the same dialog, or `novel_manage action=lock_book` from the conversation) forgets the key; quitting the Harness does too. Locking is about this computer: a device that was let in can still read by its grant (see *On another device*) — withdraw the grant, or stop sharing the book, to shut it out.
- **While it is locked** nothing of it can be read: not by the Studio, not by the showrunner — which is told that its book is locked and that it must not rely on what it remembers of it — not by the reader for other devices. The showrunner cannot unlock, seal or unseal a book, and never asks for a password; passwords are typed on the Studio's lock screen only.
- **There is no back door.** Without the password, and without the computer's unlock where that was set up, a sealed book cannot be opened. Keep the password somewhere else as well.
- **Sealing and unsealing can be interrupted.** They work file by file; a crash or a power cut in the middle is finished the next time the book is unlocked.

What sealing does not do: it does not erase plain copies that existed before — in free disk space, in backups, in a sync service's history; it does not change what is sent to model services, which read what they are given as before; it does not reach the Harness's own records of your conversations, where whatever the showrunner read or quoted of the book stays in the clear; and an export, though stored sealed, is plain once you download it. The usage ledger, which is kept outside the book, enters a sealed book under its shelf name. Pictures drawn through the Codex CLI pass their reference images through a temporary folder for the length of the call.

## What is being worked on

Anything that takes a moment says so. A button that started work shows a spinner and what it is doing until the work ends, and cannot be pressed twice; a bar at the foot of the Studio lists everything in progress for the book — requests still waiting for an answer and running jobs, with what each is doing, for how long, and a way to stop it — whichever screen you are on, and whoever started it. While a model reasons before it answers, what it thinks can be read as it thinks it: above the prose on the write page, and behind the eye button on any job in that bar — the chain of thought where the model shows it, the summary of it where the model gives only that.

## What is not set up

Starting something that needs images or speech before they are configured does not fail quietly. The Studio says what is missing and offers two ways on: the one-click setup, and the settings opened at the section in question. The same happens when a job fails for a missing key or sign-in — including jobs nobody was waiting on.

## Usage and cost

Every call the Studio makes to a model is written to a ledger: tokens in and out for text (per role), pictures drawn, seconds and characters of speech, what was embedded — with the model, the book and the kind of job. *Settings → Usage and cost* (also *Overview → Usage*, and `novel_settings action=usage` in the conversation) adds it up by model, role, book and day for today, 7 days, 30 days or all time, for one book or all of them.

The ledger counts; it does not know prices. Enter what you pay for a model — per million input and output tokens, per picture, per minute of speech or per 10,000 characters, in your own currency — and its past and future usage is costed. A model without a price is counted and reported as unpriced; nothing is guessed. Prices live in the settings:

```yaml
prices:
  qwen3.8-max: { input: 2.4, output: 9.6, currency: "¥" }
  qwen-image-3.0: { image: 0.2, currency: "¥" }
  qwen-audio-3.1-tts-next: { minute: 0.5, currency: "¥" }
```

(The figures are placeholders — use your bill.) Amounts in different currencies are shown side by side, never added.

Two limits to know: token counts marked ≈ were estimated from the length of the text because the endpoint reported none; and the showrunner's own turns in the conversation are run and counted by the Harness, so they are not in this ledger. The ledger is kept under the Harness home in `novel-writer/usage/`, one JSON-lines file a month.

## Semantic retrieval (optional)

| Field | Meaning |
|---|---|
| `embedding.provider` | `none` or `openai` (any endpoint with an OpenAI-style `POST <baseURL>/embeddings` — Bailian, OpenRouter and OpenAI all qualify) |
| `embedding.baseURL` | e.g. `https://dashscope.aliyuncs.com/compatible-mode/v1`, `https://openrouter.ai/api/v1` |
| `embedding.model` | e.g. `qwen3.7-text-embedding-flash`, `qwen/qwen3-embedding-8b`, `text-embedding-3-small` |
| `embedding.dimensions` | optional output size |
| `embedding.apiKeyRef` | read the key from this variable instead of the saved one |

Without embeddings retrieval is keyword-based (BM25 over CJK bigrams and Latin words). With them, both rankings are fused. Vectors are computed lazily and cached in the book's `.novel/index/`; changing the endpoint, model or dimensions starts a new cache.

## A complete example: Aliyun Bailian

What the one-click setup writes; the key is in the credential store, not here. Text roles are absent: they follow the conversation's model until you choose one of DSH's for them.

```json
{
  "models": {},
  "embedding": { "provider": "openai", "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1", "model": "qwen3.7-text-embedding-flash" },
  "image":     { "provider": "dashscope", "baseURL": "https://dashscope.aliyuncs.com", "model": "qwen-image-3.0", "size": "1280x720" },
  "tts":       { "provider": "qwen-audiogen", "baseURL": "https://dashscope.aliyuncs.com", "model": "qwen-audio-3.1-tts-next" }
}
```

A workspace domain (`https://ws-xxxx.cn-beijing.maas.aliyuncs.com`) works the same way: give it as the service address in the one-click card, or replace the hosts above. Any endpoint URL of that domain can be pasted — the Studio takes the host from it.

To write with Bailian's text models as well, add Bailian as a provider in DSH (*Settings → Models*), then pick its models under *Models*.
