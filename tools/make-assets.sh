#!/usr/bin/env bash
#
# Bygger allt testmaterial i assets/: demospåret (wav + mp3) och sex korta
# videoloopar. Materialet är gitignorerat och återskapas bitidentiskt av det
# här skriptet — allt är syntetiskt, seedat och utan externa nedladdningar.
#
#   bash tools/make-assets.sh            hoppar över filer som redan finns
#   bash tools/make-assets.sh --force    bygger om allt
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ASSETS="$ROOT/assets"

FPS=30
CLIP_SECONDS=4
CLIP_SIZE=640x360

FORCE=0
for arg in "$@"; do
  case "$arg" in
    -f|--force) FORCE=1 ;;
    -h|--hjälp|--help)
      sed -n '3,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Okänd flagga: $arg (använd --force eller --hjälp)" >&2
      exit 2
      ;;
  esac
done

krävs() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "FEL: '$1' hittades inte i PATH. $2" >&2
    exit 1
  fi
}

krävs python3 "Installera Python 3 — spåret syntetiseras med enbart stdlib."
krävs ffmpeg  "Installera ffmpeg, t.ex. 'brew install ffmpeg'."
krävs ffprobe "ffprobe följer med ffmpeg — kontrollera installationen."

mkdir -p "$ASSETS"

byggda=0
hoppade=0

# Ska filen byggas? Nej om den finns och --force saknas.
behövs() {
  if [ -f "$1" ] && [ "$FORCE" -eq 0 ]; then
    hoppade=$((hoppade + 1))
    return 1
  fi
  return 0
}

# ------------------------------------------------------------------ ljudet

if behövs "$ASSETS/track.wav"; then
  echo "Syntetiserar track.wav …"
  python3 "$ROOT/tools/make_track.py" "$ASSETS/track.wav" >/dev/null
  byggda=$((byggda + 1))
  # Ny wav ⇒ mp3:n är inaktuell.
  rm -f "$ASSETS/track.mp3"
fi

if behövs "$ASSETS/track.mp3"; then
  echo "Kodar track.mp3 (192 kbit/s) …"
  ffmpeg -hide_banner -loglevel error -y \
    -fflags +bitexact \
    -i "$ASSETS/track.wav" \
    -c:a libmp3lame -b:a 192k \
    -flags:a +bitexact -map_metadata -1 \
    "$ASSETS/track.mp3"
  byggda=$((byggda + 1))
fi

# ---------------------------------------------------------------- klippen
#
# Sex lavfi-källor som är visuellt olika men går ihop i samma musikvideo:
# hårda testrutor, fraktal, cellulära automater, mjuka gradienter och ett
# roterande färgfält. Allt är deterministiskt — fasta seeds där filtret har
# stöd för det, i övrigt rena funktioner av tiden.

CLIP_NAMES=(
  "clip-01.mp4"
  "clip-02.mp4"
  "clip-03.mp4"
  "clip-04.mp4"
  "clip-05.mp4"
  "clip-06.mp4"
)

CLIP_SRC=(
  "testsrc2=size=$CLIP_SIZE:rate=$FPS:duration=$CLIP_SECONDS"
  "mandelbrot=size=$CLIP_SIZE:rate=$FPS:start_scale=3:end_scale=0.03:end_pts=120:maxiter=600:inner=period:outer=iteration_count"
  "life=size=214x120:rate=$FPS:seed=42:ratio=0.22:mold=12:life_color=#3cffb4:death_color=#04241c:mold_color=#0a4438"
  "cellauto=size=$CLIP_SIZE:rate=$FPS:rule=110:random_seed=7:ratio=0.35:scroll=1"
  "gradients=size=$CLIP_SIZE:rate=$FPS:seed=11:nb_colors=4:c0=#ff2d55:c1=#08123a:c2=#00e5ff:c3=#150026:speed=0.06:type=spiral:duration=$CLIP_SECONDS"
  "rgbtestsrc=size=1024x1024:rate=$FPS:duration=$CLIP_SECONDS"
)

CLIP_VF=(
  "hue=H=0.6*t:s=1.35,eq=contrast=1.12"
  "eq=saturation=1.5:contrast=1.1"
  "scale=640:360:flags=neighbor"
  "colorchannelmixer=rr=1:gg=0.22:bb=0.62"
  "eq=saturation=1.15:contrast=1.05"
  "rotate=a=0.55*t:ow=640:oh=360:c=black,hue=H=1.6*t:s=1.2,eq=contrast=1.1"
)

CLIP_DESC=(
  "testruta med roterande nyans"
  "mandelbrot som zoomar in"
  "Game of Life, grönt raster"
  "cellulär automat, regel 110"
  "spiralgradient, rosa mot cyan"
  "roterande färgfält"
)

for i in 0 1 2 3 4 5; do
  ut="$ASSETS/${CLIP_NAMES[$i]}"
  behövs "$ut" || continue
  echo "Renderar ${CLIP_NAMES[$i]} — ${CLIP_DESC[$i]} …"
  ffmpeg -hide_banner -loglevel error -y \
    -fflags +bitexact \
    -f lavfi -i "${CLIP_SRC[$i]}" \
    -t "$CLIP_SECONDS" -r "$FPS" \
    -vf "${CLIP_VF[$i]}" \
    -c:v libx264 -crf 20 -preset veryfast -pix_fmt yuv420p \
    -an -movflags +faststart -flags:v +bitexact -map_metadata -1 \
    "$ut"
  byggda=$((byggda + 1))
done

# ---------------------------------------------------------- sammanfattning

längd() {
  ffprobe -v error -show_entries format=duration -of csv=p=0 "$1" \
    | awk '{ printf "%.1f", $1 }'
}

storlek() {
  ls -l "$1" | awk '{ printf "%.1f MiB", $5 / 1048576 }'
}

echo
echo "Testmaterial i $ASSETS"
printf '  %-14s %8s %10s  %s\n' "fil" "längd" "storlek" "innehåll"
printf '  %-14s %8s %10s  %s\n' "track.wav" "$(längd "$ASSETS/track.wav") s" \
  "$(storlek "$ASSETS/track.wav")" "128 BPM, 32 takter, 44,1 kHz stereo"
printf '  %-14s %8s %10s  %s\n' "track.mp3" "$(längd "$ASSETS/track.mp3") s" \
  "$(storlek "$ASSETS/track.mp3")" "samma spår, 192 kbit/s"
for i in 0 1 2 3 4 5; do
  fil="$ASSETS/${CLIP_NAMES[$i]}"
  printf '  %-14s %8s %10s  %s\n' "${CLIP_NAMES[$i]}" "$(längd "$fil") s" \
    "$(storlek "$fil")" "${CLIP_DESC[$i]}"
done
echo
echo "  $byggda byggda, $hoppade oförändrade (bygg om allt med --force)."
echo "  Oscillatorernas band står i assets/README.md."
