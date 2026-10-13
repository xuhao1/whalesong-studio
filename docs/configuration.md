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

**Advanced**, a switch at the top right that stays as it was left, brings the rest: a block per role with everything about that role in one place — its model, reasoning level, temperature and output cap, and, for a role of the crew, what it may do (the same three-way choice, for that role alone) and how many steps a run gets; how many requests go out at once; the context budgets (`context.budgetTokens`, `context.sideTokens`, `context.playTokens`, `context.passageTokens`, `context.chapterTokens`, `context.tailChars`); the shape of each kind of picture and how many reference images a picture carries. A link that leads to a part of the page ("speech is not set up") opens that part, Advanced included, whatever was folded.

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
| `director` | 导演 Director | audio scripts, storyboards, a character's appearance, the frame of a moment, illustration prompts, interlude turns | writer → analyst → conversation model | 0.9 |
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

### Pictures to go by, and the model that looks at them

A plan of chapters to come and the writing of a chapter can be given a few pictures — a moment the author sees, a face, a place, a mood. They are pictures of the book: ones it already has, or ones brought in for this (kept under `assets/guides/`). Those given to a chapter stay on its plan (`guides`), so every pass at it goes by them; those given to a derivation go to the planner, and the chapter that goes by a picture keeps it. A what-if, a revision of the whole book and the rewriting of a selected passage take pictures the same way, for that one piece of work: every branch of the what-if counts them in; the planner that scopes a revision sees them, and so does each chapter it rewrites; a passage goes by the pictures given for that rewrite, not by the chapter's. A whole chapter rewritten to mend what a review found goes by the pictures kept with the chapter. Whoever looked at them is said with the result — on the what-if, on each proposal, in the revision's summary. The showrunner passes them as `pictures` on `novel_derive` (`kind=what_if` too), `novel_write` and `novel_revise`.

