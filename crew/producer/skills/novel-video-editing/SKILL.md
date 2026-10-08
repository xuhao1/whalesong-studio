---
name: novel-video-editing
description: Use before cutting a chapter's voice, sound cues and storyboard pictures into a video — what the material in the working directory is, a base script that makes a first cut, how to refine it with ffmpeg, what goes wrong, and how the result is judged.
---

# Cutting a chapter's video

You are given material that is already made and already timed. Your work is to turn it into one MP4 that plays as it is, check it, and hand it in. Get a plain cut that passes the checks first; refine after.

## What is in the working directory

| File | What it is |
|---|---|
| `materials.json` | Everything, on one timeline: `lines` (start, end, speaker, text, `audio`), `panels` (start, end, `image`, `description`, `camera`), `cues` (kind, start, end, `audio`), `extras` (cover, other pictures), `frame` (the size the pictures were made for), `duration` |
| `voice.wav` | The whole telling as one track. Every spoken line is already where the timeline puts it; a line without a voice is silence of the right length. **Use this as the voice — do not re-assemble the lines** |
| `subtitles.srt` | The lines, cut into pieces a screen holds, timed |
| `panels.tsv` | One panel a row: number, start, end, length (s), camera, picture path, description — tab-separated |
| `cues.tsv` | One sound cue a row: kind (`bed` / `music` / `effect`), start, end, clip length, intensity, audio path, caption. A row without an audio path has no clip: leave it out |
| `cut-base.sh` | A script that makes a first cut from the files above |

All paths in these files are absolute. The material is read-only: write only in the working directory.

## The first cut

```bash
cd "<the working directory>"
bash cut-base.sh out.mp4
```

It cuts one clip per panel with its camera move (`clips/pNNN.mp4`), joins them (`picture.mp4`), mixes `voice.wav` with every cue that has a clip (beds and music looped quietly under their scene, effects at their moment), and writes `out.mp4` — H.264 yuv420p, AAC, faststart. A panel that was never drawn shows the picture before it. The subtitles go in as a track, and into the picture too where this ffmpeg can draw them; the script's last line says which it did.

Then measure it with `video_check`. If it passes, you already have something that can be handed in. Decide what would make it better, and whether that is worth the steps.

## Before you write any ffmpeg of your own

