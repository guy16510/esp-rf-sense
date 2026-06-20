#!/bin/sh
set -eu

data_dir="${RF_SENSE_DATA_DIR:-/data}"
recordings_dir="${RF_SENSE_RECORDINGS_DIR:-${data_dir}/recordings}"
model_path="${RF_SENSE_MODEL_PATH:-${data_dir}/models/dashboard-position.json}"

mkdir -p "$recordings_dir" "$(dirname "$model_path")"

set -- node apps/dashboard/dist/four-node-cli.js \
  --udp-host "${RF_SENSE_UDP_HOST:-0.0.0.0}" \
  --udp-port "${RF_SENSE_UDP_PORT:-5566}" \
  --http-host "${RF_SENSE_HTTP_HOST:-0.0.0.0}" \
  --http-port "${RF_SENSE_HTTP_PORT:-8080}" \
  --required-nodes "${RF_SENSE_REQUIRED_NODES:-4}" \
  --min-frame-rate "${RF_SENSE_MIN_FRAME_RATE:-5}" \
  --interval-ms "${RF_SENSE_INTERVAL_MS:-200}" \
  --recordings-dir "$recordings_dir" \
  --model-path "$model_path" \
  --slot-a "${RF_SENSE_SLOT_A:-2f4b47f0}" \
  --slot-b "${RF_SENSE_SLOT_B:-2f4b5390}" \
  --slot-c "${RF_SENSE_SLOT_C:-2f4b735c}" \
  --slot-d "${RF_SENSE_SLOT_D:-2f77883c}"

if [ "${RF_SENSE_AUTO_LOAD_MODEL:-true}" = "true" ] && [ -f "$model_path" ]; then
  set -- "$@" --model "$model_path"
fi

exec "$@"
