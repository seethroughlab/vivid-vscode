import * as vscode from 'vscode';
import * as cppParser from './cppParser';

// Decoration for unsaved changes made by the extension
const pendingChangeDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(255, 100, 100, 0.2)',
    isWholeLine: true,
    overviewRulerColor: 'rgba(255, 100, 100, 0.8)',
    overviewRulerLane: vscode.OverviewRulerLane.Right,
});

interface ParamLocation {
    line: number;
    startColumn: number;
    endColumn: number;
    currentValue: string;
    startByte: number;
    endByte: number;
    isConstant: boolean;
}

interface OperatorInfo {
    variableName: string;
    chainName: string;
    typeName: string;
    line: number;  // Line number where operator is declared (for inserting new params)
}

interface OperatorParamMap {
    [chainName: string]: {
        [paramName: string]: ParamLocation;
    };
}

// Maps chain name to operator info
type OperatorInfoMap = { [chainName: string]: OperatorInfo };

export class ChainCodeSync {
    private paramMap: OperatorParamMap = {};
    private operatorInfoMap: OperatorInfoMap = {};
    private chainDocument: vscode.TextDocument | undefined;
    private pendingUpdates: Map<string, { value: number[], timeout: NodeJS.Timeout }> = new Map();
    private debounceMs = 500;
    private isUpdating = false;
    private parserInitialized = false;
    private extensionPath: string = '';
    private pendingChangeLines: Set<number> = new Set();  // Lines with unsaved extension changes
    private outputChannel: vscode.OutputChannel | undefined;

    setOutputChannel(channel: vscode.OutputChannel): void {
        this.outputChannel = channel;
    }

    private log(message: string): void {
        console.log(message);
        this.outputChannel?.appendLine(message);
    }

    setExtensionPath(path: string): void {
        this.extensionPath = path;
    }

    async initializeParser(): Promise<boolean> {
        if (this.parserInitialized) return true;
        if (!this.extensionPath) {
            this.log('[ChainCodeSync] Extension path not set');
            return false;
        }
        this.log(`[ChainCodeSync] Initializing parser with path: ${this.extensionPath}`);
        this.parserInitialized = await cppParser.initializeParser(this.extensionPath);
        this.log(`[ChainCodeSync] Parser initialized: ${this.parserInitialized}`);
        if (!this.parserInitialized) {
            const error = cppParser.getLastError();
            if (error) {
                this.log(`[ChainCodeSync] Parser error: ${error}`);
            }
        }
        return this.parserInitialized;
    }

    async findChainFile(): Promise<vscode.TextDocument | undefined> {
        const files = await vscode.workspace.findFiles('**/chain.cpp', null, 1);
        if (files.length === 0) {
            return undefined;
        }
        this.chainDocument = await vscode.workspace.openTextDocument(files[0]);
        return this.chainDocument;
    }

    async parseChainFile(): Promise<void> {
        if (!this.chainDocument) {
            await this.findChainFile();
        }
        if (!this.chainDocument) {
            return;
        }

        // Initialize parser if needed
        if (!this.parserInitialized) {
            const success = await this.initializeParser();
            if (!success) {
                this.log('[ChainCodeSync] Failed to initialize Tree-sitter parser');
                return;
            }
        }

        this.paramMap = {};
        this.operatorInfoMap = {};
        const text = this.chainDocument.getText();

        // Parse the file with Tree-sitter
        const { operators, params } = cppParser.parseChainFile(text);

        this.log(`[ChainCodeSync] Tree-sitter found ${operators.length} operators, ${params.length} params`);

        // Build operator info map (maps chain name to operator info)
        for (const op of operators) {
            this.operatorInfoMap[op.name] = {
                variableName: op.variableName,
                chainName: op.name,
                typeName: op.typeName,
                line: op.line
            };
            // Initialize param map for this operator
            if (!this.paramMap[op.name]) {
                this.paramMap[op.name] = {};
            }
        }

        // Build param map (maps chain name -> param name -> location)
        // Need to map variable names back to chain names
        const varToChainName: { [varName: string]: string } = {};
        for (const [chainName, info] of Object.entries(this.operatorInfoMap)) {
            varToChainName[info.variableName] = chainName;
        }

        for (const param of params) {
            const chainName = varToChainName[param.operatorVar];
            if (chainName) {
                if (!this.paramMap[chainName]) {
                    this.paramMap[chainName] = {};
                }
                this.paramMap[chainName][param.paramName] = {
                    line: param.line,
                    startColumn: param.startColumn,
                    endColumn: param.endColumn,
                    currentValue: param.value,
                    startByte: param.startByte,
                    endByte: param.endByte,
                    isConstant: param.isConstant
                };
                this.log(`[ChainCodeSync] Found param: ${chainName}.${param.paramName} = ${param.value} (constant: ${param.isConstant}) at line ${param.line}`);
            }
        }
    }

