#!/bin/zsh
set -e
cd -- "$(dirname -- "$0")"
if [[ ! -d node_modules ]]; then
  npm ci --cache work/npm-cache
fi
npm run setup
npm run dev
