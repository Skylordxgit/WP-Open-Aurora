#!/bin/sh

set -eu

target=${1:-.env}
template=${2:-.env.example}

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required to generate AuroraWA secrets" >&2
  exit 1
fi

if [ ! -f "$target" ]; then
  if [ ! -f "$template" ]; then
    echo "Environment template not found: $template" >&2
    exit 1
  fi
  cp "$template" "$target"
fi

set_secret_if_missing() {
  key=$1
  current=$(awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$target")

  case "$current" in
    ""|change-me*|replace-with*|your-*)
      value=$(openssl rand -hex 32)
      temporary="${target}.tmp.$$"
      awk -v key="$key" -v value="$value" '
        BEGIN { found = 0 }
        index($0, key "=") == 1 {
          print key "=" value
          found = 1
          next
        }
        { print }
        END {
          if (!found) print key "=" value
        }
      ' "$target" > "$temporary"
      mv "$temporary" "$target"
      echo "Generated $key"
      ;;
    *)
      echo "Preserved existing $key"
      ;;
  esac
}

set_secret_if_missing DATABASE_PASSWORD
set_secret_if_missing EVOLUTION_GO_API_KEY
set_secret_if_missing EVOLUTION_GO_INSTANCE_TOKEN_SECRET

chmod 600 "$target"
echo "Environment is ready at $target (permissions: 600)"
