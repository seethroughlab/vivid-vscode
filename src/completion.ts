import * as vscode from 'vscode';
import { OperatorCatalog, OperatorDefinition } from './operatorCatalog';
import { OperatorExample } from './headerParser';

export class CompletionProvider implements vscode.CompletionItemProvider {
    private operatorCatalog: OperatorCatalog;
    private examplesCache: Map<string, OperatorExample | null> = new Map();

    constructor(operatorCatalog: OperatorCatalog) {
        this.operatorCatalog = operatorCatalog;
    }

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): vscode.CompletionItem[] | undefined {

        const linePrefix = document.lineAt(position).text.substring(0, position.character);

        // Detect context and provide appropriate completions
        if (this.isAfterChainAdd(linePrefix)) {
            return this.getOperatorCompletions();
        }

        if (this.isAfterInput(linePrefix)) {
            return this.getOperatorNameCompletions(document);
        }

        if (this.isAfterOperatorDot(linePrefix, document, position)) {
            const operatorType = this.getOperatorTypeFromLine(linePrefix, document, position);
            if (operatorType) {
                return this.getOperatorMethodCompletions(operatorType);
            }
        }

        return undefined;
    }

    private isAfterChainAdd(linePrefix: string): boolean {
        // Match: chain.add< or ctx.chain().add<
        return /chain\s*(\(\))?\s*\.add\s*<\s*$/.test(linePrefix) ||
               /chain\.add<[A-Za-z]*$/.test(linePrefix);
    }

    private isAfterInput(linePrefix: string): boolean {
        // Match: .input(" or .setInput(" or .setInputA(" etc.
        return /\.(input|setInput|setInputA|setInputB)\s*\(\s*"[^"]*$/.test(linePrefix);
    }

    private isAfterOperatorDot(linePrefix: string, document: vscode.TextDocument, position: vscode.Position): boolean {
        // Match: operatorName. (but not chain. or ctx.)
        const match = linePrefix.match(/(\w+)\.\s*$/);
        if (!match) return false;
        const varName = match[1];
        return varName !== 'chain' && varName !== 'ctx' && varName !== 'context';
    }

    private getOperatorTypeFromLine(linePrefix: string, document: vscode.TextDocument, position: vscode.Position): string | null {
        // Try to find the operator type from the variable declaration
        const varMatch = linePrefix.match(/(\w+)\.\s*$/);
        if (!varMatch) return null;
        const varName = varMatch[1];

        // Search backwards in the document for the declaration
        const fullText = document.getText();
        const declarationRegex = new RegExp(`auto\\s*&\\s*${varName}\\s*=\\s*(?:chain\\.add|SceneComposer::create|chain\\.get)\\s*<\\s*(\\w+)\\s*>`, 'g');
        const match = declarationRegex.exec(fullText);

        return match ? match[1] : null;
    }

    private getOperatorCompletions(): vscode.CompletionItem[] {
        const operators = this.operatorCatalog.getOperators();
        const items: vscode.CompletionItem[] = [];

        for (const op of operators) {
            const item = new vscode.CompletionItem(op.name, vscode.CompletionItemKind.Class);
            item.detail = op.category;
            item.documentation = new vscode.MarkdownString(op.description || '');

            // Insert the operator name and close the template bracket
            item.insertText = new vscode.SnippetString(`${op.name}>("$\{1:${op.name.toLowerCase()}\}")`);
            item.command = {
                command: 'editor.action.triggerSuggest',
                title: 'Re-trigger completions'
            };

            items.push(item);
        }

        return items;
    }

    private getOperatorNameCompletions(document: vscode.TextDocument): vscode.CompletionItem[] {
        // Find all operator names defined in the current document
        const text = document.getText();
        const items: vscode.CompletionItem[] = [];
        const seen = new Set<string>();

        // Match: chain.add<...>("name") or chain.get<...>("name")
        const regex = /chain\s*(?:\(\))?\s*\.(?:add|get)\s*<\s*\w+\s*>\s*\(\s*"(\w+)"/g;
        let match;

        while ((match = regex.exec(text)) !== null) {
            const name = match[1];
            if (!seen.has(name)) {
                seen.add(name);
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Reference);
                item.detail = 'Operator in chain';
                items.push(item);
            }
        }

        return items;
    }

    private getOperatorMethodCompletions(operatorType: string): vscode.CompletionItem[] {
        const operators = this.operatorCatalog.getOperators();
        const operator = operators.find(op => op.name === operatorType);

        const items: vscode.CompletionItem[] = [];

        // Add common methods
        items.push(this.createMethodCompletion('input', 'Set input operator by name', 'input("${1:source}")'));

        if (operator?.params) {
            // Add parameter setters
            for (const param of operator.params) {
                const paramName = param.name;

                // Create property assignment completion
                const propItem = new vscode.CompletionItem(paramName, vscode.CompletionItemKind.Property);
                propItem.detail = `${param.type} parameter`;
                propItem.documentation = new vscode.MarkdownString(
                    `Range: ${param.min ?? '?'} - ${param.max ?? '?'}\n\nDefault: ${param.default ?? 'unknown'}`
                );
                propItem.insertText = new vscode.SnippetString(`${paramName} = $\{1:${param.default ?? '1.0f'}\}`);
                items.push(propItem);
            }
        }

        // Add type-specific methods based on common patterns
        if (this.is3DPrimitive(operatorType)) {
            items.push(this.createMethodCompletion('flatShading', 'Enable flat shading', 'flatShading(${1:true})'));
        }

        if (operatorType === 'Render3D') {
            items.push(this.createMethodCompletion('setInput', 'Set scene input', 'setInput(&${1:scene})'));
            items.push(this.createMethodCompletion('setCameraInput', 'Set camera', 'setCameraInput(&${1:camera})'));
            items.push(this.createMethodCompletion('setLightInput', 'Set light', 'setLightInput(&${1:light})'));
            items.push(this.createMethodCompletion('setShadingMode', 'Set shading mode', 'setShadingMode(ShadingMode::${1|PBR,Flat,Phong|})'));
            items.push(this.createMethodCompletion('setAmbient', 'Set ambient light', 'setAmbient(${1:0.2f})'));
            items.push(this.createMethodCompletion('setClearColor', 'Set background color', 'setClearColor(${1:0.1f}, ${2:0.1f}, ${3:0.1f})'));
        }

        if (operatorType === 'CameraOperator') {
            items.push(this.createMethodCompletion('orbitCenter', 'Set orbit center', 'orbitCenter(${1:0.0f}, ${2:0.0f}, ${3:0.0f})'));
            items.push(this.createMethodCompletion('distance', 'Set camera distance', 'distance(${1:8.0f})'));
            items.push(this.createMethodCompletion('elevation', 'Set elevation angle', 'elevation(${1:0.3f})'));
            items.push(this.createMethodCompletion('azimuth', 'Set azimuth angle', 'azimuth(${1:0.0f})'));
            items.push(this.createMethodCompletion('fov', 'Set field of view', 'fov(${1:50.0f})'));
        }

        if (operatorType === 'Composite') {
            items.push(this.createMethodCompletion('setInputA', 'Set layer A', 'setInputA("${1:layer1}")'));
            items.push(this.createMethodCompletion('setInputB', 'Set layer B', 'setInputB("${1:layer2}")'));
            items.push(this.createMethodCompletion('setBlendMode', 'Set blend mode', 'setBlendMode(BlendMode::${1|Normal,Add,Multiply,Screen,Overlay|})'));
        }

        return items;
    }

    private createMethodCompletion(name: string, detail: string, snippet: string): vscode.CompletionItem {
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Method);
        item.detail = detail;
        item.insertText = new vscode.SnippetString(snippet);
        return item;
    }

    private is3DPrimitive(type: string): boolean {
        return ['Box', 'Sphere', 'Cylinder', 'Cone', 'Torus', 'Plane'].includes(type);
    }

    /**
     * Resolve completion item with full documentation from header file
     */
    async resolveCompletionItem(
        item: vscode.CompletionItem,
        token: vscode.CancellationToken
    ): Promise<vscode.CompletionItem> {
        // Only resolve operator completions (Class kind)
        if (item.kind !== vscode.CompletionItemKind.Class) {
            return item;
        }

        const operatorName = typeof item.label === 'string' ? item.label : item.label?.label;
        if (!operatorName) {
            return item;
        }

        // Try to load example from header
        const example = await this.operatorCatalog.getOperatorExample(operatorName);
        if (example && example.exampleCode) {
            const md = new vscode.MarkdownString();
            md.appendMarkdown(`**${example.description}**\n\n`);
            md.appendMarkdown(`### Example\n`);
            md.appendCodeblock(example.exampleCode, 'cpp');
            item.documentation = md;
        }

        return item;
    }
}
