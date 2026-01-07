#!/bin/bash

# Remove Vivid VS Code extension and runtime completely

set -e

echo "Uninstalling Vivid VS Code extension..."
code --uninstall-extension seethroughlab.vivid-vscode 2>/dev/null || echo "Extension not installed or already removed"

echo "Removing Vivid runtime directory (~/.vivid)..."
rm -rf ~/.vivid

echo "Done! Vivid has been completely removed."
echo "Restart VS Code to complete the uninstallation."
