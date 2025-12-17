#!/bin/bash

# Install Vivid VS Code extension locally

set -e

cd "$(dirname "$0")"

echo "Installing dependencies..."
npm install

echo "Packaging extension..."
npm run package

VSIX_FILE=$(ls -t *.vsix 2>/dev/null | head -1)

if [ -z "$VSIX_FILE" ]; then
    echo "Error: No .vsix file found"
    exit 1
fi

echo "Installing $VSIX_FILE..."
code --install-extension "$VSIX_FILE"

echo "Done! Restart VS Code to use the extension."