- **Find out what this ffmpeg can do.** Builds differ a great deal:
  `ffmpeg -hide_banner -filters | grep -E ' (subtitles|ass|drawtext|overlay|xfade|zoompan|sidechaincompress) '`
  No `subtitles` and no `drawtext` means this ffmpeg cannot draw text itself (Homebrew's build is one of these). See *Words in the picture* below before you settle for less.
- **This computer is the only one your work has to run on.** Use whatever it has — any language, any program, things only this system offers. Look at what is there (`uname`, `which`, `python3 -c 'import PIL'`) and choose. What you may not do is install software on the author's computer for it.
- **`-nostdin` on every ffmpeg call inside a loop.** In `while read … done < panels.tsv`, ffmpeg otherwise reads the rest of the table as keyboard commands and quits after a frame. The symptom is clips one frame long and a video half the length of its sound.
- **Paths have spaces and non-ASCII letters.** Quote every one.
- The shell may be bash 3.2 (macOS): no `mapfile`, no associative arrays. `awk` does the arithmetic.

## Words in the picture

The author watches in Novel Studio, and then sends the file to someone. Novel Studio's player shows a subtitle track that the file carries; most other places do not — a chat app drops it, a phone's player hides it behind a menu. Words drawn into the picture go wherever the file goes. So when subtitles are wanted, draw them in if this computer can do it at all, and carry the track as well when it costs nothing.

- **This ffmpeg draws text** (`subtitles`, or `drawtext`): the base script already burns `subtitles.srt` in. Large, outlined, in a font that has the book's letters.
- **It does not**: text can still be put into a picture as pictures. Draw each piece of `subtitles.srt` as a strip with a transparent background, using anything on this computer that renders text — Python with Pillow, ImageMagick, a headless browser, a few lines of Swift or of PowerShell with the system's own text drawing, whatever is there. Then lay the strips over the picture at their times: `overlay` takes pictures with transparency. One input instead of hundreds: an `ffconcat` list that holds each strip for its `duration` with a blank strip between them (and the last entry twice — the last duration is otherwise ignored), read with `-f concat -safe 0 -i subs.ffconcat` and laid on with `[0:v][subs]overlay=0:H-h`. Look at a still afterwards: are the words there, whole, readable?
- **Nothing here renders text**: carry `subtitles.srt` as a track (`-c:s mov_text`), and say in your note that the words are a track and not in the picture.

Hand a cut with the words in its picture in with `burned=true`.

## Refinements worth making

- **A picture of another shape.** The base script crops every picture to the frame. A portrait or a square picture loses its edges that way; a blurred copy of itself behind it keeps it whole:
  `[0:v]scale=W:H:force_original_aspect_ratio=increase,crop=W:H,boxblur=30:5[bg];[0:v]scale=W:H:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2`
- **Cross-fades.** `xfade=transition=fade:duration=0.5:offset=<seconds into the first clip>` between two clips; each fade shortens the whole by its duration, so make each clip longer by the fade to stay on the timeline. Chain them clip by clip, or fade only at scene changes.
- **Ducking.** Beds and music under a voice: `[bed][voice]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[bedducked]`, then mix. The voice must stay the loudest thing at all times.
- **Loudness.** End the audio chain with `loudnorm=I=-16:TP=-1.5:LRA=11` so the video is not quiet beside others.
- **A title card.** Only where this ffmpeg can draw text, or from a picture in `extras`. Four seconds at most — and then every later time on the timeline moves by its length: delay the voice (`adelay`) and shift the subtitles (`-itsoffset` on the subtitle input) by the same amount.
- **Motion.** `zoompan` moves within one picture. Keep moves slow (a tenth of the frame over a whole panel); a fast move on a still reads as an error.

## What goes wrong

| Symptom | Cause |
|---|---|
| Video half as long as the sound, clips of one frame | ffmpeg read the loop's input: `-nostdin` |
| Black stretches | A panel without a picture got no stand-in, or a path was wrong |
| `No option name near 'subtitles…'`, `No such filter: 'drawtext'` | This build draws no text itself: put the words in as pictures (*Words in the picture*), or carry the subtitle track |
| Picture and sound drift apart | Clip lengths were rounded to different frame counts than the timeline; make each clip `round(length × fps)` frames and let the sound decide the end (`-t <length of voice.wav>`) |
| Join fails or stutters | Clips differ in size, frame rate or pixel format: make every clip with the same `-vf …,format=yuv420p`, `-r`, codec settings, then `-c copy` joins them |
| Silent result | The voice was not mapped: the output needs `-map` for both the picture and the mixed sound |
| Jittering zoom | Scale the picture up (2×) before `zoompan`, as the base script does |

## How the result is judged

`video_check <file>` measures: a picture stream and a sound stream; length within the telling's (a little longer is fine — a title, an end card); sound that is not silence; no long black stretches; a picture at least 640×360. When subtitles are wanted (the task says so), the words must reach the viewer: in the picture — say `burned=true`, the measuring cannot see that for itself — or as a subtitle track, or both; a cut with neither is refused. It leaves stills in `check/` — if your model sees images, look at them with `read_image`: is the picture the right one, is text readable, is anything cut off? When subtitles are wanted the stills are taken where it matters — before the telling begins, on the first line, in a silence between two lines, in the middle, on the last line — and each is listed with the words that should be on the picture at that moment, or with "no subtitle". Say `offset=<seconds>` when a title card moved the telling back, so the moments are the right ones. Words that come early, stay too long or never show are the commonest faults of subtitles put in by hand; this is where they are found.

`video_submit <file> <note>` measures once more and takes the file only if it passes; `burned=true` here too when the words are in the picture. The note is for the author: how you cut it, what was missing, what you chose.

## When it is beyond you

If the work needs more than these tools give — animation you cannot get out of ffmpeg, a look you cannot reach — and `subagent_claude_code` or `subagent_codex` is among your tools, hand it over. Look at your tool list first: when neither is in it, the author has installed no outside help, there is nobody to hand to, and a call to a tool you do not have only spends a step. Write the prompt as for someone who knows nothing of this conversation: the absolute path of `materials.json` and of the working directory, what the video should be, where to write it (`<working directory>/out.mp4`), the constraints (material read-only, write only in the working directory, install nothing on the computer), and how it will be judged (the list above). When it returns, run `video_check` yourself — you hand in, not it.
