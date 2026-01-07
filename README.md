# Vivid VS Code Extension

VS Code support for the [Vivid](https://github.com/seethroughlab/vivid) creative coding framework.

## Features

- **Auto-Download Runtime**: Automatically downloads the Vivid runtime on first use
- **Operator Library**: Browse available operators in the sidebar with inline documentation
- **WGSL Language Support**: Syntax highlighting for shader files
- **Claude Code Integration**: MCP server for AI-assisted creative coding

## Installation

### From VS Code Marketplace (Recommended)

1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X / Cmd+Shift+X)
3. Search for "Vivid"
4. Click Install

### From VSIX file

1. Download the `.vsix` file from [Releases](https://github.com/seethroughlab/vivid-vscode/releases)
2. In VS Code: Extensions → ⋯ → Install from VSIX...
3. Select the downloaded file

The extension will automatically download the Vivid runtime when you first use it.

## Commands

| Command | Description |
|---------|-------------|
| `Vivid: Create New Project` | Create a new Vivid project with templates |
| `Vivid: Run Project` | Run the current Vivid project |
| `Vivid: Bundle Project` | Package project as standalone app |
| `Vivid: Check for Updates` | Check for new Vivid releases |
| `Vivid: Download Runtime` | Download the Vivid runtime |
| `Vivid: Reinstall Runtime` | Force re-download of runtime |
| `Vivid: Configure Claude Code Integration` | Set up MCP server for Claude Code |
| `Vivid: Refresh Operator Library` | Refresh the operator library view |
| `Vivid: Show Output` | Show the Vivid output channel |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `vivid.vividRoot` | `""` | Path to vivid source root (for development builds). Leave empty to use auto-downloaded runtime. |
| `vivid.checkUpdatesOnStart` | `true` | Check for runtime updates on activation |

## Views

The extension adds a **Vivid** panel to the Activity Bar with:

- **Operators**: Browse available operators with documentation

## Development

```bash
# Clone the repository
git clone https://github.com/seethroughlab/vivid-vscode.git
cd vivid-vscode

# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Launch in development mode
# Press F5 in VS Code
```

## License

MIT