    scheduleParamUpdate(operator: string, param: string, value: number[], paramType: string): void {
        const key = `${operator}.${param}`;

        // Cancel any pending update for this param
        const pending = this.pendingUpdates.get(key);
        if (pending) {
            clearTimeout(pending.timeout);
        }

        // Schedule new update
        const timeout = setTimeout(() => {
            this.applyParamUpdate(operator, param, value, paramType);
            this.pendingUpdates.delete(key);
        }, this.debounceMs);

        this.pendingUpdates.set(key, { value, timeout });
    }

    private async applyParamUpdate(operator: string, param: string, value: number[], paramType: string): Promise<void> {
        if (this.isUpdating) {
            this.log(`[ChainCodeSync] Skipping - already updating`);
            return;
        }

        // Re-parse to get fresh locations
        await this.parseChainFile();

        this.log(`[ChainCodeSync] Looking for ${operator}.${param}, paramMap keys: ${JSON.stringify(Object.keys(this.paramMap))}`);
        const opParams = this.paramMap[operator];
        this.log(`[ChainCodeSync] opParams for ${operator}: ${opParams ? JSON.stringify(Object.keys(opParams)) : 'not found'}`);
        const existingParam = opParams?.[param];

        if (!existingParam) {
            // Parameter not found in source - insert a new line
            this.log(`[ChainCodeSync] Param ${operator}.${param} not found in paramMap, will insert`);
            await this.insertNewParam(operator, param, value, paramType);
            return;
        }
        this.log(`[ChainCodeSync] Applying update ${operator}.${param} = ${value}`);

        const location = opParams[param];
        if (!this.chainDocument) {
            return;
        }

        // Format the new value based on type
        let newValueStr: string;
        switch (paramType) {
            case 'Float':
                newValueStr = this.formatFloat(value[0]);
                break;
            case 'Int':
                newValueStr = Math.round(value[0]).toString();
                break;
            case 'Bool':
                newValueStr = value[0] ? 'true' : 'false';
                break;
            case 'Vec2':
                newValueStr = `${this.formatFloat(value[0])}, ${this.formatFloat(value[1])}`;
                break;
            case 'Vec3':
                newValueStr = `${this.formatFloat(value[0])}, ${this.formatFloat(value[1])}, ${this.formatFloat(value[2])}`;
                break;
            case 'Vec4':
            case 'Color':
                newValueStr = `${this.formatFloat(value[0])}, ${this.formatFloat(value[1])}, ${this.formatFloat(value[2])}, ${this.formatFloat(value[3])}`;
                break;
            default:
                newValueStr = this.formatFloat(value[0]);
        }

        // Create the edit
        const range = new vscode.Range(
            location.line,
            location.startColumn,
            location.line,
            location.endColumn
        );

        this.isUpdating = true;
        try {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(this.chainDocument.uri, range, newValueStr);
            await vscode.workspace.applyEdit(edit);

            // Update our cached location
            location.endColumn = location.startColumn + newValueStr.length;
            location.currentValue = newValueStr;

            // Mark the line as having pending changes
            this.markLineAsPending(location.line);
        } finally {
            this.isUpdating = false;
        }
    }

