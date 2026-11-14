#!/bin/sh
# A sound card that plays into nothing, for machines that have none (CI runners, containers). Chromium keeps
# time without one, but Firefox and WebKit only run their audio clock when there is somewhere for the sound to go.
set -e
if ! command -v pulseaudio >/dev/null 2>&1; then
  sudo=$(command -v sudo || true)
  $sudo apt-get update -qq
  DEBIAN_FRONTEND=noninteractive $sudo apt-get install -y -qq pulseaudio
fi
pulseaudio --check 2>/dev/null || pulseaudio -D --exit-idle-time=-1
sleep 1
pactl load-module module-null-sink sink_name=silent >/dev/null
pactl set-default-sink silent
echo "virtual sound card ready"
