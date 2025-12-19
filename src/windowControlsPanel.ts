import * as vscode from 'vscode';
import { WindowState } from './runtimeClient';

export class WindowControlsPanelProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'vividWindowControls';

    private _view?: vscode.WebviewView;
    private _state?: WindowState;
    private _onWindowControl?: (setting: string, value: number) => void;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public setWindowControlHandler(handler: (setting: string, value: number) => void) {
        this._onWindowControl = handler;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Handle messages from webview
        webviewView.webview.onDidReceiveMessage(message => {
            if (message.type === 'control' && this._onWindowControl) {
                this._onWindowControl(message.setting, message.value);
            }
        });

        // Send initial state if available
        if (this._state) {
            this.updateState(this._state);
        }
    }

    public updateState(state: WindowState) {
        this._state = state;
        if (this._view) {
            this._view.webview.postMessage({ type: 'update', state });
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Window Controls</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-sideBar-background);
            padding: 8px;
            margin: 0;
        }
        .section {
            margin-bottom: 12px;
        }
        .section-title {
            font-weight: bold;
            margin-bottom: 6px;
            font-size: 11px;
            text-transform: uppercase;
            color: var(--vscode-sideBarSectionHeader-foreground);
        }
        .toggle-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
            padding: 4px 0;
        }
        .toggle-label {
            color: var(--vscode-foreground);
        }
        .toggle-switch {
            position: relative;
            width: 36px;
            height: 18px;
            background-color: var(--vscode-input-background);
            border-radius: 9px;
            cursor: pointer;
            transition: background-color 0.2s;
            border: 1px solid var(--vscode-input-border);
        }
        .toggle-switch.active {
            background-color: var(--vscode-button-background);
        }
        .toggle-switch::after {
            content: '';
            position: absolute;
            top: 2px;
            left: 2px;
            width: 12px;
            height: 12px;
            background-color: var(--vscode-foreground);
            border-radius: 50%;
            transition: transform 0.2s;
        }
        .toggle-switch.active::after {
            transform: translateX(18px);
        }
        .monitor-select {
            width: 100%;
            padding: 6px 8px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            cursor: pointer;
        }
        .monitor-select:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        .monitor-info {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
        }
        .no-data {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            text-align: center;
            padding: 20px;
        }
    </style>
</head>
<body>
    <div id="content">
        <div class="no-data">Waiting for runtime connection...</div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let currentState = null;

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'update') {
                currentState = message.state;
                updateDisplay(message.state);
            }
        });

        function updateDisplay(state) {
            const content = document.getElementById('content');

            const monitorsHtml = state.monitors.map(m =>
                \`<option value="\${m.index}" \${m.index === state.currentMonitor ? 'selected' : ''}>
                    \${m.name} (\${m.width}x\${m.height})
                </option>\`
            ).join('');

            content.innerHTML = \`
                <div class="section">
                    <div class="section-title">Display Mode</div>
                    <div class="toggle-row">
                        <span class="toggle-label">Fullscreen</span>
                        <div class="toggle-switch \${state.fullscreen ? 'active' : ''}"
                             onclick="toggleSetting('fullscreen', \${!state.fullscreen})"></div>
                    </div>
                    <div class="toggle-row">
                        <span class="toggle-label">Borderless</span>
                        <div class="toggle-switch \${state.borderless ? 'active' : ''}"
                             onclick="toggleSetting('borderless', \${!state.borderless})"></div>
                    </div>
                    <div class="toggle-row">
                        <span class="toggle-label">Always on Top</span>
                        <div class="toggle-switch \${state.alwaysOnTop ? 'active' : ''}"
                             onclick="toggleSetting('alwaysOnTop', \${!state.alwaysOnTop})"></div>
                    </div>
                </div>

                <div class="section">
                    <div class="section-title">Cursor</div>
                    <div class="toggle-row">
                        <span class="toggle-label">Cursor Visible</span>
                        <div class="toggle-switch \${state.cursorVisible ? 'active' : ''}"
                             onclick="toggleSetting('cursorVisible', \${!state.cursorVisible})"></div>
                    </div>
                </div>

                <div class="section">
                    <div class="section-title">Monitor</div>
                    <select class="monitor-select" onchange="selectMonitor(this.value)">
                        \${monitorsHtml}
                    </select>
                    <div class="monitor-info">\${state.monitors.length} monitor(s) detected</div>
                </div>
            \`;
        }

        function toggleSetting(setting, value) {
            vscode.postMessage({ type: 'control', setting, value: value ? 1 : 0 });
        }

        function selectMonitor(index) {
            vscode.postMessage({ type: 'control', setting: 'monitor', value: parseInt(index) });
        }
    </script>
</body>
</html>`;
    }
}
