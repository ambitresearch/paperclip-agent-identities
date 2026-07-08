#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="${PAPERCLIP_TRUENAS_HOST:-root@truenas.local}"
REMOTE_PLUGIN_PATH="${PAPERCLIP_AGENT_IDENTITIES_PLUGIN_PATH:-${PAPERCLIP_GITHUB_BOT_PLUGIN_PATH:-/mnt/aether/paperclip-data/app/.paperclip/github-bot-identity/dev-dropdown-plugin-fallback-20260706-062302}}"
DEV_PACKAGE_NAME="${PAPERCLIP_AGENT_IDENTITIES_DEV_PACKAGE_NAME:-${PAPERCLIP_GITHUB_BOT_DEV_PACKAGE_NAME:-@gautamroshan/paperclip-agent-identities-dev-dropdown}}"
DEV_MANIFEST_ID="${PAPERCLIP_AGENT_IDENTITIES_DEV_MANIFEST_ID:-${PAPERCLIP_GITHUB_BOT_DEV_MANIFEST_ID:-roshangautam.paperclip-github-bot-identity-dev-dropdown}}"
DEV_VERSION="${PAPERCLIP_AGENT_IDENTITIES_DEV_VERSION:-${PAPERCLIP_GITHUB_BOT_DEV_VERSION:-0.1.3-dev.1}}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-agent-identities.XXXXXX")"

cleanup() {
  rm -rf "$STAGE_DIR"
}
trap cleanup EXIT

cd "$ROOT_DIR"
pnpm build

mkdir -p "$STAGE_DIR"
rsync -a --delete dist README.md pnpm-lock.yaml package.json "$STAGE_DIR/"

STAGE_DIR="$STAGE_DIR" \
DEV_PACKAGE_NAME="$DEV_PACKAGE_NAME" \
DEV_MANIFEST_ID="$DEV_MANIFEST_ID" \
DEV_VERSION="$DEV_VERSION" \
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const stage = process.env.STAGE_DIR;
const packageName = process.env.DEV_PACKAGE_NAME;
const manifestId = process.env.DEV_MANIFEST_ID;
const version = process.env.DEV_VERSION;

const packagePath = `${stage}/package.json`;
const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
pkg.name = packageName;
pkg.version = version;
writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

for (const file of [`${stage}/dist/manifest.js`, `${stage}/dist/manifest.js.map`]) {
  if (!existsSync(file)) continue;
  const original = readFileSync(file, "utf8");
  const sourceManifestId = original.includes("roshangautam.paperclip-agent-identities")
    ? "roshangautam.paperclip-agent-identities"
    : "roshangautam.paperclip-github-bot-identity";
  const updated = original
    .replaceAll(sourceManifestId, manifestId)
    .replaceAll('"version":"0.1.3"', `"version":"${version}"`)
    .replaceAll('version: "0.1.3"', `version: "${version}"`);
  writeFileSync(file, updated);
}
NODE

rsync -az --delete-delay --delay-updates "$STAGE_DIR/" "$REMOTE_HOST:$REMOTE_PLUGIN_PATH/"
ssh -o BatchMode=yes "$REMOTE_HOST" \
  "set -e; real=\$(readlink -f '$REMOTE_PLUGIN_PATH'); chown -R 1000:1000 \"\$real\"; chmod -R u+rwX,g+rwX,o-rwx \"\$real\"; docker exec ix-paperclip-server-1 node -e 'import(\"/paperclip/.paperclip/github-bot-identity/dev-dropdown-plugin-fallback-20260706-062302/dist/manifest.js?t=\"+Date.now()).then(m=>console.log(JSON.stringify({id:m.default.id,displayName:m.default.displayName,version:m.default.version})))'"

echo "Synced $DEV_MANIFEST_ID@$DEV_VERSION to $REMOTE_HOST:$REMOTE_PLUGIN_PATH"
