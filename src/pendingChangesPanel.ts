import * as vscode from 'vscode';
import { StatusBarManager, PendingChange, VividState } from './statusBar';

export class PendingChangesPanel implements vscode.WebviewViewProvider {
    public static readonly viewType = 'vividPendingChanges';

    private view?: vscode.WebviewView;
    private statusBarManager: StatusBarManager;
    private stateSubscription: vscode.Disposable | null = null;
    private outputChannel: vscode.OutputChannel;
    private extensionUri: vscode.Uri;
    private pendingChanges: PendingChange[] = [];
    private removedIndices: Set<number> = new Set();

    constructor(
        extensionUri: vscode.Uri,
        _extensionPath: string,
        statusBarManager: StatusBarManager,
        outputChannel: vscode.OutputChannel
    ) {
        this.extensionUri = extensionUri;
        this.statusBarManager = statusBarManager;
        this.outputChannel = outputChannel;

        // Subscribe to state changes
        this.stateSubscription = statusBarManager.onStateChange((state) => {
            this.handleStateChange(state);
        });
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };

        webviewView.webview.html = this.getHtmlContent();

        // Re-send state when view becomes visible
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.updateView();
            }
        });

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'copy':
                    this.copyChange(message.index);
                    break;
                case 'discard':
                    this.discardChanges();
                    break;
                case 'remove':
                    this.removeChange(message.index);
                    break;
                case 'goToOperator':
                    this.goToOperator(message.operator);
                    break;
            }
        });

        // Initial update
        this.updateView();
    }

    private handleStateChange(state: VividState) {
        const newChanges = state.pendingChanges;

        // Check if changes have arrived
        if (newChanges.length > 0 && this.pendingChanges.length === 0) {
            // New changes arrived - reveal the panel
            if (this.view) {
                this.view.show?.(true);
            } else {
                // Panel not yet created, focus it to trigger creation
                vscode.commands.executeCommand('vividPendingChanges.focus');
            }
        }

        // Update our local copy
        this.pendingChanges = newChanges;
        this.removedIndices.clear();

        this.updateView();
    }

    private updateView() {
        if (!this.view) {
            return;
        }

        const visibleChanges = this.pendingChanges
            .map((change, index) => ({
                ...change,
                index,
                removed: this.removedIndices.has(index)
            }))
            .filter(c => !c.removed);

        this.view.webview.postMessage({
            type: 'update',
            changes: visibleChanges,
            hasChanges: visibleChanges.length > 0
        });
    }

    private removeChange(index: number) {
        this.removedIndices.add(index);
        this.updateView();
    }

    private async goToOperator(operatorName: string) {
        const chainFiles = await vscode.workspace.findFiles('**/chain.cpp', '**/build/**', 1);
        if (chainFiles.length === 0) {
            return;
        }

        const document = await vscode.workspace.openTextDocument(chainFiles[0]);
        const text = document.getText();

        // Find the chain.add line for this operator
        const pattern = new RegExp(`chain\\.add<[^>]+>\\s*\\(\\s*["']${operatorName}["']`);
        const match = pattern.exec(text);

        if (match) {
            const position = document.positionAt(match.index);
            const editor = await vscode.window.showTextDocument(document);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        }
    }

    private copyChange(index: number) {
        const change = this.pendingChanges[index];
        if (!change) return;

        const formatted = this.formatValueForCode(change.newValue, change.paramType);
        const code = this.buildCodeSnippet(change, formatted);

        vscode.env.clipboard.writeText(code);
        vscode.window.showInformationMessage(`Copied: ${change.operator}.${change.param}`);
    }

    private formatValueForCode(value: number[], paramType: string): string {
        const fmt = (v: number) => {
            const rounded = Math.round(v * 10000) / 10000;
            if (Number.isInteger(rounded)) {
                return `${rounded}.0f`;
            }
            let str = rounded.toString();
            if (!str.includes('.')) {
                str += '.0';
            }
            return str + 'f';
        };

        switch (paramType) {
            case 'Float':
                return fmt(value[0]);
            case 'Int':
                return Math.round(value[0]).toString();
            case 'Bool':
                return value[0] !== 0 ? 'true' : 'false';
            case 'Vec2':
                return `${fmt(value[0])}, ${fmt(value[1])}`;
            case 'Vec3':
                return `${fmt(value[0])}, ${fmt(value[1])}, ${fmt(value[2])}`;
            case 'Vec4':
            case 'Color':
                return `${fmt(value[0])}, ${fmt(value[1])}, ${fmt(value[2])}, ${fmt(value[3])}`;
            default:
                return fmt(value[0]);
        }
    }

    private buildCodeSnippet(change: PendingChange, formattedValue: string): string {
        const isVectorType = ['Vec2', 'Vec3', 'Vec4', 'Color'].includes(change.paramType);
        if (isVectorType) {
            return `${change.operator}.${change.param}.set(${formattedValue});`;
        } else {
            return `${change.operator}.${change.param} = ${formattedValue};`;
        }
    }

    private discardChanges() {
        this.statusBarManager.sendDiscardChanges();
        this.outputChannel.appendLine('[PendingChanges] Discarded pending changes');
        vscode.window.showInformationMessage('Discarded pending changes');
    }

    private getHtmlContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            padding: 0;
            margin: 0;
        }
        .container {
            padding: 10px;
        }
        .empty-state {
            color: var(--vscode-descriptionForeground);
            text-align: center;
            padding: 20px;
        }
        .info-text {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 12px;
            padding: 8px;
            background: var(--vscode-textBlockQuote-background);
            border-radius: 4px;
        }
        .change-item {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 8px;
            margin-bottom: 8px;
        }
        .change-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 4px;
        }
        .change-name {
            font-weight: bold;
            color: var(--vscode-textLink-foreground);
            cursor: pointer;
        }
        .change-name:hover {
            text-decoration: underline;
        }
        .change-buttons {
            display: flex;
            gap: 4px;
        }
        .icon-btn {
            background: none;
            border: none;
            color: var(--vscode-foreground);
            cursor: pointer;
            padding: 2px 6px;
            font-size: 12px;
            opacity: 0.7;
        }
        .icon-btn:hover {
            opacity: 1;
            background: var(--vscode-toolbar-hoverBackground);
        }
        .remove-btn {
            color: var(--vscode-errorForeground);
        }
        .change-values {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            font-family: var(--vscode-editor-font-family);
        }
        .old-value {
            color: var(--vscode-errorForeground);
            text-decoration: line-through;
        }
        .new-value {
            color: var(--vscode-gitDecoration-addedResourceForeground);
        }
        .arrow {
            margin: 0 6px;
        }
        .actions {
            display: flex;
            gap: 8px;
            margin-top: 12px;
            padding-top: 12px;
            border-top: 1px solid var(--vscode-panel-border);
        }
        button.discard-btn {
            flex: 1;
            padding: 6px 12px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        button.discard-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
    </style>
</head>
<body>
    <div class="container">
        <div id="empty-state" class="empty-state">
            No pending changes
        </div>
        <div id="info-text" class="info-text" style="display: none;">
            Adjust parameters in the Inspector or runtime UI. Use Claude Code to apply changes to your code.
        </div>
        <div id="changes-list"></div>
        <div id="actions" class="actions" style="display: none;">
            <button class="discard-btn" onclick="discard()">Discard All</button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        function formatValue(value, paramType) {
            switch (paramType) {
                case 'Float':
                    return value[0].toFixed(3);
                case 'Int':
                    return Math.round(value[0]).toString();
                case 'Bool':
                    return value[0] !== 0 ? 'true' : 'false';
                case 'Vec2':
                    return \`(\${value[0].toFixed(2)}, \${value[1].toFixed(2)})\`;
                case 'Vec3':
                    return \`(\${value[0].toFixed(2)}, \${value[1].toFixed(2)}, \${value[2].toFixed(2)})\`;
                case 'Vec4':
                case 'Color':
                    return \`(\${value[0].toFixed(2)}, \${value[1].toFixed(2)}, \${value[2].toFixed(2)}, \${value[3].toFixed(2)})\`;
                default:
                    return value[0].toFixed(3);
            }
        }

        function renderChanges(changes) {
            const list = document.getElementById('changes-list');
            const emptyState = document.getElementById('empty-state');
            const infoText = document.getElementById('info-text');
            const actions = document.getElementById('actions');

            if (changes.length === 0) {
                list.innerHTML = '';
                emptyState.style.display = 'block';
                infoText.style.display = 'none';
                actions.style.display = 'none';
                return;
            }

            emptyState.style.display = 'none';
            infoText.style.display = 'block';
            actions.style.display = 'flex';

            list.innerHTML = changes.map(change => \`
                <div class="change-item">
                    <div class="change-header">
                        <span class="change-name" onclick="goToOperator('\${change.operator}')">\${change.operator}.\${change.param}</span>
                        <div class="change-buttons">
                            <button class="icon-btn" onclick="copy(\${change.index})" title="Copy code snippet">copy</button>
                            <button class="icon-btn remove-btn" onclick="remove(\${change.index})" title="Remove">✕</button>
                        </div>
                    </div>
                    <div class="change-values">
                        <span class="old-value">\${formatValue(change.oldValue, change.paramType)}</span>
                        <span class="arrow">→</span>
                        <span class="new-value">\${formatValue(change.newValue, change.paramType)}</span>
                    </div>
                </div>
            \`).join('');
        }

        function copy(index) {
            vscode.postMessage({ command: 'copy', index: index });
        }

        function discard() {
            vscode.postMessage({ command: 'discard' });
        }

        function remove(index) {
            vscode.postMessage({ command: 'remove', index: index });
        }

        function goToOperator(operator) {
            vscode.postMessage({ command: 'goToOperator', operator: operator });
        }

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'update') {
                renderChanges(message.changes);
            }
        });
    </script>
</body>
</html>`;
    }

    dispose() {
        if (this.stateSubscription) {
            this.stateSubscription.dispose();
        }
    }
}
