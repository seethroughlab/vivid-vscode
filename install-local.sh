#!/bin/bash

# Install Vivid VS Code extension locally

set -e

cd "$(dirname "$0")"

echo "Installing dependencies..."
npm install

# Derive version from latest git tag + "-dev" suffix
GIT_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0")
VERSION="${GIT_TAG#v}-dev"
echo "Setting version to $VERSION..."
npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null

echo "Cleaning old build..."
rm -rf out/*.js out/*.js.map out/mcp

echo "Building extension..."
npm run esbuild

echo "Packaging extension..."
npm run package

# Restore package.json to dev version
git checkout package.json package-lock.json 2>/dev/null || true

VSIX_FILE=$(ls -t *.vsix 2>/dev/null | head -1)

if [ -z "$VSIX_FILE" ]; then
    echo "Error: No .vsix file found"
    exit 1
fi

echo "Installing $VSIX_FILE..."
code --install-extension "$VSIX_FILE" --force

echo "Done! Restart VS Code to use the extension."
