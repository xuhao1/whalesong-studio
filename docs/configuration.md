# Configuration

Everything described here can be changed in *Novel Studio → Settings* (the gear icon), and the showrunner can change it for you in the conversation ("set speech up with Bailian", "use Claude for the writer"). This page is the reference: what each field means, where it is stored, and the other places a setting can come from.

## Two ways to set up

**One click.** *Settings → One-click setup* (also the first-run guide, which opens by itself while nothing is configured): pick a service, paste its key, choose which slots it should fill, click **Set up**. The key is checked against the service first; a key that is refused changes nothing.

| Service | Writing models | Images | Speech | Retrieval |
|---|---|---|---|---|
| Aliyun Bailian | `qwen3.8-max` (writer, architect), `qwen3.8-flash` (analyst, director) | `qwen-image-3.0` | `qwen-audio-3.1-tts-next` | `qwen3.7-text-embedding-flash` |
| OpenRouter | `anthropic/claude-sonnet-5.5` (writer), `deepseek/deepseek-v4-pro` (architect), `deepseek/deepseek-v4.1-flash` (analyst, director) | `openai/gpt-image-2.5-sunburst` | `google/gemini-3.8-flash-tts` | `qwen/qwen3-embedding-8b` |
| OpenAI | `gpt-6.1-sol`, `gpt-6-luna` | `gpt-image-2` | `gpt-4o-mini-tts` | `text-embedding-3-small` |
| ChatGPT subscription (Codex) | — | the subscription's GPT Image | — | — |

Where the Harness already has a chat model, "Writing models" starts unticked: the roles keep following it until you say otherwise.

**Slot by slot.** Below the cards every slot — the four roles, images, speech, retrieval — has its own service, endpoint, key, model and (for text) reasoning level. The model field suggests what the service offers and can list what the endpoint itself serves; any id can be typed.

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

3. **Per-book model overrides** — the `models` key of a book's `novel.json`, for a book that needs a different writer:

   ```json
   { "models": { "writer": { "provider": "deepseek", "model": "deepseek-v4-pro", "temperature": 0.9 } } }
   ```

Session state (the working mode and which book a session is on) lives in `$DSH_HOME/novel-writer/sessions.json`.

## The book in play

A conversation is on one book at a time, and the Studio beside it shows that same book. The two move together:

- **Open another book in the Studio** and the conversation follows. The showrunner is told at its next step — in the conversation's own record, so it holds after a long session too — which book is now in play, which one the earlier turns were about, and that unfinished work on the earlier book must be named explicitly rather than carried over.
- **Ask the showrunner to switch** ("切到《…》") and the Studio follows: it moves the session with `novel_status project=…`, and the panel opens that book.
- **Touching another book once** does not need a switch. Every tool takes an optional `book` (a title or a path): "copy this character over from 《…》" reads there and writes here, and the conversation stays where it is. The tool row in the conversation shows the book such a call named, and in a conversation that has been on more than one book every result says which book it is about.

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

| Role | Used for | Falls back to | Default temperature |
|---|---|---|---|
| `writer` | drafting, continuing, rewriting, style samples, novelizing interludes | conversation model | 0.85 |
| `analyst` | digest and arc summaries, review, learning a style from a sample, audio scripts, storyboards, illustration prompts | conversation model | 0.2 |
| `architect` | foundation, chapters, beats, what-if, expanding bible entries, triage of book-wide revisions, merging cast and outline on import | writer → conversation model | 0.8 |
| `director` | interlude turns | writer → analyst → conversation model | 0.9 |

"Conversation model" is the model of the session that started the work when the showrunner calls a tool, and the Harness default model when you start work from the Studio.

A role is one of three things:

