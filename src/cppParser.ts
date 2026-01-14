import * as vscode from 'vscode';
import * as path from 'path';
import Parser = require('web-tree-sitter');

let parserInstance: Parser | null = null;
let cppLanguage: Parser.Language | null = null;

/**
 * Initialize tree-sitter with the C++ grammar
 */
export async function initParser(extensionPath: string): Promise<boolean> {
    if (parserInstance && cppLanguage) {
        return true;
    }

    try {
        await Parser.init();
        parserInstance = new Parser();

        const wasmPath = path.join(extensionPath, 'parsers', 'tree-sitter-cpp.wasm');
        cppLanguage = await Parser.Language.load(wasmPath);
        parserInstance.setLanguage(cppLanguage);

        return true;
    } catch (e) {
        console.error('[CppParser] Failed to initialize:', e);
        return false;
    }
}

/**
 * Result of finding a parameter value in the AST
 */
export interface ParamLocation {
    /** Start offset in the document */
    startOffset: number;
    /** End offset in the document */
    endOffset: number;
    /** The current value text */
    currentValue: string;
    /** Type of expression (assignment or call) */
    type: 'assignment' | 'call';
}

/**
 * Find a parameter value at a specific line
 *
 * Handles patterns like:
 * - noise.scale = 4.0f;
 * - noise.scale(4.0f);
 * - camera.orbitCenter(0.0f, 0.0f, 0.0f);
 */
export function findParamValue(
    source: string,
    line: number,  // 1-indexed
    operatorName: string,
    paramName: string
): ParamLocation | null {
    if (!parserInstance) {
        console.error('[CppParser] Parser not initialized');
        return null;
    }

    const tree = parserInstance.parse(source);
    if (!tree) {
        console.error('[CppParser] Failed to parse source');
        return null;
    }
    const rootNode = tree.rootNode;

    // Convert to 0-indexed for tree-sitter
    const targetLine = line - 1;

    // Find nodes on this line
    const candidates = findNodesOnLine(rootNode, targetLine);

    for (const node of candidates) {
        // Look for assignment: operator.param = value
        const assignmentResult = tryMatchAssignment(node, source, operatorName, paramName);
        if (assignmentResult) {
            return assignmentResult;
        }

        // Look for call: operator.param(value) or operator.param(v1, v2, v3)
        const callResult = tryMatchCall(node, source, operatorName, paramName);
        if (callResult) {
            return callResult;
        }
    }

    return null;
}

/**
 * Find all expression nodes on a specific line
 */
function findNodesOnLine(node: Parser.SyntaxNode, line: number): Parser.SyntaxNode[] {
    const results: Parser.SyntaxNode[] = [];

    function traverse(n: Parser.SyntaxNode) {
        // Check if this node is on our target line
        if (n.startPosition.row === line || n.endPosition.row === line) {
            // Collect expression statements and assignments
            if (n.type === 'expression_statement' ||
                n.type === 'assignment_expression' ||
                n.type === 'call_expression') {
                results.push(n);
            }
        }

        // Recurse into children
        for (const child of n.children) {
            traverse(child);
        }
    }

    traverse(node);
    return results;
}

/**
 * Try to match an assignment pattern: operator.param = value
 */
function tryMatchAssignment(
    node: Parser.SyntaxNode,
    source: string,
    operatorName: string,
    paramName: string
): ParamLocation | null {
    // Find assignment_expression
    let assignment = node;
    if (node.type === 'expression_statement') {
        const firstChild = node.children[0];
        if (firstChild) {
            assignment = firstChild;
        }
    }

    if (assignment.type !== 'assignment_expression') {
        return null;
    }

    // Left side should be field_expression: operator.param
    const left = assignment.childForFieldName('left');
    const right = assignment.childForFieldName('right');

    if (!left || !right || left.type !== 'field_expression') {
        return null;
    }

    // Check if it matches operator.param
    const fieldText = source.substring(left.startIndex, left.endIndex);
    const expectedPattern = `${operatorName}.${paramName}`;

    if (!fieldText.endsWith(expectedPattern)) {
        return null;
    }

    return {
        startOffset: right.startIndex,
        endOffset: right.endIndex,
        currentValue: source.substring(right.startIndex, right.endIndex),
        type: 'assignment'
    };
}

/**
 * Try to match a call pattern: operator.param(value) or .param(value)
 */
function tryMatchCall(
    node: Parser.SyntaxNode,
    source: string,
    operatorName: string,
    paramName: string
): ParamLocation | null {
    // Find call_expression
    let call = node;
    if (node.type === 'expression_statement') {
        const firstChild = node.children[0];
        if (firstChild) {
            call = firstChild;
        }
    }

    if (call.type !== 'call_expression') {
        return null;
    }

    // Function being called should be field_expression: operator.param
    const func = call.childForFieldName('function');
    const args = call.childForFieldName('arguments');

    if (!func || !args) {
        return null;
    }

    // Check if function matches operator.param
    const funcText = source.substring(func.startIndex, func.endIndex);
    const expectedPattern = `${operatorName}.${paramName}`;

    if (!funcText.endsWith(expectedPattern) && !funcText.endsWith(`.${paramName}`)) {
        return null;
    }

    // More specific check for operator name if we matched just .paramName
    if (!funcText.endsWith(expectedPattern)) {
        // Make sure operatorName appears somewhere before
        if (!funcText.includes(operatorName)) {
            return null;
        }
    }

    // Get the content inside parentheses (all arguments)
    // args is argument_list: ( arg1, arg2, ... )
    if (args.type !== 'argument_list' || args.childCount < 2) {
        return null;
    }

    // Find the range of all arguments (excluding parentheses)
    const openParen = args.children[0];
    const closeParen = args.children[args.childCount - 1];

    if (!openParen || !closeParen) {
        return null;
    }

    // The content is between ( and )
    const startOffset = openParen.endIndex;
    const endOffset = closeParen.startIndex;

    return {
        startOffset,
        endOffset,
        currentValue: source.substring(startOffset, endOffset),
        type: 'call'
    };
}

/**
 * Apply a parameter change to the document
 */
export function applyParamChange(
    document: vscode.TextDocument,
    edit: vscode.WorkspaceEdit,
    location: ParamLocation,
    newValue: string
): void {
    const startPos = document.positionAt(location.startOffset);
    const endPos = document.positionAt(location.endOffset);
    const range = new vscode.Range(startPos, endPos);

    edit.replace(document.uri, range, newValue);
}
