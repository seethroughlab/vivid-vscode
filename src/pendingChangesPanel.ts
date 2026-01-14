import * as vscode from 'vscode';
import { StatusBarManager, PendingChange, VividState } from './statusBar';
import { initParser, findParamValue, applyParamChange } from './cppParser';

export class PendingChangesPanel implements vscode.WebviewViewProvider {
    public static readonly viewType = 'vividPendingChanges';

    private view?: vscode.WebviewView;
    private statusBarManager: StatusBarManager;
    private stateSubscription: vscode.Disposable | null = null;
    private outputChannel: vscode.OutputChannel;
    private extensionUri: vscode.Uri;
    private extensionPath: string;
    private parserReady = false;
    private pendingChanges: PendingChange[] = [];
    private removedIndices: Set<number> = new Set();

    constructor(
        extensionUri: vscode.Uri,
        extensionPath: string,
        statusBarManager: StatusBarManager,
        outputChannel: vscode.OutputChannel
    ) {
        this.extensionUri = extensionUri;
        this.extensionPath = extensionPath;
        this.statusBarManager = statusBarManager;
        this.outputChannel = outputChannel;

        // Initialize parser
        this.initializeParser();

        // Subscribe to state changes
        this.stateSubscription = statusBarManager.onStateChange((state) => {
            this.handleStateChange(state);
        });
    }

    private async initializeParser() {
        this.parserReady = await initParser(this.extensionPath);
        if (this.parserReady) {
            this.outputChannel.appendLine('[PendingChanges] Tree-sitter parser initialized');
        } else {
            this.outputChannel.appendLine('[PendingChanges] Warning: Tree-sitter parser failed to initialize');
        }
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };

        webviewView.webview.html = this.getHtmlContent();

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'apply':
                    await this.applyChanges();
                    break;
                case 'discard':
                    this.discardChanges();
                    break;
                case 'remove':
                    this.removeChange(message.index);
                    break;
                case 'goToLine':
                    this.goToLine(message.line);
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