- **unset** — it follows the conversation model;
- **a provider the Harness already reaches** — a route (`provider`, `model`) called through the Harness LLM runtime with its credentials and retry policy. The role's source list names every such provider, one entry each: those with a key under *Settings → Models*, and those that came with a sign-in — the ChatGPT subscription of Codex Connect appears as *OpenAI Codex* with its models. A provider that cannot list its models at the moment (signed out, offline) is still offered, with the reason, and takes a model id typed by hand;
- **a direct endpoint** — any OpenAI-compatible `/chat/completions` (`baseURL` set), called by the Studio itself with a key entered in the Studio.

| Field | Meaning |
|---|---|
| `provider`, `model` | a Harness route — or, with `baseURL`, a label for the service and the model id |
| `baseURL` | root of an OpenAI-compatible API ending in `/v1`; its presence makes the route direct |
| `apiKeyRef` | direct routes only: read the key from this variable instead of the one saved for the host |
| `temperature` | optional override of the role default |
| `maxTokens` | optional cap on how long a reply may run. Unset by default: see *How long a reply may run* below |
| `reasoningEffort` | Harness routes: one of the levels the model declares. Direct routes: `off`, `minimal`, `low`, `medium`, `high` or `xhigh`. Omitted = the model's default |
| `contextWindow` | how many tokens the model can read, when neither the Harness nor the endpoint says. It decides how much of the book a call is given — see below |

**Reasoning on direct routes** is translated per service: Bailian gets `enable_thinking` (and a `thinking_budget` for the lower levels), OpenRouter `reasoning.effort`, DeepSeek's own API `thinking.type`, everything else `reasoning_effort`. An endpoint that refuses a parameter (`temperature`, `max_tokens`, the reasoning field, `stream_options`) gets the call again without it, so one odd model does not need special settings.

**How long a reply may run.** The Studio sets no limit of its own on what a model writes. A model that reasons spends its reasoning out of the same allowance as its answer, so a cap sized for the answer alone — a few thousand tokens for a script, a storyboard, a chapter — cuts the answer off; that is how an audio script loses its speakers and a storyboard ends after two panels. With `maxTokens` unset, a Harness route uses the limit its provider is configured with (256,000 tokens for the DeepSeek models, whose own maximum is 384,000 of a 1,000,000-token window), and a direct endpoint uses its own default — except DeepSeek's own API, whose default is 8,000 tokens with reasoning off, where the Studio asks for the model's documented limit instead. The settings show, per role, what applies. Set `maxTokens` only to hold a model back on purpose.

A reply that is cut off at a limit all the same is not patched up and passed along: the step fails, or falls back visibly, and says that the limit was the reason.

**Reasoning models.** A model that thinks before answering can take minutes per chapter and per digest. Lower or switch off reasoning for the writer and the analyst; keep some for the architect, where it pays. If the levels list of a Harness model is empty, declare them on the provider in the Harness configuration (`reasoningEfforts` on the model entry — see the Harness provider documentation).

## Context and memory

| Field | Default | Meaning |
|---|---|---|
| `context.strategy` | `auto` | `auto`: send the whole manuscript while it fits the budget, otherwise pack by relevance. `full`: prefer the whole manuscript, falling back when it cannot fit the window. `retrieval`: always pack by relevance. |
| `context.budgetTokens` | `500000` | the most background one call may carry. Current models read about a million tokens; half of that leaves a long book whole and still leaves room to write. |
| `context.tailChars` | `3000` | characters of the text just before the writing position that are always carried verbatim |
| `autoDigest` | `true` | digest a chapter right after it is written or a revision is applied |
| `reviewAgentRevisions` | `false` | when on, revisions requested by the showrunner wait as proposals instead of applying |

**The budget never exceeds what the model can read.** A call uses at most 70 % of its model's context window for background; the rest is for instructions and the reply. The window comes, in this order, from the role's own `contextWindow`, from the Harness (for its models), from the endpoint (OpenRouter publishes one per model), and from a table of the model families the one-click setups use (the Qwen 3.5+, DeepSeek V4, GPT-6, Claude 5 and Gemini 3 families are taken as one million). A model nobody can place is assumed to read 200,000 tokens — set `contextWindow` on its role when it reads more, and the whole book fits.

