#!/usr/bin/env bash
# md4x dogfooding hook handler.
#
# Triggered by Claude Code PostToolUse on Write|Edit (configured in
# .claude/settings.json). Reads the hook input JSON from stdin; if the
# edited file is a markdown file anywhere under a /docs/ directory,
# runs scripts/md-to-pdf.sh to generate a sibling .pdf.
#
# Configured async in settings.json so it doesn't block Claude.
# All errors are swallowed — the hook must never crash the session.

set -euo pipefail

# Extract file path from hook input JSON (stdin)
file=$(jq -r '.tool_input.file_path // .tool_response.filePath // empty')
[[ -n "$file" ]] || exit 0

# Filter: file must be under /docs/ AND end in .md (any depth allowed)
[[ "$file" =~ /docs/.+\.md$ ]] || exit 0

# File must exist (could have been deleted right after Write)
[[ -f "$file" ]] || exit 0

# Find the repo root and the conversion script
root=$(git -C "$(dirname "$file")" rev-parse --show-toplevel 2>/dev/null) || exit 0
script="$root/scripts/md-to-pdf.sh"
[[ -x "$script" ]] || exit 0

output="${file%.md}.pdf"
"$script" "$file" "$output" >/dev/null 2>&1
