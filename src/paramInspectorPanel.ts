import * as vscode from 'vscode';
import { StatusBarManager, ParamInfo } from './statusBar';

export class ParamInspectorPanel implements vscode.WebviewViewProvider {
    public static readonly viewType = 'vividParamInspector';

    private static instance: ParamInspectorPanel | undefined;
    private view?: vscode.WebviewView;
    private statusBarManager: StatusBarManager;
    private stateSubscription: vscode.Disposable | null = null;
    private paramsSubscription: vscode.Disposable | null = null;
    private extensionUri: vscode.Uri;
    private outputChannel: vscode.OutputChannel;
    private selectedOperator: string | null = null;
    private params: ParamInfo[] = [];
    private isRecording = false;
    private isConnected = false;

    constructor(
        extensionUri: vscode.Uri,
        statusBarManager: StatusBarManager,
        outputChannel: vscode.OutputChannel
    ) {
        this.extensionUri = extensionUri;
        this.statusBarManager = statusBarManager;
        this.outputChannel = outputChannel;
        ParamInspectorPanel.instance = this;

        // Subscribe to param updates
        this.paramsSubscription = statusBarManager.onParams((params) => {
            this.params = params;
            this.updateView();
        });

        // Subscribe to state changes to clear selection on disconnect
        this.stateSubscription = statusBarManager.onStateChange((state) => {
            this.isConnected = state.connected;
            if (!state.connected) {
                this.selectedOperator = null;
                this.params = [];
                this.isRecording = false;
            }
            this.updateView();
        });
    }

    public static getInstance(): ParamInspectorPanel | undefined {
        return ParamInspectorPanel.instance;
    }