A settings file saved before this default existed carries the old one, 48,000, which nobody chose; it is read as the new default. A budget you set yourself is kept.

## Images (optional)

| Field | Meaning |
|---|---|
| `image.provider` | `none`; `openrouter` (`POST <baseURL>/images`); `openai` (`POST <baseURL>/images/generations`); `dashscope` (Bailian's native API: Qwen-Image, Wan, Z-Image); `codex` (a ChatGPT subscription) |
| `image.baseURL` | `openrouter`, `openai`: the `/v1` base. `dashscope`: only the origin matters (`https://dashscope.aliyuncs.com` or a workspace domain). `codex`: unused |
| `image.model` | e.g. `openai/gpt-image-2.5-sunburst`, `gpt-image-2`, `qwen-image-3.0`, `z-image-turbo` |
| `image.size` | default `WIDTHxHEIGHT`; panels and interlude backgrounds ask for 1280x720, portraits for 1024x1024 |
| `image.quality` | `openrouter`, `openai`: `low`, `medium`, `high`; omitted = the model's default |
| `image.bridge` | `codex` only: `auto` (default), `connect` or `cli` — see below |
| `image.stylePrompt` | the art direction new books start from — see *How a book keeps one look* below |
| `image.negativePrompt` | what no picture of any book may show; each book adds its own list |
| `image.apiKeyRef` | read the key from this variable instead of the saved one |

How sizes travel: OpenRouter gets the nearest aspect ratio and a resolution tier, which every model there understands; GPT Image models on an OpenAI endpoint get the nearest of their three classic sizes; other models get the size as written; a subscription gets the framing in words, because its endpoint takes a prompt and nothing else.

Generated images are downloaded into the book (`assets/images/`), so a book never depends on an expiring URL.

### How a book keeps one look

Nothing reaches an image model that the author cannot read and change. A prompt is assembled from parts, and every picture records the parts it was made of (*Stage → Illustrations*, open a picture):

- **Art direction** — one text per book (`artStyle` in `novel.json`), appended to the subject of every picture. A book without one starts from `image.stylePrompt`, or from the built-in direction when that is empty too; the first picture writes whichever is in force into the book's `novel.json`, and from then on the book keeps its own. It is shown, with where it came from, at the top of *Stage → Illustrations*, in *Book info*, and by `novel_settings action=show`.
- **Avoid list** — `image.negativePrompt` for every book, `artAvoid` per book, `visual.negative` per character and `avoid` per call. They are joined, sent as the negative prompt, and given to the model that writes scene descriptions so it steers around them. This is the place for what a setting does not have: a story's "church" that is nothing like a cathedral lists *crosses, gothic cathedral, stained glass*.
- **Visual anchors** — a character's `visual.prompt`: short, concrete, drawable phrases (English is steadiest) for build, face, hair as a shape, clothing by cut and material, signature items. It is restated as is in every picture of them, instead of the prose of the card, which an image model reads loosely. *Distill anchor* on the card (or `novel_bible action=derive_visual`) has the analyst write it; drawing someone without one distills it first.
- **Design sheets** — front, side and back of a character on one sheet (`visual.sheet`). Every later picture of them is drawn with the sheet as a reference image. Further **looks** (outfits: mourning dress, armour, travel clothes) get sheets of their own, derived from the main one so it stays the same person; a scene picks the look that fits its occasion, or is told which.
- **Place art** — reference art of a world entry (`visualImage`), sent along with pictures set there.

Reference images travel with the request where the model takes them: Bailian's multimodal generation, OpenRouter's image endpoint, GPT Image through the edits endpoint, and a ChatGPT subscription through Codex Connect or the CLI. At most three go with one picture — faces first, then the place.

A good order for a new book: write the art direction and the avoid list, make a design sheet for each main character, add looks and place art where the story needs them, then illustrate.

### Images from a ChatGPT subscription

`image.provider: codex` draws with the GPT Image included in a ChatGPT plan. The Studio has no sign-in of its own; it rides on one that already exists:

- **`connect`** — the [Codex Connect](https://github.com/franksong2702/dsh-codex-connect) plugin. It exposes a Host service for companion plugins (`ctx.openaiCodexTransport`); the Studio hands it a prompt and receives the image. Authorize once under Harness *Settings → Models → Openai-Codex*.
- **`cli`** — the Codex CLI on the machine that runs the Harness, signed in with `codex login`. One non-interactive run in a read-only sandbox, with the prompt passed on standard input, produces the image (about a minute each).
- **`auto`** uses Codex Connect when it is signed in, else the CLI.

A subscription has no embedding endpoint and no speech endpoint — retrieval and audio need a keyed service. Whether a plan includes image generation, and how much, is decided by OpenAI.

## Speech (optional)

| Field | Meaning |
|---|---|
| `tts.provider` | `none`, `qwen-audiogen`, `qwen-realtime`, `dashscope`, `openrouter` or `openai` |
| `tts.baseURL` | `qwen-audiogen`, `dashscope`: the Bailian origin. `qwen-realtime`: the WebSocket URL (`wss://dashscope.aliyuncs.com/api-ws/v1/realtime`, or a bare origin). `openrouter`, `openai`: the `/v1` base |
| `tts.model` | e.g. `qwen-audio-3.1-tts-next`, `qwen3.8-omni-flash-realtime`, `qwen3-tts-instruct-flash`, `google/gemini-3.8-flash-tts`, `gpt-4o-mini-tts` |
| `tts.designedVoiceModel` | `dashscope` only: the model that speaks designed voices |
| `tts.narratorVoice`, `tts.narratorInstructions` | the narrator's voice and reading manner |
| `tts.defaultVoices` | fallback voices for `female`, `male`, `neutral` casting |
| `tts.concurrency` | parallel synthesis requests (1–8, default 3) |
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

**The script.** The analyst model cuts the chapter into lines and says who speaks each. Narration is kept whole — a paragraph is a line, a fragment of a few syllables joins the narration beside it — because every line is a separate request to the speech model, and a script of fragments is a script of voices that do not quite match. Delivery notes are written for dialogue and inner voice, held steady within a scene, and left off the narration unless the telling really changes key. A passage the model could not deliver (its reply was cut off, or did not cover the text) is cut by rule instead, which knows no speakers; the script then says so on screen, with the reason and a way to direct it again, rather than quietly reading everyone's lines in the narrator's voice.

**The voice sheet.** Who speaks with which voice is decided once per book and kept in `.novel/voices.json`: the voice on a character's card if there is one, else a voice cast by gender and age, and — for speakers without a card, the shopkeeper and the passer-by — a voice of their own, cast by name. The next chapter, and the interludes, cast from the same sheet, so nobody changes voice because they happened to speak in a different order. Another speech provider or model starts a new sheet.

**The listening check.** Every take is measured before it is kept: how long it is against the words it was given, how loud, and how high the voice sits. A take that is silent, far too short for its text (most of the line is missing) or padded, or whose pitch sits well away from where that voice usually does (it came back as someone else), is spoken again — `tts.retakes` times at most — and the best take is kept. A voice is known by its reference clip where there is one, else by its own long lines. A syllable or two says more about its tone than about the speaker, so very short lines are not judged on pitch. A line that still stands out after its retakes is marked in the script, where it can be spoken again by hand; `tts.retakes: 0` keeps the marking and drops the retakes.

**The level.** Every kept line is brought to the same loudness, with peaks rounded off rather than clipped.

Running *Check and repair* on a chapter that is already voiced applies the same check to what is there: lines that fail are spoken again, the rest are only evened out, and nothing else is spent.

This narrows the gaps; it does not close them. A generative speech model such as `qwen-audio-3.1-tts-next` is expressive precisely because it is free, and on a line of one or two syllables it may still shade off. Where an unvarying timbre matters more than expressiveness, the Qwen-TTS models (`dashscope`) with a stock or designed voice hold one exactly.

**Choosing a speech model.** The model field lists every model of the endpoint that can speak, not only those of the service chosen above. On Bailian they speak three different protocols; each entry says which, and choosing a model switches the service to the protocol that drives it. Models served over a protocol the Studio does not speak yet (the streaming-synthesis sockets `…-tts-…-realtime` and `qwen-audio-…-realtime`, third-party models) are listed too, greyed out, so the list is the whole picture.

**While a chapter is voiced** the reader's listening mode shows how many lines are done, which one is in the booth (and when one is being taken again, and why), the time taken and an estimate of what is left; finished lines appear as they come and can be played at once. Stopping keeps what is voiced.

## Reading and listening

*Read* is one page with two modes. **Read** shows the chapter as a reader meets it. **Listen** shows the same page with a player under it: the sentence being spoken is lit in the prose, any sentence can be pressed to play from there, and a chapter that ends goes on to the next. The author additionally gets the production desk of the audio version above the page — make it, check and repair it, export it, see who was cast with which voice — and can switch the page from the prose to the script line by line, to change a speaker, a delivery note or a take.

### On another device

The phone button in the reader's bar switches on reading on other devices for the book: the Studio then serves the same reader — both modes, nothing else — to phones and tablets on the same network, and shows the address as a link and as a code to scan.

- It is **off until you switch it on**, book by book, and stays on across restarts until you switch it off.
- The server is the Studio's own and **read-only**: it has no route that writes, and none that reaches a model, a key, the settings, the manuscript files as such, or a book you did not share. Pictures and audio are served from the shared books' `assets/` and from nowhere else.
- The address carries a **random token**; whoever has the address can read. *New address* replaces the token, and every link given out before stops working.
- It listens on port `4319` by default (`share.port`), on every network interface of the machine, over plain HTTP. On a network you do not trust, leave it off. The first time, the operating system may ask whether to allow incoming connections.
- The computer and the Harness must be running for the phone to read.

| Field | Meaning |
|---|---|
| `share.enabled` | whether the reader for other devices is on |
| `share.books` | folders of the books that are shared |
| `share.port` | port to listen on (1024–65535, default 4319) |
| `share.token` | the secret part of the address; made the first time sharing is switched on |

The showrunner can do the same with `novel_share`; switching it on from the conversation asks you first.

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

## What is being worked on

Anything that takes a moment says so. A button that started work shows a spinner and what it is doing until the work ends, and cannot be pressed twice; a bar at the foot of the Studio lists everything in progress for the book — requests still waiting for an answer and running jobs, with what each is doing, for how long, and a way to stop it — whichever screen you are on, and whoever started it.

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

What the one-click setup writes (with "Writing models" ticked); the key is in the credential store, not here:

```json
{
  "models": {
    "writer":    { "provider": "bailian", "model": "qwen3.8-max",   "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1", "reasoningEffort": "off" },
    "analyst":   { "provider": "bailian", "model": "qwen3.8-flash", "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1", "reasoningEffort": "off" },
    "architect": { "provider": "bailian", "model": "qwen3.8-max",   "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1", "reasoningEffort": "low" },
    "director":  { "provider": "bailian", "model": "qwen3.8-flash", "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1", "reasoningEffort": "off" }
  },
  "embedding": { "provider": "openai", "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1", "model": "qwen3.7-text-embedding-flash" },
  "image":     { "provider": "dashscope", "baseURL": "https://dashscope.aliyuncs.com", "model": "qwen-image-3.0", "size": "1280x720" },
  "tts":       { "provider": "qwen-audiogen", "baseURL": "https://dashscope.aliyuncs.com", "model": "qwen-audio-3.1-tts-next", "concurrency": 2 }
}
```

A workspace domain (`https://ws-xxxx.cn-beijing.maas.aliyuncs.com`) works the same way: give it as the service address in the one-click card, or replace the hosts above. Any endpoint URL of that domain can be pasted — the Studio takes the host from it.
