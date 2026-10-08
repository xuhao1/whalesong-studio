#!/bin/bash
# cut-base.sh — a plain first cut of a chapter's video from the material beside it.
#
# Run it inside the working directory:   bash cut-base.sh [out.mp4]
#
# It reads panels.tsv, cues.tsv, voice.wav and subtitles.srt (written there by
# Novel Studio) and makes:  clips/pNNN.mp4  one clip per panel, with its camera move
#                           picture.mp4     the clips joined
#                           out.mp4         picture + voice + sound cues + subtitles
#
# It is a starting point, not the finished work: copy it, change it, or write
# your own. Everything it does is ordinary ffmpeg; nothing else is needed.
#
# Every ffmpeg call here carries -nostdin: inside a `while read` loop ffmpeg
# would otherwise eat the rest of the table as keyboard commands and stop early.
set -euo pipefail

OUT="${1:-out.mp4}"
W="${W:-1920}"; H="${H:-1080}"; FPS="${FPS:-30}"
# A font that has the book's letters. PingFang SC is on every Mac; on Windows
# use "Microsoft YaHei", on Linux "Noto Sans CJK SC".
FONT="${FONT:-PingFang SC}"
# Shown for a panel that was never drawn and has no drawn panel before it.
FALLBACK="${FALLBACK:-}"

command -v ffmpeg >/dev/null || { echo "ffmpeg is not on the PATH" >&2; exit 1; }
[ -s panels.tsv ] || { echo "panels.tsv is empty: this chapter has no storyboard — arrange the picture yourself" >&2; exit 1; }
[ -s voice.wav ] || { echo "voice.wav is missing" >&2; exit 1; }

# ── 1. one clip per panel ────────────────────────────────────────────────────
mkdir -p clips
: > clips.txt
n=0
last=""
if [ -z "$FALLBACK" ]; then
  FALLBACK=$(awk -F'\t' '$6 != "" { print $6; exit }' panels.tsv)
fi
while IFS=$'\t' read -r index start end length camera image description || [ -n "${index:-}" ]; do
  [ -n "${index:-}" ] || continue
  n=$((n + 1))
  if [ -n "$image" ] && [ -f "$image" ]; then last="$image"; fi
  src="${last:-$FALLBACK}"
  [ -n "$src" ] && [ -f "$src" ] || { echo "panel $index has no picture and there is none to stand in" >&2; exit 1; }
  frames=$(awk -v d="$length" -v f="$FPS" 'BEGIN { n = int(d * f + 0.5); if (n < 1) n = 1; print n }')
  # zoompan: `on` is the output frame; the picture is scaled up first so the move is smooth.
  cx="iw/2-(iw/zoom/2)"; cy="ih/2-(ih/zoom/2)"
  case "$camera" in
    zoom-in)   z="1+0.10*on/$frames";    x="$cx"; y="$cy" ;;
    zoom-out)  z="1.10-0.10*on/$frames"; x="$cx"; y="$cy" ;;
    pan-left)  z="1.10"; x="(iw-iw/zoom)*(1-on/$frames)"; y="$cy" ;;
    pan-right) z="1.10"; x="(iw-iw/zoom)*on/$frames";     y="$cy" ;;
    pan-up)    z="1.10"; x="$cx"; y="(ih-ih/zoom)*(1-on/$frames)" ;;
    pan-down)  z="1.10"; x="$cx"; y="(ih-ih/zoom)*on/$frames" ;;
    *)         z="1+0.03*on/$frames";    x="$cx"; y="$cy" ;;
  esac
  clip=$(printf 'clips/p%03d.mp4' "$n")
  ffmpeg -nostdin -hide_banner -loglevel error -y -i "$src" \
    -vf "scale=$((W * 2)):$((H * 2)):force_original_aspect_ratio=increase,crop=$((W * 2)):$((H * 2)),zoompan=z='$z':x='$x':y='$y':d=$frames:s=${W}x${H}:fps=$FPS,format=yuv420p" \
    -frames:v "$frames" -r "$FPS" -c:v libx264 -preset veryfast -crf 18 "$clip"
  echo "file '$clip'" >> clips.txt
done < panels.tsv
echo "cut $n panel clips"