Who looks at them is decided by what DSH says of the model doing the work (`inputModalities` of the model, from its provider's adapter):

| The working model… | What happens |
|---|---|
| says it takes pictures | the pictures go to it with the task, the way DSH sends pictures (its attachment service, the provider's adapter) |
| says it takes none | the model set as `vision` looks at each picture once and says in words what it shows; the words go into the task. Without `vision` the work is refused before it starts, and says why |
| does not say | `vision` looks, where one is set; otherwise the pictures are sent all the same, and the result says that the model does not say whether it sees them |

`vision` is a route of DSH's like a role's (`{ "provider": "…", "model": "…" }`), Studio-wide or a book's own (`novel.json`). It is not a role: it has no fallback — unset means none. What it wrote of a picture is kept with the book (`.novel/guide-notes.json`) and not asked for twice. The settings page lists a provider's models with those that say they take pictures first, and says beside the row what the writer's and the planner's own models say of themselves.

## References: the books a book goes by

A book may go by other books — their world, their settings, their style, their plot, their very wording — and say how (*Bible → References*). Two kinds:

- **A book of the shelf**, consulted as it is organised there: its bible, its outline and chapter digests, its styles, its text. What of it is open is chosen per reference (`world`, `characters`, `style`, `plot`, `text`; all of it where nothing is chosen).
- **A manuscript taken in for this book alone**, as plain text: read and searched, nothing more. To have a manuscript organised first — people, world, style, plot — import it as a book of the shelf and take that as the reference; the page says so and links there.

Each reference carries a line of the author's on **how to go by it** ("only its cadence, none of its people"; "the rules of the trade: quote them"). Nothing of a reference is put into a task whole. The crew — planner, script supervisor, director — is given two tools, `reference_read` and `reference_search`, kept to what each reference has open, with the author's line beside each, and reads in them as the work asks. The writer writes in one request and has no tools: **before a chapter is written the planner reads the references for it** (as an agent) and leaves notes on the chapter's plan — what to keep to, what may be borrowed, what to stay clear of, with the source of each — which the writer is handed, and which the author reads and corrects there. *Have the planner read the references* on a chapter's plan does it on demand.

Above the list, the page has one field for **what is asked of the references at large** — which book for the world, which for the way of writing, whether people or events may be borrowed. It is the author's own words, kept with the book, and is said to everybody who works with the references at hand (the crew's rules, the planner's note-taking, and — with the notes — the writer); what is said of one reference still holds for that one, and wins where the two are at odds.

Under it, three switches say which work **looks in the references first**: *Writing* (the planner's notes before a chapter is written), *Deriving* (chapters, beats, a what-if) and *Reviewing*. All three are on. A derivation or a review that looks first is told to, is sent back if it hands in without having read or searched in a reference, and says in its result what it read — *Looked in the references first: …* under the result; a review also files what is at odds with the references as issues. Turned off, a kind of work looks only where the role sees a use. A role set to plain calls has no tools to look with: the work is done all the same, and the result says the references were not looked at. The showrunner has all of it as `novel_reference` (list, read, search, add, update, remove, consult, and settings: `guide`, `before_writing`, `before_deriving`, `before_reviewing`).

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
| `context.passageTokens` | `24000` | what a selected passage is rewritten with, beside its own chapter around it (4,000 characters before, 2,000 after): the bible, the people, the story around the chapter — the nearest chapters word for word as far as they fit, the rest in outline. A paragraph changed to an instruction is not a chapter written: handed the whole window, the instruction was one line after hundreds of thousands of tokens and the passage came back hardly touched |
| `context.plannerWholeTokens` | `32000` | how small a line of the plot (its text, cards and entries, in tokens) lies whole before the planner preparing a writer's material, so that it prepares in one request; `0`: it always reads for itself, as an agent |
| `context.chapterTokens` | `60000` | what a chapter is revised with — gone through and changed where it stands, or written over whole to an instruction — beside the chapter itself, which always goes whole: the bible, the people, and the chapters next to it word for word as far as they fit (about two before and two after, at 7,000 characters a chapter), the rest in outline. Revising a chapter is not writing the book on: handed half the window, either request carried nearly a whole 80-chapter book (436K tokens counted), and the one that works as an agent sent that again with every step. Per book too. |
| `autoDigest` | `true` | digest a chapter right after it is written or a revision is applied. Off: nothing digests by itself — memory, lives, threads and the list of walk-ons wait for *Digest* on the overview or the writing page; a chapter not digested is known to later writing by its outline and by what of its text fits the window; a run of chapters starts with its digest step unticked (it is a step like the others, in rounds too); and the showrunner is told the saving is the author's, not a step to make up for |
| `plansFollow` | `false` | `true`: once a chapter that was digested before is changed — a proposal accepted, the chapter written anew, an edit — its plan (synopsis, place, time, point of view, cast and beats) is read against the text and set by it by itself, a moment later; the plan as it was stays in its history. Off — the default — a plan is set by its text only where the author asks (*Update the plan from the text*): the plan is their design, and text a model wrote does not become it unasked. (`planFollowsText`, which this replaces, is read no more.) |
| `siftCast` | `true` | after digests, have the planner look through the names that have no card yet and say who is worth one (a suggestion), who is somebody under another name, and who is a walk-on |
| `settleSuggestions` | `true` | what digests suggest for the bible is settled by the planner and entered; off, each suggestion waits for the author |
| `reviewMends` | `true` | once a chapter (or a batch of chapters) is reviewed, its open issues go to the planner together and every change waits as a proposal beneath its issue — one mending more per review; `false`: a review lists what it found and nothing changes until asked |
| `recheckIssues` | `true` | after a proposal is accepted, have the reviewer read the issues still open in what changed against the new text |
| `mendBy` | `planner` | who writes the words of a change made by places — an issue mended, something the author noticed put right, a revision through the book, a chapter revised in place. `planner` (also where nothing is set): the crew's model hands in what each place is to read, and that is the proposal. `writer`: the planner settles the places and the writer's model rewrites each. On the first page of the settings (*Who writes a change made by places*), and in the small menu beside the buttons that mend |
| `rewriteBy` | `writer` | who rewrites a selected passage (polish, expand, tighten, to an instruction) and writes a chapter over whole — also the chapters a mending says cannot be mended by places. `writer`: the writer's model. `planner`: the crew's model, for a writer's model that does not rewrite to an instruction well. Drafting and continuing are the writer's either way. On the first page of the settings (*Who rewrites a passage or a whole chapter*), in the small menu beside *Rewrite as…* on the writing page and beside the buttons that mend |
| `materialBy` | `rules` | who puts together what a writer is handed for a piece of writing the author asks for (a chapter, a chapter gone on with, a passage rewritten, a chapter written over): `rules` — packed by the Studio's standing rules, nobody looking first; `planner` — the planner looks at the piece first and chooses. A book may have its own in its `novel.json` (`materialBy`; the settings page, *This book*), which holds for it in place of this; what is picked on the writing page for that page comes before both. (A settings file from before `rules` was what held where nothing is set, in which every save of the page had written `planner`, is read as saying nothing: pick the planner again to have it.) Switched from the writing page too; a comparison of drafts can write by both `agent`: for a chapter written or gone on with, nobody prepares anything — the writer works as an agent: it reads in the book for itself (`book_read`, `book_search`), hands the text in with a tool and goes over what it handed in — a place changed, the whole of it handed in again — as often as it sees fit, before it calls the work done. Its model has to be one of DSH's, which can run as an agent; where it cannot, or the run hands nothing in, the chapter is written in one request from prepared material and the result says so. A passage rewritten and a chapter written over keep the planner's material |
| `mendReach` | `bold` | how far a revision reaches — an issue mended, a sentence of the author's carried out under Review and revision. `bold` (also where nothing is set): mended through — every place the problem shows, what has to change with each, a place taking in a whole paragraph where a sentence will not do, a short passage written new where it takes one; an issue mended at its quote hands over the paragraph the quote stands in. `careful`: the least change — one place where one will do, the sentence or two that have to change. On the first page of the settings (*How far a change goes*), in the small menu beside the buttons that mend, in an issue card's menu and under the triangle beside *Mend the chapter*. |
| `partBeats` | `3` | a chapter whose plan has beats is written in parts where the writer writes in one request (`materialBy` `planner` or `rules`): at most this many beats to a part, a request a part — the same material and the text so far each time, each part told which beats are its own and, but for the last, not to close the chapter — whatever length is asked for, or none. Every beat gets its room, and the chapter comes out longer than one written in one go. `0`: never in parts — a chapter is written in one go whatever length is asked for; where a great length is asked for the model may fall short of it, and that is said |
| `callsMb` | `200` | megabytes of the record of calls a book keeps — every call to a text model with all that was sent and said, in the book under `.novel/calls/` (see below). When it is full the oldest calls go first; `0` keeps none. Never more than 3,000 calls, whatever their size |
| `reviewAgentRevisions` | `false` | when on, revisions requested by the showrunner wait as proposals instead of applying |

The six that can follow by themselves once text is written, changed or reviewed — `autoDigest`, `siftCast`, `settleSuggestions`, `plansFollow` (off unless switched on), `reviewMends`, `recheckIssues` — stand together on the first page of the settings, under *Done by itself*: each is model calls nobody pressed a button for. (Of them the planner's look through new names is the dear one: it is an agent that looks things up in the book.)

**What a call was given, afterwards.** Every call the Studio makes to a text model for a book is kept with all of it: the rules of the role, what opened the request (the book and the story so far), the request itself (the material of this piece and what was asked last), the reply as it came back, the model with its reasoning level, temperature and output limit, the tokens the provider counted, how long it took and how it ended. *Calls* in the panel beside a chapter lists that chapter's; *Jobs* and *Usage* open the whole book's. A row pressed is the call read whole; two ticked are read against each other — how each was set, and part by part whether they were the same to the letter or what differs — which is how two drafts that came out unlike each other are told apart: by what each was sent, by the temperature, or by neither (the same request answered twice is two different texts at the writer's temperature of 0.85). What a role does step by step as an agent is not in this record — that run is a conversation of its own, opened from its job. The record lies in the book (`.novel/calls/`), sealed with a sealed book; `callsMb` says how much of it is kept.

**What a call is given.** The story before a chapter comes in two layers: the chapters nearest to it, whole and verbatim, within the budget above; and one line per chapter for everything older. Beside that, at most 22 % of the window (120,000 tokens at most) goes to the bible, threads, lore and retrieved passages, and about 12 % is kept free for the instructions and the reply. When a chapter in the middle of the book is rewritten or revised, the chapters written after it are given too — nearest first, at least three tenths of the text budget. *Settings → Context* shows the figures that apply to each role's model as it is set up now.

**Where the window comes from.** In this order: the role's own `contextWindow`, DSH (for its models), the endpoint (OpenRouter publishes one per model), and the table of model families in the recommendations (`windows` in `recommended.json`; at the time of writing the Qwen 3.5+, DeepSeek V4, Kimi K3, GPT-6, Claude 5 and Gemini 3 families are taken as one million). A model nobody can place is assumed to read 200,000 tokens — set `contextWindow` on its role when it reads more.

**Built for the provider's cache.** The part of a request that does not depend on the chapter — book, world, cast, the outline of what came before, the text — is sent first and as a block of its own, and grows only at its end from one chapter to the next. The window does not slide by a chapter each time: it keeps its starting chapter until the text no longer fits, then lets go of the oldest quarter at once. A provider that caches prefixes (DeepSeek, Bailian, OpenAI, Anthropic and Gemini all do, each in its way) therefore re-reads most of every request from its cache; what it reports as cached is in the usage ledger, priced with the `cached` price when you have entered one.

Settings files saved by earlier versions carry budgets nobody chose (48,000, later 500,000). They are dropped once, when the file is first read by this version (`revision` in the file records that it happened); a budget set afterwards is kept whatever its value.

**Chapter length.** There is no setting for it. A chapter's recommended length is in its plan, a book's default in the book (*Overview → book details*, or `chapterBudget` in `novel.json`); with neither, the writer judges from the plan and from how long the book's chapters run.

## Images (optional)

| Field | Meaning |
|---|---|
| `image.provider` | `none`; `openrouter` (`POST <baseURL>/images`); `openai` (`POST <baseURL>/images/generations`); `dashscope` (Bailian's native API: Qwen-Image, Wan, Z-Image); `codex` (a ChatGPT subscription); `comfyui` and `diffusers` (models on this machine — see *Images from a model on this machine*) |
| `image.baseURL` | `openrouter`, `openai`: the `/v1` base. `dashscope`: only the origin matters (`https://dashscope.aliyuncs.com` or a workspace domain). `codex`: unused |
| `image.model` | e.g. `openai/gpt-image-2.5-sunburst`, `gpt-image-2`, `qwen-image-3.0`, `z-image-turbo` |
| `image.size` | default `WIDTHxHEIGHT`; panels and interlude backgrounds ask for 1280x720, portraits for 1024x1024 |
| `image.quality` | `openrouter`, `openai`: `low`, `medium`, `high`; omitted = the model's default. Not sent to a server of your own |
| `image.promptTokens` | how many tokens of a prompt the image model reads — what lies beyond, it never sees. Unset: what the endpoint itself says of its model where it says (a server of your own: `limits.max_prompt_tokens` in its model list); else no limit. See *A prompt that fits the model* |
| `image.promptWrite` | who writes the prompt that is sent: `fit` (the default) — the brief the Studio lays out goes as it is, and the director writes it again only where it comes to more than the model reads; `always` — the director writes every brief out as a prompt first (one plain call a picture); `never` — the brief goes as it is, whatever its length |
| `image.promptCompact` | the older switch: `false` reads as `promptWrite: never` |
| `image.promptLang` | `en`: briefs are laid out under English headings, and what the director writes is English throughout — for a model that reads English alone. Unset: the language of the book |
| `image.looks` | `pictured` (the default): somebody whose picture goes along with the prompt is pointed to there ("see Image 1") instead of being described again — a look restated beside a moment in other clothes pulls the picture back to the look; `always`: looks are written out whether a picture goes or not. A book may have its own |
| `image.local` | `openai` only: `true` — the endpoint is a server of your own, asked the way such a server wants to be (see *An OpenAI-compatible server of your own*); `false` — it is not, whatever its address. Unset: judged by the address (this machine, a private network), unless the model is one of OpenAI's |
| `image.sizes` | `openai` only: the sizes the endpoint draws, e.g. `["768x768", "768x512", "512x768"]`; a picture is asked for at whichever is nearest in shape. Unset: for a server of your own, what the server itself says its model draws (see below) or else those three; GPT Image's own three for GPT Image; and for anything else the size wanted as it is |
| `image.bridge` | `codex` only: `auto` (default), `connect` or `cli` — see below |
| `image.workflow`, `image.editWorkflow` | `comfyui` only: the workflow to run, and the one for pictures with reference pictures — each the path of a file exported in API format, or the JSON itself |
| `image.python`, `image.device`, `image.dtype` | `diffusers` only: the Python to run (`python3`), the device (`cuda`, `mps`, `cpu`; the best there is when left out) and the precision (`float16` on CUDA, `float32` elsewhere) |
| `image.steps`, `image.guidance` | `comfyui`, `diffusers`: sampling steps and guidance scale; left out: for the built-in ComfyUI graph, what the server's own latest run of that model used (else 25 steps, and guidance 7 for a checkpoint, 3.5 for a diffusion model that comes alone); for Diffusers, the pipeline's own |
| `image.stylePrompt` | *legacy*: a Studio-wide art direction from before the look became each book's own. Still what a book without one starts from; no longer offered in the settings, which show it — with a way to clear it — while it is set. See *How a book keeps one look* below |
| `image.resolution` | how fine pictures are drawn: `720p`, `1080p`, `2k` or `4k` — as many pixels as a screen of that name, in each picture's own shape. Unset: each kind of picture at its usual size |
| `image.aspects` | the shape of each kind of picture — `cover`, `portrait`, `sheet`, `location`, `scene`, `panel` — as an aspect (`1:1`, `3:4`, `4:3`, `16:9`, `9:16`, `3:2`, `2:3`) or exact pixels (`1600x900`). Unset: a cover stands (2:3), a stage lies (16:9), a portrait is square, a design sheet 3:2 |
| `image.negativePrompt` | what no picture of any book may show; each book adds its own list |
| `image.lead` | which of a person's two pictures the other is drawn against: `sheet` (the default — words → design sheet → portrait and everything else), `portrait` (words → portrait → sheet → the rest: a portrait is drawn from the words alone, and a missing sheet after it, against it), `none` (nothing is drawn for another picture's sake). A person's page has the same choice per picture (*the portrait from…*, *the sheet from…*), which starts as this has it |
| `image.sheetFirst` | the older switch: `false` reads as `image.lead: none` where `lead` is not set |
| `image.portraits` | what a portrait asked for with nothing said of it is: `both` (the default) — two pictures, a plain likeness and the person in their signature scene; `scene` — the scene alone; `plain` — the likeness alone. A book may have its own; a person's page offers each for one picture |
| `image.portraitScene` | the older switch: `false` reads as `portraits: plain` where `portraits` is not set |
| `image.apiKeyRef` | read the key from this variable instead of the saved one |

How sizes travel: OpenRouter gets what the model in use takes (see *What OpenRouter's image models take* below) — a shape, and a fineness where the model has one to choose; GPT Image models on an OpenAI endpoint get the nearest of their three classic sizes; other models get the size as written; a subscription gets the framing in words, because its endpoint takes a prompt and nothing else.

Generated images are downloaded into the book (`assets/images/`), so a book never depends on an expiring URL.

**A prompt that fits the model.** An image model's text encoder reads so many tokens and no more; a prompt that is longer is not refused — its end is simply not read. The Studio's prompts end with what keeps a book's pictures alike (the art direction) and what to keep out, so a model that reads little would lose exactly that. Where a limit is known — `image.promptTokens`, or what a server of your own says of its model — a prompt that comes to more is **written again by the director** before the picture is drawn: the same picture in fewer words, what it shows first, then how each person in it looks, then the art direction; what to keep out is worked in by saying what is there instead (and named last, briefly, where it has to be named, on a way of drawing that has no field for it); talk of reference pictures goes where none are sent. What the director hands in is measured and handed back if it is over; if every try is over, its nearest try is used with its end — the least of it, by the order it was written in — left off; if the director cannot be had at all, the prompt goes as it was. Each of these is said in the picture's record (`sent.compact`: about how many tokens before and after, against what limit), beside the prompt as the Studio composed it and the one that was sent. A prompt fitted once is kept: the same picture drawn again is not written again.

Tokens here are the Studio's estimate — it has no model's tokenizer: every Chinese character and Chinese punctuation mark counts one, everything else one to 3.6 characters — and a prompt is held to nine tenths of the limit, so that one a little over by the model's own count does not lose its end unnoticed. Fitting a prompt is one piece of work for the director's model per picture (some seconds to a minute or two, by the model and how much it reasons); `image.promptWrite = never` sends prompts as they are.

**What OpenRouter's image models take.** The models behind `POST /images` do not take the same request. Of the 59 listed on 2026-10-09, 23 have a fineness to choose (`resolution`) and no two families the same tiers — Gemini `512, 1K, 2K, 4K`, Seedream `1K, 2K`, FLUX `768, 1K, 1.5K, 2K, 4K` — while 36, GPT Image among them, have none and take a shape alone; shapes (`aspect_ratio`) run from five to eighteen; nine know a `quality`, fourteen an `output_format`; and they hold one reference picture, or four, or sixteen. Sent a value it does not have, a model refuses the request (*No provider for … supports the requested parameter(s) … resolution: not supported. Accepted: 512, 1K, 2K, 4K* — Gemini asked for `1.5K`); sent a parameter it does not take at all, some pass it over unread (GPT Image and MAI draw on, at their own size) — which is no reason to send it. So the Studio asks: OpenRouter lists what every image model takes (`GET /images/models`, read once in half an hour), and a picture is asked for with those parameters only, each at a value the model has —

- the **shape** nearest to the size wanted, of the shapes the model has;
- the **fineness** the size asks for where the model has it (`512` up to 640 pixels a side, `768`, `1K` up to 1300, `1.5K`, `2K` up to 3000, `4K`), else the one it has that is nearest in pixel count, the lesser of two equally near — a design sheet (1536×1024) is drawn at `1K` on Gemini, a 1080p frame at `2K`; no fineness at all for a model that has none to choose;
- `image.quality` only where the model knows that quality; `output_format: png` only where it has formats to choose from (the others answer in the one they have — Seedream in JPEG — and the picture is kept as it comes);
- as many reference pictures as the model holds; the picture's record says how many went.

The listing speaks for the model, and the providers an account may use can take less (an account that allows only zero-retention providers is left one provider of Gemini 3 Pro, and that one stops at `2K`). What a refusal says is taken — *Accepted: 1K, 2K* — is asked for next, twice at most; a refusal costs nothing, and what was learnt is kept for the pictures after it. A model the listing does not know, and any model while the listing cannot be had, is asked for what most models take and learns the same way. Where an account's privacy settings leave a model no provider at all (`404`: *0 endpoints … matching your guardrail restrictions and data policy*), no request can be shaped to pass: the message says so, with where the setting is (openrouter.ai/settings/privacy).

### A character's life

A card carries no status — no *active*, *offstage* or *dead*. (Cards written by earlier versions have a `status:` line in their front matter; it is no longer read, and is left out the next time the card is saved.) Where somebody is in the book is their **life on the page**, which nobody sets: it is read off the chapter digests along a line of the plot — the chapters they are in, where they come on, return, leave or die, and what each digest noted of them. A person's page says it in a line under their name and shows it chapter by chapter; *Tell it in a paragraph* has continuity write that life out (kept as `life` on the card, and the author's to edit). *People → Lives* is everyone's life in one table: a row a person, a column a chapter of the line — on the page, coming on or back, leaving, dying, planned by the outline, planned but missing. A book with more than one line of the plot offers the line to read along; a chapter that was not digested is a chapter nothing is known of, and is shown as such. A death or a leaving that is missing or wrong is the digest's to put right: digest the chapter again — or **write a mark** yourself. *Write a mark* on a person's page puts down that they come on, come back, leave the story or die at a chapter of the line, or were dead or gone before the story begins; a few words say what happened. A mark holds over what the digest says of that chapter, on every line of the plot the chapter is read on; one mark a chapter; it is shown as yours on the strip, in the table and in the chapter notes, and can be changed or taken back. After a death or a leaving of yours, later chapters that have the person only remember them — a *return* of yours brings them back. Marks are kept on the card (`lifeMarks`). The showrunner writes one with `novel_bible action=mark_life`.

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
- **Appearance** — a character's `appearance`: one paragraph of prose in the book's language, of what can be seen — the age they seem, build, face, hair as a shape, what they usually wear by cut and material, what they carry. The writer writes them by it and every picture of them is drawn by it; there is no second text for image models. *Have the director write it* on the card (or `novel_bible action=derive_visual`) writes or rewrites it; drawing someone whose card says nothing of their looks writes it first. A card of an earlier version may still keep a *visual anchor* (`visual.prompt`): pictures go by it until it is folded into the appearance (*Fold into the appearance* on the card; *Fold the old visual anchors in* above the list does every card) or the author rewrites the appearance or drops it. The director writes it **with the art direction in hand**: where the art direction fixes a period or a form of dress ("dress and buildings of the Ming"), hair and clothing are written in that form — how the hair is bound, the cut of the clothes, with the period named — over what the card and the source text say, and without blending the two; what is the person's own (colours, patterns, materials, what they carry) is kept and put onto the new cut, and the forms most likely to creep in go onto their never-drawn list. The same holds for the look of a place or a thing, and for ideas sorted into an anchor (there the author's own word, said now, holds over the art direction). On a character who has an anchor the button reads *Have the director rewrite*: the appearance is written again and keeps what nothing speaks against. **An appearance already written does not follow a changed art direction by itself** — the art direction comes last in a prompt and cannot overrule an anchor that says otherwise. *Bible → Art* lists whose looks are written down; after changing a period or a form, rewrite the ones it touches and draw their sheets again.
- **Design sheets** — front, side and back of a character on one sheet (`visual.sheet`). Every later picture of them is drawn with the sheet as a reference image. The sheet itself is drawn **from the words alone** — the appearance, the art direction, what is asked of this one — and never against an older picture of the person: drawn again it is a new picture, not the old one handed back. (An image model that is given a reference and told to match it returns the reference; a sheet drawn again against the sheet before could never change, whatever the appearance or the art direction said by then.) So the way to change how somebody looks is to change their appearance and draw the sheet again; the portrait, which is drawn against the sheet, keeps the old look until it is drawn again too, and the card says so. Further **looks** (outfits: mourning dress, armour, travel clothes) get sheets of their own, derived from the main one — the face, hair colour and build from the picture, the outfit from the words — so it stays the same person; a scene picks the look that fits its occasion, or is told which.
- **Place art** — reference art of a world entry (`visualImage`), sent along with pictures set there.

Reference images travel with the request where the model takes them: Bailian's multimodal generation, OpenRouter's image endpoint, GPT Image through the edits endpoint, and a ChatGPT subscription through Codex Connect or the CLI. At most three go with one picture — faces first, then the place.

**The sheet comes first.** A portrait asked for somebody who has no design sheet draws the sheet first and the portrait against it. A scene, a panel of the motion comic and a cover do the same for whoever of the people they show comes back in the book — a part that carries it (lead, second lead, antagonist, supporting), or anybody in two chapters or more, written or planned; somebody seen once and gone gets none. Each such sheet is one more image call; the job says so while it runs (*First the design sheet of …*) and the picture says so when it is done, and a batch of portraits shows the sheets as steps of their own. Two pictures that need the same sheet at the same time wait for one drawing of it. You are asked first: wherever a picture is started — a portrait, a passage, a chapter's panels, the cover, a picture from the gallery, a batch — the Studio works out whose sheets it would draw and, where there are any, says so before anything is drawn (*This will first draw 4 design sheets: …*) with three answers: draw them first, not this time (the picture is drawn from what there is), or cancel. Where nobody lacks a sheet nothing is asked; for panels of a chapter whose storyboard is not laid out yet it cannot be told beforehand, and the job bar says it when it comes to it. `image.sheetFirst = false` (Settings → Images) turns the whole thing off: nothing is asked and pictures are drawn from what there is.

**One brief for every picture.** Whatever is drawn — a sheet, a portrait, a scene, a panel, a cover, the art of a place — its prompt is laid out the same way: a line a part, each under its name, in one order — what the picture is for, the picture itself, its framing, the people (the subject first, then whoever is beside them), the place, the things, what was asked of this one; then the art direction, the reference pictures by number with what each shows and what follows a picture and what the words, and — where the service takes exclusions in the prompt alone — what must not appear, last. That is the order both makers of the image models most used here ask for (scene, subject, details, constraints; reference pictures spoken of by number), and it is the same for a strong model and a weak one: nothing is laid out differently by service. Somebody whose picture goes along is **pointed to** rather than described again (`image.looks`), unless their look was rewritten after that picture was drawn, an outfit has no sheet of its own, or the service leaves the picture behind — then they are written out. The brief goes as it is; the director writes it out as a prompt only where it does not fit the model, or where you have every prompt written (`image.promptWrite`).

**A parent, a sister.** *Somebody else's sheet…* in the same row gives a design sheet another character's: the new sheet is drawn with the likeness of family — the face — and everything else as its own card says. Write beside the picture what is wanted of it to have something else of it (the clothes, the hair).

**Pictures of your own to go by.** A design sheet (under the two buttons on a character's page) and the design art of a place, a house or a thing (under the draw button on the entry) take reference pictures from you: *From the book…* or *From this computer…*, each with a line for what you want of it — the face, the hair, this dress; the shape, the pattern, the colour. Say what you want of a picture and the director rewrites the prompt so that the words no longer speak of it — the picture settles it, and the record of the drawn picture lists the phrases taken out. Say nothing and the whole look follows the picture: the words written of that person or thing are not sent. They go to the image model after any picture the Studio itself draws against, so a service that takes one reference picture may leave them behind — the result says when it did. Portraits, the cover, scenes and free pictures do not take them (a portrait goes by the design sheet). The showrunner passes pictures you pointed at: `novel_illustrate kind=sheet|location|item references=[{path, note}]`.

**A portrait is two pictures.** Asked for with nothing said of it, a portrait is a pair (`image.portraits`): a **plain likeness** — facing the viewer on a plain ground, the picture that stands for the person in lists, as their avatar, on the stage — and the person **in their signature scene** — Lin Daiyu with the hoe over her shoulder among the fallen petals. In the text the likeness stands where they first come on and the scene where the chapter tells it; where the two fall in the same place, or so near that a reader would have both before them, the scene alone stands there. A batch draws of the pair whatever is lacking. These are their **signature scenes**, kept on the card in a panel of their own (`visual.scenes`): the name of each moment, its chapter, the moment as a picture in the language of the book, why it is theirs, and the portrait drawn of it. They are **the director's to find, in the book**: an agent with the text to read, handed what the chapter digests noted of the person as leads (and told how many chapters are not digested, so that it looks there too). It lists as many as there are, the most theirs first. You rewrite them, add and remove them, mark which one portraits show by default, draw any of them from its row, and have the list looked over again (*Have the director look again*, with a wish beside it if you have one; to the showrunner `novel_bible action=derive_scene`). Beside the portrait button a choice says which moment the next portrait shows, or *A plain likeness*. The person stays the subject — waist-up to three-quarter length, the face clearly seen, anybody else in the moment as company only — and a place the moment names goes along as a reference where it has design art.

**What you ask of a portrait guides the pick; it does not take the scene's place.** Write in the box under the buttons what you want of this one — *brighter*, *the night she burns her poems*, *her alone*, *nothing bloody* — and the director picks and writes the moment for this picture by it: a moment you name is the moment; a light, a mood or a bearing you ask for selects the moment that answers to it (the scene on the card where that fits, adjusted; another moment of the book where it does not), and the director says in a line how your wish was used. That pick is for this picture alone — the card keeps its scene, and *Keep this as their scene* under the note is one click if you want it to stay. A plain portrait is asked for the same way ("plain ground, facing the viewer").

**Which moments are fit to be shown is yours to say.** The task rules no kind of moment out: a martyr's portrait may be the martyrdom, a general's the thick of the fight, and a death can be what a person is remembered by. What this book's pictures should not show goes on its avoid list (*Bible → Art*), which the director steers round when picking; what one portrait should not show goes into what you ask of it. One line is not the author's to move: somebody who is not yet an adult is not written into a moment of intimacy or nudity.

The job says while it runs that the director is picking, the picture says which moment it shows and why, and its record keeps it — with what you asked, where that guided it. Where the book has nothing written yet nobody is asked, and what you ask is drawn as asked; where it has no moment for somebody (a walk-on), the director says so, nothing is kept and the portrait is plain. The interlude stage draws its figures plain; `image.portraits = plain` (Settings → Images) makes every portrait plain, and what is asked of one is then drawn as asked.

**The picture of a moment is chosen.** A moment may be drawn more than once — drawn again, its prompt rewritten, tried with another service. Every picture of it is listed with the moment on the person's card (by what each picture's record says it is of, not by a note beside the moment), the one that stands for it first; *Use this one* — there, or under the picture — makes another of them the moment's: in the panel, and in the text where the moment is told. A moment that was drawn stays on the card with its picture whatever the chapter digests come to note afterwards.

**The picture of a passage.** Select a passage where the chapter is written or read and ask for its picture: the director — an agent, with the chapter before the passage, the bible and the people's cards to read — says who is meant (a "she" is somebody), where they are, what is in their hands, and writes the picture; the Studio lays the brief out from that, each person by their look and their picture, the place and the things by theirs. The record keeps the passage and the director's account.

**Ideas, jotted down.** Under the buttons that draw somebody's sheet and portrait is a box for whatever comes to mind, mixed as it comes — *a scar through the left brow, always in a grey robe; this one on a snowy night, looking back*. When a button is pressed the director sorts it first: what is of the person goes into their appearance and holds for every later picture; what is of this one picture directs this picture and is kept nowhere; what the picture has no place for (a design sheet has no night and no snow) is left out. How each idea was sorted is listed under the box when the picture is done. Where no model answers nothing is guessed: all of it directs the one picture, the look stays as it is, and that is said.

**How a picture came to be.** A picture opened large — somebody's portrait or design sheet on their card, the design art of a place or a thing, anything in *Stage → Illustrations* — is shown with all there is on record of its making beside it:

- *Against the book as it is now*: whether this is the picture in use or an earlier one, whether the appearance and the art direction are the same now as when it was drawn, and — for a portrait — whether it was drawn against the sheet in use, an earlier one, or none.
- *Reference pictures*: the pictures that went to the image model with the prompt, each marked as in use or as an earlier one. A reference opens its own record, so a look can be followed back from picture to picture.
- *What the prompt was put together from*, in the order sent: what kind of picture it is, how its subject looks and where those words were taken from (the card's appearance; for a card of an earlier version, its old visual anchor), the expression, what was asked of this one picture, what the references are for, the art direction and where it comes from, and what was kept out — with a link from the look and from the art direction to where each is changed.
- *Rewritten, the whole prompt*: *Rewrite the prompt and redraw* opens everything the model was sent — the prompt whole, with its art direction and its line on the reference pictures — and, in a field of its own, everything that was kept out. What is sent again is those two fields as they stand; nothing is added to them. (The showrunner: `novel_illustrate redraw=… whole=… avoid=[…]`.)
- *What the image model was sent, word for word*, to be copied: the prompt as the Studio put it together plus what the way to that model adds — the things to keep out, appended where the service has no field for them (in a field of its own where it has); how the frame is shaped, where it takes no size; the wrapping of an agent that is asked to draw.

A look nobody asked for comes from one of these — a word in the appearance, a reference picture, the art direction — or from none of them, and then from the model. The showrunner reads the same record (`novel_manage action=show_image id=<id or path>`). Pictures drawn before the words as sent were kept show the prompt as it was put together. None of it leaves the book: the reader on a phone and a published site carry no prompts.

A good order for a new book: write the art direction and the avoid list, make a design sheet for each main character, add looks and place art where the story needs them, then illustrate.

### Images from a model on this machine

For trying a local model against a book. Neither way holds a key, and both keep the same record of a picture as every service: what was sent word for word, and how many reference pictures really went along.

**ComfyUI** (`image.provider: comfyui`) talks to a running ComfyUI server over its HTTP API (`image.baseURL`, `http://127.0.0.1:8188` when left out): the workflow is queued (`POST /prompt`), waited for (`GET /history/<id>`), and its picture fetched (`GET /view`). Stopping the job tells the server to stop too.

- **Your own workflow** (`image.workflow`): build it in ComfyUI, export it in **API format** (*Workflow → Export (API)*; the editor's own save format is refused with a message that says so), and write placeholders where the Studio's values go: `%prompt%`, `%negative_prompt%`, `%width%`, `%height%`, `%seed%`, `%steps%`, `%scale%`, `%model%`. A field that is a placeholder alone takes the value with its type (a number stays a number); inside a longer string it is replaced as text. The workflow needs a `SaveImage` node. This is the way for anything that is not a plain checkpoint — Flux, Qwen-Image, a GGUF loader, LoRAs, an upscaler.
- **Reference pictures** (`image.editWorkflow`): a second workflow, used for a picture that has references (a portrait against a design sheet, a scene with the people in it). It loads them with `LoadImage` nodes whose `image` is `%image1%`, `%image2%`, …; the Studio uploads the pictures (`POST /upload/image`) and fills in the names, as many as the workflow has places for. Without it, reference pictures do not go along, and the picture's record says so.
- **What the server has** is asked of the server: *Settings → Images → Connect* lists its checkpoints, its diffusion models, text encoders and VAEs (the choices of its loader nodes), its version and the device it draws on, and the model is chosen from that list.
- **A workflow saved on the server**: the workflows you saved in ComfyUI's editor are listed under *Workflows saved on the server*; choosing one takes it as it is. The Studio fetches the file, turns it from the editor's format into the graph the server runs — asking the server what each of its nodes takes, so that every widget goes by its name; the editor's notes, a seed's "after generate", a picture's upload button and whatever leads to no output are left out — and puts its placeholders in: the words, the size, the seed, and every `LoadImage` as a reference picture's place (`%image1%`, `%image2%`… in the order of the inputs they feed). A workflow that loads pictures becomes the one for pictures with references (`image.editWorkflow`), any other the plain one (`image.workflow`); both are kept in the settings as JSON, with a note of where each came from. A workflow with subgraphs, or with a node on bypass, cannot be told from the saved file: the message says so, and exporting it in API format is the way.
- **The server's last run as the workflow**: where the server's history holds a run that made a picture from a text, *Use it as the workflow* takes that run as the template — its words become `%prompt%` / `%negative_prompt%`, the size of its empty latent `%width%` / `%height%`, its seed `%seed%`; the models it loads and its sampling stay as the server ran them — and keeps it in the settings (`image.workflow` holds the JSON itself). The quickest way to draw with a model you already draw with in ComfyUI. A run the Studio queued itself is passed over for one of your own. (The history is the server's memory: it is gone when the server restarts, which is why the workflow is kept in the settings.)
- **No workflow**: a small text-to-image graph built for what `image.model` is, as the server lists it. A **checkpoint** (the first one the server has, when none is named): `CheckpointLoaderSimple`, two `CLIPTextEncode`, `KSampler`, `VAEDecode`, `SaveImage` — enough for an SD 1.5 or SDXL checkpoint. A **diffusion model that comes alone** (in the server's `diffusion_models`): `UNETLoader`, `CLIPLoader` with `image.textEncoder` loaded as `image.encoderType` (`qwen_image`, `flux2`, `sd3`…), `VAELoader` with `image.vae`, then the same. Where the server has one text encoder or one VAE it is taken; where it leaves a choice and the settings make none, the error names what to choose — nothing is guessed. A model family that needs a text node of its own is drawn with a workflow. **How the graph is sampled**: `image.steps` and `image.guidance` where set; where they are not, the steps, guidance, sampler and scheduler of the server's latest run that loaded this model and made a picture (read from its history — your own runs before the Studio's); with no such run, 25 steps, euler, and guidance 7 for a checkpoint or 3.5 for a diffusion model that comes alone. A model is drawn well at the figures it was made for — guidance 7 on a model meant for 3 gives a hard, flat picture — and whoever runs the server has found them already. The picture's record says what it was sampled with and where the figures came from.

**An OpenAI-compatible server of your own** (`image.provider: openai`, *Custom endpoint* in the settings) is a model on your machine or your network that somebody put behind `POST <baseURL>/images/generations` — the dialect OpenAI's SDK speaks with `client.images.generate()`. Any address and any model id are taken: `image.baseURL` is the `/v1` base (`http://192.168.1.20:8188/v1`), `image.model` what the server calls its model (`qwen-image-2.1-nf4`). An address on this machine or on a private network — loopback, `10.…`, `172.16–31.…`, `192.168.…`, the `100.64–127.…` a Tailscale-like VPN hands out, a name without a dot or ending in `.local`, `.lan`, `.ts.net` — makes it a server of your own by itself; `image.local` says so outright where the address misleads (a server of yours with a public name: `true`; a gateway on your network that hands on to a service: `false` — one that is asked for a GPT Image model is taken for that without being told). Such a server has one graphics card, and is asked accordingly:

- **One picture at a time**, whatever *pictures at once* is set to: the next is sent when the one before is back.
- **At a size it draws — asked of the server.** Where the server's model list (`GET <baseURL>/models`, read once in half an hour) says what a model takes — a row's `limits` (`max_width`, `max_height`, `max_pixels`, `max_prompt_chars`) and `defaults` — each picture is asked for at the largest size of its own shape those limits allow, sides in whole multiples of 32 and no shorter than 256: within 768 a side, a scene (16:9) is 736×416, a design sheet (3:2) 768×512, a cover (2:3) 512×768, a portrait 768×768. Should the server refuse a size worked out that way, the nearest of the three usual sizes is asked for, once. Where the list says nothing of a model's size, it is the nearest in shape of `768x768`, `768x512`, `512x768`. `image.sizes`, where you list some, has the last word either way. The settings show what each kind of picture comes to, and beside a model what the server says of it.
- **A prompt no longer than it reads**: where the list names how many tokens the model reads (`max_prompt_tokens`), a longer prompt is rewritten by the director to fit (see *A prompt that fits the model*); and whatever is sent is cut to the server's `max_prompt_chars` where it names one (a longer prompt is refused, not shortened, by a server that validates its input) — 4000 characters otherwise.
- **From a seed of its own each time**: a server whose model has a default seed draws the same picture every time it is asked the same — a picture *drawn again* would be the picture there was. Where the list shows a default seed, every request carries a seed of its own (`seed`), and the picture's record keeps it.
- **With nothing else it does not know**: the request is `model`, `prompt`, `n: 1`, `size` and, as above, `seed`. No quality, no output format, no background, no streaming — a server that validates its input refuses a field it has not heard of. What to keep out of the picture travels in the prompt (`Avoid: …`).
- **With reference pictures where it takes them — asked of the server too.** A picture that is to be held against others (a portrait against a design sheet, a sheet against a portrait, a scene with people in it) goes to `POST <baseURL>/images/edits` as a form — `model`, `prompt`, `size`, `n`, and the pictures as files: one as `image`, several as `image[]` — which is what OpenAI's `client.images.edit()` sends. How many go is what the model's row says: `reference_images.max_count` (none where `capabilities.image_edit` is `false`); a `seed` goes along where `edit_defaults.seed` gives one. A row that says nothing of pictures: they are sent, and a server that answers that it cannot take the request (400, 404, 405, 415, 422, 501) gets the picture asked for again from the words alone — its prompt written anew, without a word of any picture — and the record of the picture says what the server answered. An edits endpoint that is not there is not tried again for half an hour. Pictures the server's measure kept back (it takes one, two were to go) are named on the record as well.
- **Waited for when busy**: answered `429` with a `Retry-After`, the Studio waits as long as it says (a minute at most at a time) and asks again, up to seven times, before the picture fails. A server that has to load the model first is given ten minutes for the picture.
- **A key only where it wants one**: with none saved, none is sent; a server that then answers `401` is quoted, with where to paste the key.

The picture is the reply's `data[0].b64_json` (or `url`); whatever else the reply says — the model's build, how it was sampled, how long it took — is let be. A refusal is shown in the server's own words, also where it puts them in `detail` as FastAPI does. None of this touches a service on the net: GPT Image is asked as it always was.

**Diffusers** (`image.provider: diffusers`) runs the Diffusers library in your own Python. The Studio starts `image.python` (`python3`; `python` on Windows) with a small worker, which loads `image.model` — a Hugging Face id, a folder on disk, or a single `.safetensors` / `.ckpt` file — with `DiffusionPipeline.from_pretrained` (so whatever pipeline the model declares is what runs), keeps it loaded between pictures, and is let go after ten minutes with nothing asked of it. That Python needs `diffusers`, `torch` and what the model wants beside them (`pip install diffusers transformers accelerate torch`); the first picture waits for the model to load — and, for an id not on disk yet, for Diffusers to fetch it. One picture is drawn at a time. The worker passes a pipeline only what its call takes: a negative prompt where there is one (appended to the prompt as `Avoid: …` otherwise), a size, steps and guidance where set, and the reference pictures where the pipeline takes an `image` (an edit pipeline) — otherwise they stay behind, and the record says so. Stopping the job stops the worker.

Prompts are written in the language of the book with each appearance as it stands; a model whose text encoder reads only English wants the prompt written out in English (*Prompt language* under the advanced image settings: the director then writes every prompt, and translates what it is given).

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

A book may have numbers of its own (`parallel` in its `novel.json`: `text`, `speech`, `image`, `sound`). A kind it names is counted for that book alone, on a gate of its own — it neither waits for what other books have out nor is held to the Studio's figure; a kind it leaves out is counted with everything else.

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
