# Contributing

Thanks for wanting to make Novel Studio better. This page covers how the code is laid out, how to run it, and the few rules that keep a Harness plugin healthy.

## Setup

You need Node.js 22 or later. DeepSeek Harness itself is a dev dependency, so nothing else has to be installed.

```sh
npm install        # installs dependencies and builds lib/
npm run check      # typecheck (host + browser), unit tests, build into .dev/stage (what `npm run dev` runs)
npm run release    # the same checks, then lib/ is updated in place — what an installed or linked copy runs
npm run push       # after a release is committed: main goes to GitHub, fast-forward only, looked over for credentials first
```

## Running it

```sh
npm run dev
```

boots the Harness Web UI on http://127.0.0.1:3199 with this checkout mounted as a bundle, inside an **isolated Harness home** (`.dev/home`) so your real `~/.dsh` is never touched. The launch URL with its access token is printed to the terminal.

Two things to do once:

1. **Give the dev home a model.** Either add a provider in the Web UI (*Settings → Models*), or write one into `.dev/home/profiles/web/cordis.patch.yml`:

   ```yaml
   - id: llm-pi-ai
     name: '@deepseek-ai/dsh-llm-pi-ai'
     config:
       providers:
         my-provider:
           api: openai-completions
           baseURL: https://example.com/v1
           apiKeyEnv: MY_API_KEY
           models:
             - { id: some-model, name: some-model, contextWindow: 128000 }
   - id: agent-default-model
     name: '@deepseek-ai/dsh-agent-default-model'
     config: { provider: my-provider, model: some-model }
   ```

   Or run `npm run dev -- --home ~/.dsh` to reuse a home that already has models (this one does write to it).

2. **Add a workspace.** The Harness puts its default workspace under `~/Documents/deepseek-harness/`. For throwaway books, add `.dev/workspace` through the sidebar's *add workspace* button.

Then:

- browser code: `npm run watch` in another terminal, reload the page;
- Host or agent code: rebuild and restart `npm run dev` (plugins are loaded once per process).

Options: `--port`, `--workspace <dir>`, `--home <dir>`, `--profile <name>`.

## Layout

```
src/
├── shared/      types, the RPC contract, text helpers — no Node, no DOM
├── core/        the engine, free of Harness imports so it runs under plain vitest
│   ├── project.ts        one book on disk: locked writes, cache, directory watcher
│   ├── context.ts        the context packer        retrieval.ts  BM25 + embeddings
│   ├── prompts.ts        every prompt, in Chinese and English
│   ├── jobs.ts           observable long-running work
│   ├── media/            speech, image and embedding providers; WAV utilities
│   ├── reader.ts         what a reader is given — for another device, for a published site
│   └── pipelines/        write, revise, digest, plot, bible, review, import,
│                         illustrate, audio, comic, play, export, outline, site
├── host/        the Harness side: service (`ctx.novel`), model adapter, RPC handlers, routes
├── agent/       mounted inside the agent preset: tools, prompt sections, the /novel command
└── client/      the Studio (React): store, views, stage players, tool rows, one stylesheet
skills/          workflow guides the showrunner can load
crew/            the skills of each role of the crew
recommended.json which models each service is used with, as data (see below)
cordis.patch.yml the bundle: the Host row and the agent preset
tests/           unit tests with a fake model; live tests behind NOVEL_LIVE=1
```

`scripts/build.mjs` bundles the entry points with esbuild: `lib/index.js` (the Host half — which carries the agent half too) and `lib/agent.js` (the entry a preset names; it only asks the running Host half to mount its agent half, so the two are always of one build) as ESM that keeps every `@deepseek-ai/*` import external, and `lib/client.js` in the Harness client-module format.

**`lib/` is what a running copy runs.** A profile that links this checkout loads `lib/` — and a Harness that is running swaps the Studio in its window when `lib/client.js` changes, while its Host half stays as loaded until it restarts. So nothing is built in place: a build goes to a directory of its own and is then put into `lib/` file by file, each one whole, only the files that changed (`lib/build.json` names the build; the Host compares the one it runs with the one installed and the Studio says so when they differ). Day to day, `npm run check` builds into `.dev/stage/`, a copy of the package the dev launcher runs; `npm run release` is the one command that touches `lib/`.

