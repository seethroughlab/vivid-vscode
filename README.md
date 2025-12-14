# Vivid VS Code Extension

VS Code support for the [Vivid](https://github.com/seethroughlab/vivid) creative coding framework.

## Features

- **Auto-Download Runtime**: Automatically downloads the Vivid runtime on first use
- **Compile Error Diagnostics**: GCC/Clang errors shown in Problems panel with jump-to-location
- **Operator Tree View**: Browse chain operators in the sidebar
- **Node Inspector**: Edit parameters with live preview
- **Performance Panel**: FPS, frame time, and per-operator timing
- **Inline Decorations**: Live values shown next to code
- **WGSL Language Support**: Syntax highlighting for shader files

## Installation

### For Users

**From VS Code Marketplace** (Recommended):
1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X / Cmd+Shift+X)
3. Search for "Vivid"
4. Click Install

**From VSIX file**:
1. Download the `.vsix` file from [Releases](https://github.com/seethroughlab/vivid-vscode/releases)
2. In VS Code: Extensions → ⋯ → Install from VSIX...
3. Select the downloaded file

The extension will automatically download the Vivid runtime when you first run it.

### For Developers

```bash
# Clone the repository
git clone https://github.com/seethroughlab/vivid-vscode.git
cd vivid-vscode

# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Launch in development mode
# Press F5 in VS Code, or:
code --extensionDevelopmentPath=$(pwd)
```

**Using a local Vivid build**:

If you're developing Vivid itself, set the runtime path in settings:
```json
{
  "vivid.runtimePath": "/path/to/vivid/build/bin/vivid"
}
```

This bypasses the auto-download and uses your local build.

## How It Works

### Runtime Auto-Download

When you run "Vivid: Start Runtime" without a custom `runtimePath`:

1. Extension checks `~/.vivid/bin/vivid`
2. If missing, prompts to download from [GitHub Releases](https://github.com/seethroughlab/vivid/releases)
3. Downloads the correct archive for your platform:
   - `vivid-darwin-arm64.tar.gz` (macOS Apple Silicon)
   - `vivid-darwin-x64.tar.gz` (macOS Intel)
   - `vivid-win32-x64.zip` (Windows)
   - `vivid-linux-x64.tar.gz` (Linux)
4. Extracts to `~/.vivid/`
5. Tracks version in `~/.vivid/version.json`

### Update Checking

- On startup (if `vivid.checkUpdatesOnStart` is enabled)
- Manually via "Vivid: Check for Updates" command
- Compares installed version against latest GitHub release

## Commands

| Command | Description |
|---------|-------------|
| `Vivid: Start Runtime` | Launch Vivid (downloads if needed) |
| `Vivid: Stop Runtime` | Stop runtime and disconnect |
| `Vivid: Force Reload` | Trigger hot-reload |
| `Vivid: Check for Updates` | Check for new Vivid releases |
| `Vivid: Reinstall Runtime` | Force re-download of runtime |
| `Vivid: Toggle Inline Decorations` | Show/hide inline value previews |
| `Vivid: Solo Operator` | Preview single operator output |
| `Vivid: Exit Solo Mode` | Return to normal view |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `vivid.runtimePath` | `""` | Custom path to vivid executable (empty = use auto-downloaded) |
| `vivid.websocketPort` | `9876` | WebSocket port for runtime communication |
| `vivid.showInlineDecorations` | `true` | Show inline value previews in editor |
| `vivid.previewSize` | `48` | Thumbnail size in pixels |
| `vivid.autoConnect` | `true` | Auto-connect when opening a Vivid project |
| `vivid.checkUpdatesOnStart` | `true` | Check for runtime updates on activation |

## Views

The extension adds a **Vivid** panel to the Activity Bar with:

- **Operators**: Tree view of all operators in your chain
- **Inspector**: Parameter editor for selected operator
- **Performance**: Real-time FPS and timing metrics

## Troubleshooting

**"Cannot connect to runtime"**
- Ensure the runtime is started (Vivid: Start Runtime)
- Check that port 9876 is not in use
- Look for errors in Output → Vivid

**"No releases found"**
- The Vivid runtime may not have releases yet
- Set `vivid.runtimePath` to a local build

**Runtime crashes on start**
- Check Output → Vivid for error messages
- Try reinstalling: "Vivid: Reinstall Runtime"
- Report issues at [vivid/issues](https://github.com/seethroughlab/vivid/issues)

## Development

```bash
# Watch mode (auto-recompile on changes)
npm run watch

# Lint
npm run lint

# Package as VSIX
npm run package
```

## License

MIT
