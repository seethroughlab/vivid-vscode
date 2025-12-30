// Operator Library Panel - sidebar webview for browsing and adding operators

import * as vscode from 'vscode';
import { OperatorCatalog, OperatorDefinition } from './operatorCatalog';

export class OperatorLibraryPanel implements vscode.WebviewViewProvider {
    public static readonly viewType = 'vividOperatorLibrary';

    private _view?: vscode.WebviewView;
    private _catalog?: OperatorCatalog;
    private _isLoading = false;
    private _loadError?: string;

    private _onOperatorSelected: ((operator: OperatorDefinition) => void) | undefined;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlContent();

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(message => {
            switch (message.type) {
                case 'selectOperator':
                    const operator = this._catalog?.getOperator(message.name);
                    if (operator && this._onOperatorSelected) {
                        this._onOperatorSelected(operator);
                    }
                    break;
                case 'refresh':
                    // Trigger a refresh of the catalog
                    vscode.commands.executeCommand('vivid.refreshOperatorLibrary');
                    break;
            }
        });

        // Send initial data if catalog is loaded
        this._updateWebview();

        // If catalog isn't loaded yet, trigger a refresh
        if (!this._catalog || !this._catalog.isLoaded()) {
            vscode.commands.executeCommand('vivid.refreshOperatorLibrary');
        }
    }

    public setCatalog(catalog: OperatorCatalog) {
        this._catalog = catalog;
        this._updateWebview();
    }

    public setLoading(loading: boolean) {
        this._isLoading = loading;
        this._loadError = undefined;
        this._updateWebview();
    }

    public setLoadError(error: string) {
        this._isLoading = false;
        this._loadError = error;
        this._updateWebview();
    }

    public onOperatorSelected(callback: (operator: OperatorDefinition) => void) {
        this._onOperatorSelected = callback;
    }

    private _updateWebview() {
        if (!this._view) return;

        if (this._isLoading) {
            this._view.webview.postMessage({
                type: 'loading'
            });
            return;
        }

        if (this._loadError) {
            this._view.webview.postMessage({
                type: 'error',
                message: this._loadError
            });
            return;
        }

        if (!this._catalog || !this._catalog.isLoaded()) {
            this._view.webview.postMessage({
                type: 'empty'
            });
            return;
        }

        // Build categories and operators
        const categories = this._catalog.getCategories();
        const data: { name: string; operators: OperatorDefinition[] }[] = [];

        for (const cat of categories) {
            data.push({
                name: cat,
                operators: this._catalog.getOperatorsByCategory(cat)
            });
        }

        this._view.webview.postMessage({
            type: 'update',
            categories: data
        });
    }

    private _getHtmlContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Operator Library</title>
    <style>
        :root {
            --vscode-font-family: var(--vscode-editor-font-family, system-ui);
        }
        body {
            font-family: var(--vscode-font-family);
            padding: 0;
            margin: 0;
            color: var(--vscode-foreground);
            background: var(--vscode-sideBar-background);
        }
        .toolbar {
            padding: 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
            position: sticky;
            top: 0;
            background: var(--vscode-sideBar-background);
            z-index: 10;
        }
        .search-box {
            width: 100%;
            box-sizing: border-box;
            padding: 6px 8px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            font-size: 12px;
        }
        .search-box::placeholder {
            color: var(--vscode-input-placeholderForeground);
        }
        .content {
            padding: 0;
        }
        .category {
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .category-header {
            display: flex;
            align-items: center;
            padding: 8px 12px;
            cursor: pointer;
            user-select: none;
            font-weight: 500;
            font-size: 12px;
            background: var(--vscode-sideBarSectionHeader-background);
        }
        .category-header:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .category-icon {
            margin-right: 6px;
            font-size: 10px;
            transition: transform 0.2s;
        }
        .category.collapsed .category-icon {
            transform: rotate(-90deg);
        }
        .category-count {
            margin-left: auto;
            font-size: 11px;
            opacity: 0.6;
        }
        .category-content {
            padding: 4px 0;
        }
        .category.collapsed .category-content {
            display: none;
        }
        .operator-card {
            display: flex;
            flex-direction: column;
            padding: 6px 12px 6px 24px;
            cursor: pointer;
            border-left: 2px solid transparent;
        }
        .operator-card:hover {
            background: var(--vscode-list-hoverBackground);
            border-left-color: var(--vscode-focusBorder);
        }
        .operator-card.dragging {
            opacity: 0.5;
        }
        .operator-name {
            font-size: 12px;
            font-weight: 500;
        }
        .operator-desc {
            font-size: 11px;
            opacity: 0.7;
            margin-top: 2px;
        }
        .operator-badge {
            display: inline-block;
            font-size: 9px;
            padding: 1px 4px;
            border-radius: 3px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            margin-left: 6px;
            vertical-align: middle;
        }
        .operator-badge.effect {
            background: var(--vscode-charts-purple);
        }
        .operator-badge.addon {
            background: var(--vscode-charts-orange);
        }
        .empty-state {
            text-align: center;
            padding: 40px 20px;
            opacity: 0.6;
            font-size: 12px;
        }
        .empty-state button {
            margin-top: 12px;
            padding: 6px 12px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }
        .empty-state button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .loading {
            text-align: center;
            padding: 40px 20px;
            opacity: 0.6;
            font-size: 12px;
        }
        .spinner {
            display: inline-block;
            width: 20px;
            height: 20px;
            border: 2px solid var(--vscode-foreground);
            border-radius: 50%;
            border-top-color: transparent;
            animation: spin 1s linear infinite;
            margin-bottom: 8px;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        .error-state {
            text-align: center;
            padding: 40px 20px;
            color: var(--vscode-errorForeground);
            font-size: 12px;
        }
        .no-results {
            text-align: center;
            padding: 20px;
            opacity: 0.6;
            font-size: 12px;
        }
    </style>
</head>
<body>
    <div class="toolbar">
        <input type="text" class="search-box" placeholder="Search operators..." id="searchInput">
    </div>
    <div class="content" id="content">
        <div class="empty-state">
            <p>Operator library not loaded</p>
            <button onclick="refresh()">Load Operators</button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let categories = [];
        let searchQuery = '';
        let collapsedCategories = new Set();

        // Restore state
        const state = vscode.getState() || {};
        if (state.collapsedCategories) {
            collapsedCategories = new Set(state.collapsedCategories);
        }

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'update':
                    categories = message.categories || [];
                    render();
                    break;
                case 'loading':
                    showLoading();
                    break;
                case 'error':
                    showError(message.message);
                    break;
                case 'empty':
                    showEmpty();
                    break;
            }
        });

        document.getElementById('searchInput').addEventListener('input', (e) => {
            searchQuery = e.target.value.toLowerCase();
            render();
        });

        function render() {
            const content = document.getElementById('content');

            if (categories.length === 0) {
                showEmpty();
                return;
            }

            let html = '';
            let hasResults = false;

            for (const cat of categories) {
                // Filter operators by search query
                const filteredOps = cat.operators.filter(op => {
                    if (!searchQuery) return true;
                    return op.name.toLowerCase().includes(searchQuery) ||
                           op.description.toLowerCase().includes(searchQuery);
                });

                if (filteredOps.length === 0) continue;
                hasResults = true;

                const isCollapsed = collapsedCategories.has(cat.name);
                html += \`
                    <div class="category \${isCollapsed ? 'collapsed' : ''}" data-category="\${escapeHtml(cat.name)}">
                        <div class="category-header" onclick="toggleCategory('\${escapeHtml(cat.name)}')">
                            <span class="category-icon">▼</span>
                            <span>\${escapeHtml(cat.name)}</span>
                            <span class="category-count">\${filteredOps.length}</span>
                        </div>
                        <div class="category-content">
                \`;

                for (const op of filteredOps) {
                    const badges = [];
                    if (op.requiresInput) {
                        badges.push('<span class="operator-badge effect">effect</span>');
                    }
                    if (op.addon) {
                        badges.push(\`<span class="operator-badge addon">\${escapeHtml(op.addon)}</span>\`);
                    }

                    html += \`
                        <div class="operator-card"
                             onclick="selectOperator('\${escapeHtml(op.name)}')"
                             draggable="true"
                             ondragstart="onDragStart(event, '\${escapeHtml(op.name)}')"
                             ondragend="onDragEnd(event)">
                            <div class="operator-name">
                                \${escapeHtml(op.name)}
                                \${badges.join('')}
                            </div>
                            <div class="operator-desc">\${escapeHtml(op.description)}</div>
                        </div>
                    \`;
                }

                html += '</div></div>';
            }

            if (!hasResults && searchQuery) {
                html = '<div class="no-results">No operators match your search</div>';
            }

            content.innerHTML = html;
        }

        function showLoading() {
            document.getElementById('content').innerHTML = \`
                <div class="loading">
                    <div class="spinner"></div>
                    <p>Loading operators...</p>
                </div>
            \`;
        }

        function showEmpty() {
            document.getElementById('content').innerHTML = \`
                <div class="empty-state">
                    <p>Operator library not loaded</p>
                    <button onclick="refresh()">Load Operators</button>
                </div>
            \`;
        }

        function showError(message) {
            document.getElementById('content').innerHTML = \`
                <div class="error-state">
                    <p>Failed to load operators</p>
                    <p style="font-size: 11px; opacity: 0.8">\${escapeHtml(message)}</p>
                    <button onclick="refresh()" style="margin-top: 12px; padding: 6px 12px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer;">Retry</button>
                </div>
            \`;
        }

        function toggleCategory(name) {
            if (collapsedCategories.has(name)) {
                collapsedCategories.delete(name);
            } else {
                collapsedCategories.add(name);
            }
            // Save state
            vscode.setState({ collapsedCategories: Array.from(collapsedCategories) });
            render();
        }

        function selectOperator(name) {
            vscode.postMessage({
                type: 'selectOperator',
                name: name
            });
        }

        function refresh() {
            vscode.postMessage({ type: 'refresh' });
        }

        // Drag and drop support
        function onDragStart(event, operatorName) {
            event.dataTransfer.setData('application/vnd.vivid.operator', operatorName);
            event.dataTransfer.setData('text/plain', operatorName);
            event.dataTransfer.effectAllowed = 'copy';
            event.target.classList.add('dragging');
        }

        function onDragEnd(event) {
            event.target.classList.remove('dragging');
        }

        function escapeHtml(str) {
            if (!str) return '';
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        }
    </script>
</body>
</html>`;
    }
}