**The Host half can be replaced while DSH runs.** DSH loads `lib/index.js` once and keeps it; so that file is only a door (`src/host/door.ts`, `src/index.ts`) that puts up the Host half proper — `lib/host.js`, from `src/host/main.ts` — as a plugin of its own, and can take it down and put up the file that lies there now. That is what *Restart* on the Studio's banner does after a release. It works because everything the Host half registers, it registers on the context it is given: keep it that way — no listener, route, tool or timer that outlives that context, and no state in a module that a later build must not inherit (code that is the same in two builds is loaded once; `forgetPackageFiles()` exists for what is cached from disk). A change to the door itself still needs DSH restarted.

## Rules of the house

**An uncaught error in plugin code takes the whole Harness down.** Never leave a promise unhandled: `void promise.catch(...)`, or go through `controller.guard` / `useAction` in the UI and `JobManager` on the Host, which record failures instead of throwing them into the void.

**Cordis injection is strict.** A context can read only the services its plugin (or an enclosing `ctx.inject`) names. Optional services are read with `ctx.get('name')`.

**Preset plugins mount once per preset, not per agent.** Anything in `src/agent` must take the calling agent from the tool call (`exec.agent`) and keep no per-agent state in module scope.

**The core stays portable.** `src/core` and `src/shared` import nothing from the Harness; the Host adapts. That is what lets the pipelines be tested with a fake model in milliseconds.

**Every pipeline takes a signal and reports progress.** Long work runs as a job: pass `task.signal` to model and network calls, stream text with `task.job?.rewrite(...)`, report steps with `task.job?.progress(...)`.

**Models return almost-JSON.** Use `completeJson` (tolerant parsing, repair of truncated replies, one retry with the validator's complaint) and validate what you read with `asText` / `asList` / `asRecord`; never `JSON.parse` a reply directly.

**Prompts are bilingual.** Each prompt in `core/prompts.ts` has a Chinese and an English version, chosen by the book's language. Change both.

**UI text is bilingual and inline**: `const t = useT(); t('中文', 'English')`. No string tables.

**Styles** live in `src/client/styles.css`, are prefixed `nv-`, and take every colour from Harness theme tokens (`--dsw-alias-*`) so light and dark both work. Layout breakpoints are container queries: the Studio is often a 450 px sidebar tab.

**The browser bundle** may import only what the Harness seeds as shared modules (see `PLATFORM_MODULES` in `scripts/build.mjs`); everything else is inlined, so keep dependencies out of `src/client`.

**Keys are references.** Settings store the *name* of a credential, never its value.

**No model is named in the code.** Which model a service is used with, what is offered beside a model field, what a kind of endpoint falls back on, how large a model family's window is: all of it is `recommended.json`, read through `src/shared/recommended.ts`. To change a recommendation, edit the file, raise its `version`, set its `date` and say what changed in `notes` — authors who follow the recommendations get the change with the next version and are told what moved (`src/host/recommended.ts`). `tests/recommended.test.ts` holds the file to naming a model for every kind of endpoint the code can ask about.

## Tests

```sh
npm test                 # unit tests: project store, pipelines against a scripted model, text utilities
npm run typecheck
```

Live tests call a real OpenAI-compatible endpoint and print what the models wrote, so prompt changes can be judged by eye:

```sh
NOVEL_LIVE=1 NOVEL_LIVE_BASE_URL=https://example.com/v1 NOVEL_LIVE_API_KEY=… NOVEL_LIVE_MODEL=some-model \
  npx vitest run tests/live.test.ts
```

Set `NOVEL_LIVE_KEEP=1` to keep the generated book for inspection.

When you change a prompt or a pipeline, run the live tests once and read the output. When you change the UI, look at it both as a page and as a sidebar tab, in light and dark.

## Pull requests

- One change per pull request, with the reasoning in the description.
- `npm run check` passes.
- New behaviour comes with a test where the core is concerned, and with a note in `CHANGELOG.md`.
- Contributions are licensed under LGPL-3.0-or-later, like the rest of the project.