    // Called from ChainGraphPanel when user selects a node
    public selectOperator(name: string | null) {
        this.selectedOperator = name;
        this.updateView();

        // Reveal the panel when an operator is selected
        if (name && this.view) {
            this.view.show?.(true);
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
                case 'setParam':
                    this.statusBarManager.setParamImmediate(
                        message.operator,
                        message.param,
                        message.value
                    );
                    break;
                case 'solo':
                    this.statusBarManager.send({ type: 'solo_node', operator: message.operator });
                    break;
                case 'snapshot':
                    await this.captureSnapshot();
                    break;
                case 'toggleRecord':
                    await this.toggleRecording();
                    break;
            }
        });

        // Initial update
        this.updateView();
    }

    private async captureSnapshot() {
        if (!this.isConnected) {
            vscode.window.showWarningMessage('Vivid is not running');
            return;
        }

        // Get workspace folder for default save location
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const defaultPath = workspaceFolder
            ? `${workspaceFolder}/snapshot_${timestamp}.png`
            : `/tmp/vivid_snapshot_${timestamp}.png`;

        // Ask user where to save
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(defaultPath),
            filters: { 'PNG Image': ['png'] }
        });

        if (!uri) return;

        this.outputChannel.appendLine(`[Inspector] Capturing snapshot to: ${uri.fsPath}`);
        this.statusBarManager.send({ type: 'capture_frame', outputPath: uri.fsPath });

        // TODO: Listen for capture_result message and show confirmation
        vscode.window.showInformationMessage(`Snapshot saved to ${uri.fsPath}`);
    }

    private async toggleRecording() {
        if (!this.isConnected) {
            vscode.window.showWarningMessage('Vivid is not running');
            return;
        }

        if (this.isRecording) {
            this.statusBarManager.send({ type: 'stop_recording' });
            this.isRecording = false;
            this.outputChannel.appendLine('[Inspector] Stopped recording');
            vscode.window.showInformationMessage('Recording stopped');
        } else {
            // Get workspace folder for default save location
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const defaultPath = workspaceFolder
                ? `${workspaceFolder}/recording_${timestamp}.mov`
                : `/tmp/vivid_recording_${timestamp}.mov`;

            // Ask user where to save
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(defaultPath),
                filters: { 'Video': ['mov', 'mp4'] }
            });

            if (!uri) return;

            this.statusBarManager.send({ type: 'start_recording', outputPath: uri.fsPath });
            this.isRecording = true;
            this.outputChannel.appendLine(`[Inspector] Started recording to: ${uri.fsPath}`);
            vscode.window.showInformationMessage('Recording started...');
        }

        this.updateView();
    }

    private updateView() {
        if (!this.view) {
            return;
        }

        const selectedParams = this.selectedOperator
            ? this.params.filter(p => p.operator === this.selectedOperator)
            : [];

        this.view.webview.postMessage({
            type: 'update',
            selectedOperator: this.selectedOperator,
            params: selectedParams,
            isConnected: this.isConnected,
            isRecording: this.isRecording
        });
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
        .toolbar {
            display: flex;
            gap: 8px;
            padding-bottom: 10px;
            margin-bottom: 10px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .toolbar-btn {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            padding: 6px 10px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }
        .toolbar-btn:hover:not(:disabled) {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .toolbar-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .toolbar-btn.recording {
            background: var(--vscode-inputValidation-errorBackground);
            color: var(--vscode-inputValidation-errorForeground);
        }
        .toolbar-btn svg {
            width: 14px;
            height: 14px;
            fill: currentColor;
        }
        .empty-state {
            color: var(--vscode-descriptionForeground);
            text-align: center;
            padding: 20px;
            font-size: 12px;
        }
        .operator-name {
            font-weight: 600;
            font-size: 13px;
            padding: 8px 0;
            border-bottom: 1px solid var(--vscode-panel-border);
            margin-bottom: 8px;
        }
        .param-item {
            padding: 6px 0;
        }
        .param-label {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
        }
        .param-slider-row {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .param-slider {
            flex: 1;
            -webkit-appearance: none;
            height: 4px;
            background: var(--vscode-scrollbarSlider-background);
            border-radius: 2px;
            outline: none;
        }
        .param-slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            width: 14px;
            height: 14px;
            background: var(--vscode-button-background);
            border-radius: 50%;
            cursor: pointer;
        }
        .param-slider::-webkit-slider-thumb:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .param-value {
            width: 50px;
            text-align: right;
            font-size: 11px;
            font-family: var(--vscode-editor-font-family);
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            color: var(--vscode-input-foreground);
            padding: 2px 4px;
            border-radius: 3px;
        }
        .param-select {
            width: 100%;
            padding: 4px 8px;
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 3px;
            font-size: 12px;
            cursor: pointer;
        }
        .param-color-row {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .param-color-preview {
            width: 32px;
            height: 24px;
            border-radius: 3px;
            border: 1px solid var(--vscode-editorWidget-border);
            cursor: pointer;
        }
        .param-color-input {
            width: 0;
            height: 0;
            padding: 0;
            border: none;
            opacity: 0;
            position: absolute;
        }
        .param-color-values {
            display: flex;
            gap: 4px;
            flex: 1;
        }
        .param-color-component {
            flex: 1;
            min-width: 0;
        }
        .param-color-component input {
            width: 100%;
            padding: 2px 4px;
            font-size: 10px;
            text-align: center;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            color: var(--vscode-input-foreground);
            border-radius: 3px;
        }
        .param-color-component label {
            display: block;
            font-size: 9px;
            text-align: center;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 2px;
        }
        .param-vec-row {
            display: flex;
            gap: 6px;
        }
        .param-vec-component {
            flex: 1;
            min-width: 0;
        }
        .param-vec-component input {
            width: 100%;
            padding: 3px 4px;
            font-size: 11px;
            text-align: center;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            color: var(--vscode-input-foreground);
            border-radius: 3px;
        }
        .param-vec-component label {
            display: block;
            font-size: 9px;
            text-align: center;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 2px;
        }
        .param-filepath-text {
            padding: 4px 6px;
            font-size: 11px;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            color: var(--vscode-input-foreground);
            border-radius: 3px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .param-adsr {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 6px;
        }
        .param-adsr-component label {
            display: block;
            font-size: 9px;
            text-align: center;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 2px;
        }
        .param-adsr-component input {
            width: 100%;
            padding: 3px 4px;
            font-size: 11px;
            text-align: center;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            color: var(--vscode-input-foreground);
            border-radius: 3px;
        }
        .solo-btn {
            width: 100%;
            padding: 6px;
            margin-top: 12px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }
        .solo-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .no-params {
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            padding: 10px 0;
            text-align: center;
        }
    </style>
</head>
<body>
    <div class="container">
        <div id="toolbar" class="toolbar">
            <button id="snapshot-btn" class="toolbar-btn" onclick="snapshot()" title="Capture snapshot">
                <svg viewBox="0 0 16 16"><path d="M14.5 3h-2.879l-.707-1.414A1 1 0 0 0 10.021 1H5.98a1 1 0 0 0-.894.553L4.379 3H1.5A1.5 1.5 0 0 0 0 4.5v8A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 14.5 3zM8 12a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/></svg>
                Snapshot
            </button>
            <button id="record-btn" class="toolbar-btn" onclick="toggleRecord()" title="Start/stop recording">
                <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>
                <span id="record-label">Record</span>
            </button>
        </div>
        <div id="empty-state" class="empty-state">
            Select an operator in the Chain Graph
        </div>
        <div id="content" style="display: none;">
            <div id="operator-name" class="operator-name"></div>
            <div id="params-list"></div>
            <button id="solo-btn" class="solo-btn">Solo Output</button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let currentOperator = null;
        let currentParams = [];
        let isConnected = false;
        let isRecording = false;

        function snapshot() {
            vscode.postMessage({ command: 'snapshot' });
        }

        function toggleRecord() {
            vscode.postMessage({ command: 'toggleRecord' });
        }

        function updateToolbar() {
            const snapshotBtn = document.getElementById('snapshot-btn');
            const recordBtn = document.getElementById('record-btn');
            const recordLabel = document.getElementById('record-label');

            snapshotBtn.disabled = !isConnected;
            recordBtn.disabled = !isConnected;

            if (isRecording) {
                recordBtn.classList.add('recording');
                recordLabel.textContent = 'Stop';
            } else {
                recordBtn.classList.remove('recording');
                recordLabel.textContent = 'Record';
            }
        }

        function setParam(operator, param, value) {
            vscode.postMessage({ command: 'setParam', operator, param, value });
        }

        function setColorFromPicker(operator, param, hexColor, alpha, previewEl) {
            const r = parseInt(hexColor.substr(1, 2), 16) / 255;
            const g = parseInt(hexColor.substr(3, 2), 16) / 255;
            const b = parseInt(hexColor.substr(5, 2), 16) / 255;
            // Update local params for immediate feedback
            const p = currentParams.find(x => x.name === param);
            if (p) {
                p.value = [r, g, b, alpha];
            }
            // Update preview immediately
            if (previewEl) {
                previewEl.style.background = 'rgba(' + Math.round(r*255) + ',' + Math.round(g*255) + ',' + Math.round(b*255) + ',' + alpha + ')';
            }
            vscode.postMessage({ command: 'setParam', operator, param, value: [r, g, b, alpha] });
        }

        function setColorComponent(operator, param, index, value, previewEl) {
            const p = currentParams.find(x => x.name === param);
            if (!p) return;
            const newValue = [...p.value];
            newValue[index] = value;
            p.value = newValue; // Update local for immediate feedback
            // Update preview immediately
            if (previewEl) {
                const r = Math.round(newValue[0] * 255);
                const g = Math.round(newValue[1] * 255);
                const b = Math.round(newValue[2] * 255);
                const a = newValue[3];
                previewEl.style.background = 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
            }
            vscode.postMessage({ command: 'setParam', operator, param, value: newValue });
        }

        function setVecComponent(operator, param, index, value, vecSize) {
            const p = currentParams.find(x => x.name === param);
            if (!p) return;
            const newValue = [...p.value];
            newValue[index] = value;
            vscode.postMessage({ command: 'setParam', operator, param, value: newValue.slice(0, vecSize) });
        }

        function solo() {
            if (currentOperator) {
                vscode.postMessage({ command: 'solo', operator: currentOperator });
            }
        }

        function renderParam(p, operator) {
            const opName = operator.replace(/'/g, "\\'");
            const paramName = p.name.replace(/'/g, "\\'");

            // Bool - checkbox
            if (p.type === 'Bool') {
                const checked = p.value[0] > 0.5 ? 'checked' : '';
                return '<div class="param-item">' +
                    '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">' +
                    '<input type="checkbox" ' + checked + ' onchange="setParam(\\'' + opName + '\\', \\'' + paramName + '\\', this.checked ? 1 : 0)">' +
                    '<span>' + p.name + '</span></label></div>';
            }

            // Enum - dropdown
            if (p.type === 'Enum' && p.enumLabels && p.enumLabels.length > 0) {
                const currentIndex = Math.round(p.value[0]);
                const options = p.enumLabels.map((label, i) => {
                    const selected = i === currentIndex ? 'selected' : '';
                    return '<option value="' + i + '" ' + selected + '>' + label + '</option>';
                }).join('');
                return '<div class="param-item">' +
                    '<div class="param-label">' + p.name + '</div>' +
                    '<select class="param-select" onchange="setParam(\\'' + opName + '\\', \\'' + paramName + '\\', parseInt(this.value))">' +
                    options + '</select></div>';
            }

            // Color - RGBA color picker
            if (p.type === 'Color') {
                const r = Math.round(p.value[0] * 255);
                const g = Math.round(p.value[1] * 255);
                const b = Math.round(p.value[2] * 255);
                const a = p.value[3];
                const hexColor = '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
                const rgbaStr = 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
                return '<div class="param-item">' +
                    '<div class="param-label">' + p.name + '</div>' +
                    '<div class="param-color-row">' +
                    '<div class="param-color-preview" style="background:' + rgbaStr + '" onclick="this.nextElementSibling.click()"></div>' +
                    '<input type="color" class="param-color-input" value="' + hexColor + '" ' +
                    'onchange="setColorFromPicker(\\'' + opName + '\\', \\'' + paramName + '\\', this.value, ' + a + ', this.previousElementSibling)">' +
                    '<div class="param-color-values">' +
                    '<div class="param-color-component"><label>R</label><input type="number" min="0" max="255" value="' + r + '" onchange="setColorComponent(\\'' + opName + '\\', \\'' + paramName + '\\', 0, this.value/255, this.closest(\\'.param-color-row\\').querySelector(\\'.param-color-preview\\'))"></div>' +
                    '<div class="param-color-component"><label>G</label><input type="number" min="0" max="255" value="' + g + '" onchange="setColorComponent(\\'' + opName + '\\', \\'' + paramName + '\\', 1, this.value/255, this.closest(\\'.param-color-row\\').querySelector(\\'.param-color-preview\\'))"></div>' +
                    '<div class="param-color-component"><label>B</label><input type="number" min="0" max="255" value="' + b + '" onchange="setColorComponent(\\'' + opName + '\\', \\'' + paramName + '\\', 2, this.value/255, this.closest(\\'.param-color-row\\').querySelector(\\'.param-color-preview\\'))"></div>' +
                    '<div class="param-color-component"><label>A</label><input type="number" min="0" max="1" step="0.01" value="' + a.toFixed(2) + '" onchange="setColorComponent(\\'' + opName + '\\', \\'' + paramName + '\\', 3, parseFloat(this.value), this.closest(\\'.param-color-row\\').querySelector(\\'.param-color-preview\\'))"></div>' +
                    '</div></div></div>';
            }

            // Vec2 - two inputs
            if (p.type === 'Vec2') {
                return '<div class="param-item">' +
                    '<div class="param-label">' + p.name + '</div>' +
                    '<div class="param-vec-row">' +
                    '<div class="param-vec-component"><label>X</label><input type="number" step="0.01" value="' + p.value[0].toFixed(2) + '" onchange="setVecComponent(\\'' + opName + '\\', \\'' + paramName + '\\', 0, parseFloat(this.value), 2)"></div>' +
                    '<div class="param-vec-component"><label>Y</label><input type="number" step="0.01" value="' + p.value[1].toFixed(2) + '" onchange="setVecComponent(\\'' + opName + '\\', \\'' + paramName + '\\', 1, parseFloat(this.value), 2)"></div>' +
                    '</div></div>';
            }

            // Vec3 - three inputs
            if (p.type === 'Vec3') {
                return '<div class="param-item">' +
                    '<div class="param-label">' + p.name + '</div>' +
                    '<div class="param-vec-row">' +
                    '<div class="param-vec-component"><label>X</label><input type="number" step="0.01" value="' + p.value[0].toFixed(2) + '" onchange="setVecComponent(\\'' + opName + '\\', \\'' + paramName + '\\', 0, parseFloat(this.value), 3)"></div>' +
                    '<div class="param-vec-component"><label>Y</label><input type="number" step="0.01" value="' + p.value[1].toFixed(2) + '" onchange="setVecComponent(\\'' + opName + '\\', \\'' + paramName + '\\', 1, parseFloat(this.value), 3)"></div>' +
                    '<div class="param-vec-component"><label>Z</label><input type="number" step="0.01" value="' + p.value[2].toFixed(2) + '" onchange="setVecComponent(\\'' + opName + '\\', \\'' + paramName + '\\', 2, parseFloat(this.value), 3)"></div>' +
                    '</div></div>';
            }

            // Vec4 - four inputs
            if (p.type === 'Vec4') {
                return '<div class="param-item">' +
                    '<div class="param-label">' + p.name + '</div>' +
                    '<div class="param-vec-row">' +
                    '<div class="param-vec-component"><label>X</label><input type="number" step="0.01" value="' + p.value[0].toFixed(2) + '" onchange="setVecComponent(\\'' + opName + '\\', \\'' + paramName + '\\', 0, parseFloat(this.value), 4)"></div>' +
                    '<div class="param-vec-component"><label>Y</label><input type="number" step="0.01" value="' + p.value[1].toFixed(2) + '" onchange="setVecComponent(\\'' + opName + '\\', \\'' + paramName + '\\', 1, parseFloat(this.value), 4)"></div>' +
                    '<div class="param-vec-component"><label>Z</label><input type="number" step="0.01" value="' + p.value[2].toFixed(2) + '" onchange="setVecComponent(\\'' + opName + '\\', \\'' + paramName + '\\', 2, parseFloat(this.value), 4)"></div>' +
                    '<div class="param-vec-component"><label>W</label><input type="number" step="0.01" value="' + p.value[3].toFixed(2) + '" onchange="setVecComponent(\\'' + opName + '\\', \\'' + paramName + '\\', 3, parseFloat(this.value), 4)"></div>' +
                    '</div></div>';
            }

            // ADSR - four inputs for envelope
            if (p.type === 'ADSR') {
                return '<div class="param-item">' +
                    '<div class="param-label">' + p.name + '</div>' +
                    '<div class="param-adsr">' +
                    '<div class="param-adsr-component"><label>A</label><input type="number" min="0" max="' + p.max + '" step="0.01" value="' + p.value[0].toFixed(2) + '" onchange="setVecComponent(\\'' + opName + '\\', \\'' + paramName + '\\', 0, parseFloat(this.value), 4)"></div>' +
                    '<div class="param-adsr-component"><label>D</label><input type="number" min="0" max="' + p.max + '" step="0.01" value="' + p.value[1].toFixed(2) + '" onchange="setVecComponent(\\'' + opName + '\\', \\'' + paramName + '\\', 1, parseFloat(this.value), 4)"></div>' +
                    '<div class="param-adsr-component"><label>S</label><input type="number" min="0" max="1" step="0.01" value="' + p.value[2].toFixed(2) + '" onchange="setVecComponent(\\'' + opName + '\\', \\'' + paramName + '\\', 2, parseFloat(this.value), 4)"></div>' +
                    '<div class="param-adsr-component"><label>R</label><input type="number" min="0" max="' + p.max + '" step="0.01" value="' + p.value[3].toFixed(2) + '" onchange="setVecComponent(\\'' + opName + '\\', \\'' + paramName + '\\', 3, parseFloat(this.value), 4)"></div>' +
                    '</div></div>';
            }

            // FilePath - display only
            if (p.type === 'FilePath') {
                const displayPath = p.stringValue || '(none)';
                const shortPath = displayPath.split('/').pop() || displayPath;
                return '<div class="param-item">' +
                    '<div class="param-label">' + p.name + '</div>' +
                    '<div class="param-filepath-text" title="' + displayPath + '">' + shortPath + '</div></div>';
            }

            // Int - integer slider
            if (p.type === 'Int') {
                const val = Math.round(p.value[0]);
                return '<div class="param-item">' +
                    '<div class="param-label">' + p.name + '</div>' +
                    '<div class="param-slider-row">' +
                    '<input type="range" class="param-slider" min="' + p.min + '" max="' + p.max + '" step="1" value="' + val + '" ' +
                    'oninput="setParam(\\'' + opName + '\\', \\'' + paramName + '\\', parseInt(this.value)); this.nextElementSibling.value = this.value">' +
                    '<input type="text" class="param-value" value="' + val + '" ' +
                    'onchange="setParam(\\'' + opName + '\\', \\'' + paramName + '\\', parseInt(this.value)); this.previousElementSibling.value = this.value">' +
                    '</div></div>';
            }

            // Default: Float slider
            const val = p.value[0];
            const displayVal = val.toFixed(2);
            return '<div class="param-item">' +
                '<div class="param-label">' + p.name + '</div>' +
                '<div class="param-slider-row">' +
                '<input type="range" class="param-slider" min="' + p.min + '" max="' + p.max + '" step="0.01" value="' + val + '" ' +
                'oninput="setParam(\\'' + opName + '\\', \\'' + paramName + '\\', parseFloat(this.value)); this.nextElementSibling.value = parseFloat(this.value).toFixed(2)">' +
                '<input type="text" class="param-value" value="' + displayVal + '" ' +
                'onchange="setParam(\\'' + opName + '\\', \\'' + paramName + '\\', parseFloat(this.value)); this.previousElementSibling.value = this.value">' +
                '</div></div>';
        }

        function render() {
            const emptyState = document.getElementById('empty-state');
            const content = document.getElementById('content');
            const operatorName = document.getElementById('operator-name');
            const paramsList = document.getElementById('params-list');

            if (!currentOperator) {
                emptyState.style.display = 'block';
                content.style.display = 'none';
                return;
            }

            emptyState.style.display = 'none';
            content.style.display = 'block';
            operatorName.textContent = currentOperator;

            if (currentParams.length === 0) {
                paramsList.innerHTML = '<div class="no-params">No parameters</div>';
            } else {
                paramsList.innerHTML = currentParams.map(p => renderParam(p, currentOperator)).join('');
            }
        }

        document.getElementById('solo-btn').onclick = solo;

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'update') {
                currentOperator = message.selectedOperator;
                currentParams = message.params || [];
                isConnected = message.isConnected || false;
                isRecording = message.isRecording || false;
                render();
                updateToolbar();
            }
        });

        // Initial toolbar state
        updateToolbar();
    </script>
</body>
</html>`;
    }

    dispose() {
        if (this.stateSubscription) {
            this.stateSubscription.dispose();
        }
        if (this.paramsSubscription) {
            this.paramsSubscription.dispose();
        }
    }
}