    private async goToLine(line: number) {
        const chainFiles = await vscode.workspace.findFiles('**/chain.cpp', '**/build/**', 1);
        if (chainFiles.length === 0) {
            return;
        }

        const document = await vscode.workspace.openTextDocument(chainFiles[0]);
        const editor = await vscode.window.showTextDocument(document);

        const position = new vscode.Position(line - 1, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    }

    private async applyChanges() {
        const changesToApply = this.pendingChanges.filter((_, i) => !this.removedIndices.has(i));

        if (changesToApply.length === 0) {
            vscode.window.showWarningMessage('No changes to apply');
            return;
        }

        // Find chain.cpp
        const chainFiles = await vscode.workspace.findFiles('**/chain.cpp', '**/build/**', 1);
        if (chainFiles.length === 0) {
            vscode.window.showErrorMessage('Could not find chain.cpp in workspace');
            return;
        }

        const chainUri = chainFiles[0];
        const document = await vscode.workspace.openTextDocument(chainUri);
        const source = document.getText();
        const edit = new vscode.WorkspaceEdit();

        let appliedCount = 0;
        for (const change of changesToApply) {
            const result = this.applyChange(document, source, edit, change);
            if (result) {
                appliedCount++;
            }
        }

        if (appliedCount > 0) {
            const success = await vscode.workspace.applyEdit(edit);
            if (success) {
                await document.save();
                this.statusBarManager.sendCommitChanges();
                this.outputChannel.appendLine(`[PendingChanges] Applied ${appliedCount} change(s)`);
                vscode.window.showInformationMessage(`Applied ${appliedCount} change(s) to chain.cpp`);
            } else {
                vscode.window.showErrorMessage('Failed to apply changes');
            }
        } else {
            vscode.window.showWarningMessage('No changes could be applied');
        }
    }

    private applyChange(document: vscode.TextDocument, source: string, edit: vscode.WorkspaceEdit, change: PendingChange): boolean {
        const formattedValue = this.formatValue(change.newValue, change.paramType);

        // Try tree-sitter first
        if (this.parserReady) {
            const location = findParamValue(source, change.sourceLine, change.operator, change.param);

            if (location) {
                this.outputChannel.appendLine(
                    `[PendingChanges] Found ${change.operator}.${change.param} at line ${change.sourceLine}: "${location.currentValue}" -> "${formattedValue}"`
                );
                applyParamChange(document, edit, location, formattedValue);
                return true;
            }
        }

        // Fallback to regex
        return this.applyChangeRegex(document, edit, change, formattedValue);
    }

    private applyChangeRegex(document: vscode.TextDocument, edit: vscode.WorkspaceEdit, change: PendingChange, formattedValue: string): boolean {
        const lineIndex = change.sourceLine - 1;
        if (lineIndex < 0 || lineIndex >= document.lineCount) {
            return false;
        }

        const line = document.lineAt(lineIndex);
        const lineText = line.text;
        let newLineText: string | null = null;

        const propPattern = new RegExp(
            `(${this.escapeRegex(change.operator)}\\.${this.escapeRegex(change.param)}\\s*=\\s*)([^;]+)(;)`
        );
        if (propPattern.test(lineText)) {
            newLineText = lineText.replace(propPattern, `$1${formattedValue}$3`);
        }

        if (!newLineText) {
            const methodPattern = new RegExp(
                `(${this.escapeRegex(change.operator)}\\.${this.escapeRegex(change.param)}\\s*\\()([^)]+)(\\))`
            );
            if (methodPattern.test(lineText)) {
                newLineText = lineText.replace(methodPattern, `$1${formattedValue}$3`);
            }
        }

        if (newLineText && newLineText !== lineText) {
            const range = new vscode.Range(lineIndex, 0, lineIndex, lineText.length);
            edit.replace(document.uri, range, newLineText);
            return true;
        }

        return false;
    }

    private formatValue(value: number[], paramType: string): string {
        switch (paramType) {
            case 'Float':
                return this.formatFloat(value[0]);
            case 'Int':
                return Math.round(value[0]).toString();
            case 'Bool':
                return value[0] !== 0 ? 'true' : 'false';
            case 'Vec2':
                return `${this.formatFloat(value[0])}, ${this.formatFloat(value[1])}`;
            case 'Vec3':
                return `${this.formatFloat(value[0])}, ${this.formatFloat(value[1])}, ${this.formatFloat(value[2])}`;
            case 'Vec4':
            case 'Color':
                return `${this.formatFloat(value[0])}, ${this.formatFloat(value[1])}, ${this.formatFloat(value[2])}, ${this.formatFloat(value[3])}`;
            default:
                return this.formatFloat(value[0]);
        }
    }

    private formatFloat(value: number): string {
        const rounded = Math.round(value * 10000) / 10000;
        if (Number.isInteger(rounded)) {
            return `${rounded}.0f`;
        }
        let str = rounded.toString();
        if (!str.includes('.')) {
            str += '.0';
        }
        return str + 'f';
    }

    private escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
        .remove-btn {
            background: none;
            border: none;
            color: var(--vscode-errorForeground);
            cursor: pointer;
            padding: 2px 6px;
            font-size: 14px;
        }
        .remove-btn:hover {
            background: var(--vscode-toolbar-hoverBackground);
        }
        .change-values {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
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
        button {
            flex: 1;
            padding: 6px 12px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
        }
        .apply-btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .apply-btn:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .discard-btn {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .discard-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .line-number {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }
    </style>
</head>
<body>
    <div class="container">
        <div id="empty-state" class="empty-state">
            No pending changes
        </div>
        <div id="changes-list"></div>
        <div id="actions" class="actions" style="display: none;">
            <button class="apply-btn" onclick="apply()">Apply to Code</button>
            <button class="discard-btn" onclick="discard()">Discard</button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        function formatValue(value, paramType) {
            switch (paramType) {
                case 'Float':
                    return value[0].toFixed(2);
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
                    return value[0].toFixed(2);
            }
        }

        function renderChanges(changes) {
            const list = document.getElementById('changes-list');
            const emptyState = document.getElementById('empty-state');
            const actions = document.getElementById('actions');

            if (changes.length === 0) {
                list.innerHTML = '';
                emptyState.style.display = 'block';
                actions.style.display = 'none';
                return;
            }

            emptyState.style.display = 'none';
            actions.style.display = 'flex';

            list.innerHTML = changes.map(change => \`
                <div class="change-item">
                    <div class="change-header">
                        <span class="change-name" onclick="goToLine(\${change.sourceLine})">\${change.operator}.\${change.param}</span>
                        <button class="remove-btn" onclick="remove(\${change.index})">✕</button>
                    </div>
                    <div class="change-values">
                        <span class="old-value">\${formatValue(change.oldValue, change.paramType)}</span>
                        <span class="arrow">→</span>
                        <span class="new-value">\${formatValue(change.newValue, change.paramType)}</span>
                    </div>
                    <div class="line-number">Line \${change.sourceLine}</div>
                </div>
            \`).join('');
        }

        function apply() {
            vscode.postMessage({ command: 'apply' });
        }

        function discard() {
            vscode.postMessage({ command: 'discard' });
        }

        function remove(index) {
            vscode.postMessage({ command: 'remove', index: index });
        }

        function goToLine(line) {
            vscode.postMessage({ command: 'goToLine', line: line });
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