# ── 2. the clips joined ──────────────────────────────────────────────────────
ffmpeg -nostdin -hide_banner -loglevel error -y -f concat -safe 0 -i clips.txt -c copy picture.mp4

# ── 3. the sound: voice, with every cue that has a clip under it ─────────────
total=$(ffprobe -v error -show_entries format=duration -of csv=p=0 voice.wav)
inputs=(-i picture.mp4 -i voice.wav)
filter=""
mix="[1:a]"
k=1
if [ -s cues.tsv ]; then
  while IFS=$'\t' read -r kind start end clipsec intensity audio caption || [ -n "${kind:-}" ]; do
    [ -n "${audio:-}" ] && [ -f "$audio" ] || continue
    k=$((k + 1))
    ms=$(awk -v s="$start" 'BEGIN { printf "%d", s * 1000 }')
    if [ "$kind" = "effect" ]; then
      inputs+=(-i "$audio")
      filter="${filter}[$k:a]volume=0.7,adelay=${ms}:all=1[c$k];"
    else
      # A bed or music runs under its scene: looped, faded at both ends, kept well below the voice.
      stop="${end:-$total}"
      len=$(awk -v s="$start" -v e="$stop" 'BEGIN { l = e - s; if (l < 1) l = 1; printf "%.3f", l }')
      out=$(awk -v l="$len" 'BEGIN { o = l - 1.5; if (o < 0) o = 0; printf "%.3f", o }')
      level=$(awk -v i="${intensity:-0.5}" -v m="$kind" 'BEGIN { if (i == "") i = 0.5; v = (m == "music" ? 0.16 : 0.20) * (0.5 + i); printf "%.3f", v }')
      inputs+=(-stream_loop -1 -i "$audio")
      filter="${filter}[$k:a]atrim=0:${len},afade=t=in:d=1,afade=t=out:st=${out}:d=1.5,volume=${level},adelay=${ms}:all=1[c$k];"
    fi
    mix="${mix}[c$k]"
  done < cues.tsv
fi
if [ "$k" -gt 1 ]; then
  audio_graph="${filter}${mix}amix=inputs=${k}:normalize=0:duration=first[a]"
else
  audio_graph="[1:a]anull[a]"
fi

# ── 4. picture + sound + subtitles ───────────────────────────────────────────
# Burnt into the picture where this ffmpeg can draw text (it needs the
# `subtitles` filter, i.e. a build with libass — many builds have none);
# otherwise carried as a subtitle track, which players can switch on.
if [ -s subtitles.srt ] && ffmpeg -hide_banner -filters 2>/dev/null | grep -q ' subtitles '; then
  # The track is carried as well: players and the Studio read the words from it.
  ffmpeg -nostdin -hide_banner -loglevel error -y "${inputs[@]}" -i subtitles.srt \
    -filter_complex "${audio_graph};[0:v]format=yuv420p,subtitles=subtitles.srt:force_style='FontName=${FONT},FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,MarginV=36'[v]" \
    -map "[v]" -map "[a]" -map "$((k + 1)):s" -t "$total" \
    -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -r "$FPS" \
    -c:a aac -b:a 160k -ar 48000 -ac 2 -c:s mov_text -movflags +faststart "$OUT"
  echo "subtitles: burnt in, and as a track (hand the video in with burned=true)"
elif [ -s subtitles.srt ]; then
  ffmpeg -nostdin -hide_banner -loglevel error -y "${inputs[@]}" -i subtitles.srt \
    -filter_complex "${audio_graph}" \
    -map 0:v -map "[a]" -map "$((k + 1)):s" -t "$total" \
    -c:v copy -c:a aac -b:a 160k -ar 48000 -ac 2 -c:s mov_text -movflags +faststart "$OUT"
  echo "subtitles: as a track only — this ffmpeg has no 'subtitles' filter, so the words are NOT in the picture (the skill's 'Words in the picture' says how they can still get there)"
else
  ffmpeg -nostdin -hide_banner -loglevel error -y "${inputs[@]}" \
    -filter_complex "${audio_graph}" \
    -map 0:v -map "[a]" -t "$total" \
    -c:v copy -c:a aac -b:a 160k -ar 48000 -ac 2 -movflags +faststart "$OUT"
fi
echo "wrote $OUT ($(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT") s)"