    private async insertNewParam(operator: string, param: string, value: number[], paramType: string): Promise<void> {
        const opInfo = this.operatorInfoMap[operator];
        if (!opInfo) {
            this.log(`[ChainCodeSync] Operator ${operator} not found, cannot insert param`);
            return;
        }

        if (!this.chainDocument) {
            return;
        }

        // Format the value
        let valueStr: string;
        switch (paramType) {
            case 'Float':
                valueStr = this.formatFloat(value[0]);
                break;
            case 'Int':
                valueStr = Math.round(value[0]).toString();
                break;
            case 'Bool':
                valueStr = value[0] ? 'true' : 'false';
                break;
            case 'Vec2':
                valueStr = `${this.formatFloat(value[0])}, ${this.formatFloat(value[1])}`;
                break;
            case 'Vec3':
                valueStr = `${this.formatFloat(value[0])}, ${this.formatFloat(value[1])}, ${this.formatFloat(value[2])}`;
                break;
            case 'Vec4':
            case 'Color':
                valueStr = `${this.formatFloat(value[0])}, ${this.formatFloat(value[1])}, ${this.formatFloat(value[2])}, ${this.formatFloat(value[3])}`;
                break;
            default:
                valueStr = this.formatFloat(value[0]);
        }

        // Find the best insertion line - after the operator declaration or after its last param
        let insertAfterLine = opInfo.line;
        const opParams = this.paramMap[operator];
        if (opParams) {
            for (const paramLoc of Object.values(opParams)) {
                if (paramLoc.line > insertAfterLine) {
                    insertAfterLine = paramLoc.line;
                }
            }
        }

        // Get indentation from the operator declaration line
        const opLine = this.chainDocument.lineAt(opInfo.line);
        const indent = opLine.text.match(/^(\s*)/)?.[1] || '    ';

        // Create the new line
        const newLine = `${indent}${opInfo.variableName}.${param} = ${valueStr};\n`;

        this.log(`[ChainCodeSync] Inserting new param after line ${insertAfterLine}: ${newLine.trim()}`);

        this.isUpdating = true;
        try {
            const edit = new vscode.WorkspaceEdit();
            // Insert at the beginning of the next line
            const insertPosition = new vscode.Position(insertAfterLine + 1, 0);
            edit.insert(this.chainDocument.uri, insertPosition, newLine);
            await vscode.workspace.applyEdit(edit);

            // Mark the inserted line as having pending changes
            this.markLineAsPending(insertAfterLine + 1);
        } finally {
            this.isUpdating = false;
        }
    }

    private formatFloat(value: number): string {
        // Format float with 'f' suffix for C++
        const str = value.toFixed(2);
        // Remove trailing zeros but keep at least one decimal
        const trimmed = str.replace(/\.?0+$/, '');
        return (trimmed.includes('.') ? trimmed : str) + 'f';
    }

    getParamLocation(operator: string, param: string): ParamLocation | undefined {
        return this.paramMap[operator]?.[param];
    }

    isParamConstant(operator: string, param: string): boolean {
        const location = this.paramMap[operator]?.[param];
        // If we don't have info about this param, assume it's constant (editable)
        // This handles params that exist in runtime but not in source yet
        return location?.isConstant ?? true;
    }

    /**
     * Called when chain.cpp is modified (externally or by this extension).
     * Invalidates cached locations and cancels pending updates to prevent
     * applying edits at stale byte offsets.
     */
    onDocumentChanged(): void {
        // Cancel all pending debounced updates - they have stale locations
        for (const pending of this.pendingUpdates.values()) {
            clearTimeout(pending.timeout);
        }
        this.pendingUpdates.clear();

        // Clear cached locations - they're now stale
        this.paramMap = {};
        this.operatorInfoMap = {};

        // Force re-open of document to get fresh content
        this.chainDocument = undefined;

        this.log('[ChainCodeSync] Document changed, cache invalidated');
    }

    /**
     * Mark a line as having pending (unsaved) changes from the extension
     */
    private markLineAsPending(line: number): void {
        this.pendingChangeLines.add(line);
        this.updatePendingDecorations();
    }

    /**
     * Update the pending change decorations in the editor
     */
    private updatePendingDecorations(): void {
        const editor = vscode.window.visibleTextEditors.find(
            e => e.document === this.chainDocument
        );
        if (!editor) return;

        const decorations: vscode.DecorationOptions[] = [];
        for (const line of this.pendingChangeLines) {
            if (line >= 0 && line < editor.document.lineCount) {
                decorations.push({
                    range: new vscode.Range(line, 0, line, 0)
                });
            }
        }
        editor.setDecorations(pendingChangeDecoration, decorations);
    }

    /**
     * Clear pending change decorations (call when file is saved)
     */
    clearPendingDecorations(): void {
        this.pendingChangeLines.clear();
        // Clear decorations from all visible editors showing chain.cpp
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.fileName.endsWith('chain.cpp')) {
                editor.setDecorations(pendingChangeDecoration, []);
            }
        }
    }

    clear(): void {
        // Cancel all pending updates
        for (const pending of this.pendingUpdates.values()) {
            clearTimeout(pending.timeout);
        }
        this.pendingUpdates.clear();
        this.paramMap = {};
        this.operatorInfoMap = {};
        this.chainDocument = undefined;
        this.clearPendingDecorations();
    }

    dispose(): void {
        this.clear();
        cppParser.dispose();
    }
}
