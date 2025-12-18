// Operator Drop Provider - handles drag-and-drop from operator library to chain.cpp

import * as vscode from 'vscode';
import { OperatorCatalog, OperatorDefinition } from './operatorCatalog';
import { ChainCodeSync } from './chainCodeSync';

export class OperatorDropProvider implements vscode.DocumentDropEditProvider {
    private _catalog?: OperatorCatalog;
    private _chainCodeSync?: ChainCodeSync;
    private _outputChannel?: vscode.OutputChannel;

    setCatalog(catalog: OperatorCatalog) {
        this._catalog = catalog;
    }

    setChainCodeSync(chainCodeSync: ChainCodeSync) {
        this._chainCodeSync = chainCodeSync;
    }

    setOutputChannel(channel: vscode.OutputChannel) {
        this._outputChannel = channel;
    }

    private log(message: string) {
        this._outputChannel?.appendLine(message);
    }

    async provideDocumentDropEdits(
        document: vscode.TextDocument,
        position: vscode.Position,
        dataTransfer: vscode.DataTransfer,
        token: vscode.CancellationToken
    ): Promise<vscode.DocumentDropEdit | undefined> {
        // Only handle drops in chain.cpp
        if (!document.fileName.endsWith('chain.cpp')) {
            return undefined;
        }

        // Get the operator name from the data transfer
        const operatorItem = dataTransfer.get('application/vnd.vivid.operator');
        if (!operatorItem) {
            // Try text/plain as fallback
            const textItem = dataTransfer.get('text/plain');
            if (!textItem) {
                return undefined;
            }
            const operatorName = await textItem.asString();
            return this.createDropEdit(document, position, operatorName);
        }

        const operatorName = await operatorItem.asString();
        return this.createDropEdit(document, position, operatorName);
    }

    private async createDropEdit(
        document: vscode.TextDocument,
        position: vscode.Position,
        operatorName: string
    ): Promise<vscode.DocumentDropEdit | undefined> {
        if (!this._catalog || !this._chainCodeSync) {
            this.log('[OperatorDrop] Catalog or chain code sync not available');
            return undefined;
        }

        // Get the operator definition
        const operator = this._catalog.getOperator(operatorName);
        if (!operator) {
            this.log(`[OperatorDrop] Operator "${operatorName}" not found`);
            return undefined;
        }

        // Determine insertion line based on drop position
        const dropLine = position.line + 1; // Convert to 1-indexed

        // Generate the code to insert
        const result = await this._chainCodeSync.generateInsertCode(operator, dropLine);
        if (!result) {
            this.log('[OperatorDrop] Failed to generate insert code');
            return undefined;
        }

        // Create the drop edit - insert after the current line
        const lineText = document.lineAt(position.line).text;
        const insertPos = new vscode.Position(position.line, lineText.length);

        // The DocumentDropEdit takes the text to insert at the drop position
        // We want to insert on a new line after the drop position
        const insertText = '\n' + result.code;
        const edit = new vscode.DocumentDropEdit(insertText);

        this.log(`[OperatorDrop] Created drop edit for ${operator.name}`);
        return edit;
    }
}
