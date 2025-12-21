import * as path from 'path';
import { Parser, Language, Tree, Node } from 'web-tree-sitter';

export interface ParsedOperator {
    name: string;           // Chain name like "noise"
    variableName: string;   // Variable name like "noise" in `auto& noise = ...`
    typeName: string;       // Type like "Noise"
    line: number;           // 0-indexed line number
    startColumn: number;
    endColumn: number;
}

export interface ParsedParam {
    operatorVar: string;    // Variable name (e.g., "noise")
    paramName: string;      // Parameter name (e.g., "scale")
    value: string;          // Current value as string
    line: number;           // 0-indexed line number
    startColumn: number;    // Start column of the value
    endColumn: number;      // End column of the value
    startByte: number;      // Byte offset for precise editing
    endByte: number;
    isConstant: boolean;    // True if value is a literal (e.g., 4.0f), false if expression
}

export interface ParsedInputCall {
    operatorVar: string;    // Variable calling .input() (e.g., "blur")
    inputName: string;      // The string argument (e.g., "noise")
    line: number;
    startColumn: number;
    endColumn: number;
}

let parser: Parser | null = null;
let cppLanguage: Language | null = null;
let initialized = false;

// Store last error for debugging
let lastError: string | undefined;

export function getLastError(): string | undefined {
    return lastError;
}

export async function initializeParser(extensionPath: string): Promise<boolean> {
    if (initialized && parser && cppLanguage) {
        return true;
    }

    const fs = require('fs');

    try {
        // Find the web-tree-sitter WASM file
        const wasmPath = path.join(extensionPath, 'parsers', 'web-tree-sitter.wasm');

        console.log('[CppParser] Loading WASM from:', wasmPath);

        if (!fs.existsSync(wasmPath)) {
            lastError = `WASM file not found: ${wasmPath}`;
            console.error('[CppParser]', lastError);
            return false;
        }

        // Read WASM binary and pass it directly to avoid file loading issues
        const wasmBinary = fs.readFileSync(wasmPath);

        // Initialize parser with preloaded WASM binary
        await Parser.init({
            wasmBinary: wasmBinary
        } as any);  // Use 'any' because wasmBinary isn't in the type definitions but is supported

        parser = new Parser();

        // Load the C++ language from buffer
        const cppWasmPath = path.join(extensionPath, 'parsers', 'tree-sitter-cpp.wasm');

        if (!fs.existsSync(cppWasmPath)) {
            lastError = `C++ WASM file not found: ${cppWasmPath}`;
            console.error('[CppParser]', lastError);
            return false;
        }

        console.log('[CppParser] Loading C++ language from:', cppWasmPath);

        // Read language WASM as buffer
        const cppWasmBuffer = fs.readFileSync(cppWasmPath);
        cppLanguage = await Language.load(cppWasmBuffer);
        parser.setLanguage(cppLanguage);

        initialized = true;
        console.log('[CppParser] Tree-sitter initialized successfully');
        return true;
    } catch (error) {
        lastError = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
        console.error('[CppParser] Failed to initialize Tree-sitter:', error);
        return false;
    }
}

export function parseCode(code: string): Tree | null {
    if (!parser) {
        console.error('[CppParser] Parser not initialized');
        return null;
    }
    return parser.parse(code);
}

/**
 * Find all operator declarations in chain.cpp
 * Matches patterns like: auto& noise = chain.add<Noise>("noise")
 */
export function findOperatorDeclarations(tree: Tree): ParsedOperator[] {
    if (!cppLanguage) return [];

    const operators: ParsedOperator[] = [];

    // Walk the tree to find declarations with chain.add calls
    walkTree(tree.rootNode, (node) => {
        // Look for declaration nodes
        if (node.type === 'declaration') {
            // Find init_declarator which contains the variable name and initializer
            const initDeclarator = findChildOfType(node, 'init_declarator');
            if (!initDeclarator) return;

            // Find call_expression inside init_declarator
            const callExpr = findChildOfType(initDeclarator, 'call_expression');
            if (!callExpr) return;

            // Check if this is a chain.add call by looking at the field_expression
            const funcExpr = callExpr.childForFieldName('function');
            if (!funcExpr || funcExpr.type !== 'field_expression') return;

            // Look for template_method with 'add' as field_identifier
            const templateMethod = findChildOfType(funcExpr, 'template_method');
            if (!templateMethod) return;

            const fieldId = findChildOfType(templateMethod, 'field_identifier');
            if (!fieldId || fieldId.text !== 'add') return;

            // Extract variable name from reference_declarator
            const refDecl = findChildOfType(initDeclarator, 'reference_declarator');
            let varName = '';
            if (refDecl) {
                const identifier = findChildOfType(refDecl, 'identifier');
                if (identifier) varName = identifier.text;
            }

            // Extract type from template arguments
            let typeName = '';
            const templateArgs = findChildOfType(templateMethod, 'template_argument_list');
            if (templateArgs) {
                const typeDesc = findChildOfType(templateArgs, 'type_descriptor');
                if (typeDesc) {
                    const typeId = findChildOfType(typeDesc, 'type_identifier');
                    if (typeId) typeName = typeId.text;
                }
            }

            // Extract chain name from string argument
            const args = callExpr.childForFieldName('arguments');
            if (args) {
                const stringLit = findChildOfType(args, 'string_literal');
                if (stringLit) {
                    // Get the string_content child to get the actual string value
                    const stringContent = findChildOfType(stringLit, 'string_content');
                    const chainName = stringContent ? stringContent.text : stringLit.text.replace(/^["']|["']$/g, '');

                    if (varName && chainName) {
                        operators.push({
                            name: chainName,
                            variableName: varName,
                            typeName: typeName,
                            line: node.startPosition.row,
                            startColumn: node.startPosition.column,
                            endColumn: node.endPosition.column
                        });
                        console.log(`[CppParser] Found operator: ${varName} -> ${chainName} (${typeName})`);
                    }
                }
            }
        }
    });

    return operators;
}

/**
 * Find all member assignments like: noise.scale = 4.0f;
 */
export function findMemberAssignments(tree: Tree, knownOperators: string[]): ParsedParam[] {
    if (!cppLanguage) return [];

    const params: ParsedParam[] = [];
    const operatorSet = new Set(knownOperators);

    walkTree(tree.rootNode, (node) => {
        // Look for expression_statement containing assignment_expression
        if (node.type === 'expression_statement') {
            const assignExpr = findChildOfType(node, 'assignment_expression');
            if (assignExpr) {
                // The left side should be a field_expression (e.g., noise.scale)
                // The right side is the value (e.g., 4.0f)
                let left: Node | null = null;
                let right: Node | null = null;

                // Walk through children to find left and right of assignment
                for (let i = 0; i < assignExpr.childCount; i++) {
                    const child = assignExpr.child(i);
                    if (!child) continue;

                    if (child.type === 'field_expression' && !left) {
                        left = child;
                    } else if (child.type === '=') {
                        // Next non-trivial child is the right side
                        continue;
                    } else if (left && child.type !== '=' && child.type !== ';') {
                        right = child;
                        break;
                    }
                }

                if (left && right && left.type === 'field_expression') {
                    // Extract identifier (object) and field_identifier (field) from field_expression
                    const object = findChildOfType(left, 'identifier');
                    const field = findChildOfType(left, 'field_identifier');

                    if (object && field) {
                        const operatorVar = object.text;
                        const paramName = field.text;

                        // Only include if this is a known operator variable
                        if (operatorSet.has(operatorVar)) {
                            // Check if the value is a constant literal
                            const isConstant = isConstantLiteral(right);

                            params.push({
                                operatorVar,
                                paramName,
                                value: right.text,
                                line: right.startPosition.row,
                                startColumn: right.startPosition.column,
                                endColumn: right.endPosition.column,
                                startByte: right.startIndex,
                                endByte: right.endIndex,
                                isConstant
                            });
                            console.log(`[CppParser] Found param: ${operatorVar}.${paramName} = ${right.text} (constant: ${isConstant})`);
                        }
                    }
                }
            }
        }
    });

    return params;
}

/**
 * Find all .input("operatorName") calls
 * Used for validation that referenced operators exist
 */
export function findInputCalls(tree: Tree, knownOperators: string[]): ParsedInputCall[] {
    if (!cppLanguage) return [];

    const calls: ParsedInputCall[] = [];
    const operatorSet = new Set(knownOperators);

    walkTree(tree.rootNode, (node) => {
        if (node.type === 'call_expression') {
            const funcExpr = node.childForFieldName('function');
            if (funcExpr && funcExpr.type === 'field_expression') {
                const field = funcExpr.childForFieldName('field');
                const object = findChildOfType(funcExpr, 'identifier');

                // Check if this is a .input() call on a known operator variable
                if (field && field.text === 'input' && object && operatorSet.has(object.text)) {
                    const args = node.childForFieldName('arguments');
                    if (args) {
                        const stringLit = findChildOfType(args, 'string_literal');
                        if (stringLit) {
                            const stringContent = findChildOfType(stringLit, 'string_content');
                            const inputName = stringContent ? stringContent.text : stringLit.text.replace(/^["']|["']$/g, '');

                            calls.push({
                                operatorVar: object.text,
                                inputName: inputName,
                                line: stringLit.startPosition.row,
                                startColumn: stringLit.startPosition.column,
                                endColumn: stringLit.endPosition.column
                            });
                            console.log(`[CppParser] Found input call: ${object.text}.input("${inputName}")`);
                        }
                    }
                }
            }
        }
    });

    return calls;
}

/**
 * Find fluent-style parameter calls like: .scale(4.0f)
 * This handles the chained method call style if needed
 */
export function findFluentParamCalls(tree: Tree, operatorName: string): ParsedParam[] {
    if (!cppLanguage) return [];

    const params: ParsedParam[] = [];

    walkTree(tree.rootNode, (node) => {
        if (node.type === 'call_expression') {
            const funcExpr = node.childForFieldName('function');
            if (funcExpr && funcExpr.type === 'field_expression') {
                const field = funcExpr.childForFieldName('field');
                const args = node.childForFieldName('arguments');

                if (field && args) {
                    const paramName = field.text;

                    // Skip common non-param methods
                    if (['input', 'output', 'size', 'add', 'get'].includes(paramName)) {
                        return;
                    }

                    // Get the first argument as the value
                    const firstArg = args.namedChild(0);
                    if (firstArg) {
                        params.push({
                            operatorVar: operatorName,
                            paramName,
                            value: firstArg.text,
                            line: firstArg.startPosition.row,
                            startColumn: firstArg.startPosition.column,
                            endColumn: firstArg.endPosition.column,
                            startByte: firstArg.startIndex,
                            endByte: firstArg.endIndex,
                            isConstant: isConstantLiteral(firstArg)
                        });
                    }
                }
            }
        }
    });

    return params;
}

// Helper to check if a node is a constant literal (number, true, false)
function isConstantLiteral(node: Node): boolean {
    // Direct literals are constants
    if (node.type === 'number_literal' || node.type === 'true' || node.type === 'false') {
        return true;
    }
    // String literals are also constants
    if (node.type === 'string_literal') {
        return true;
    }
    // Everything else (identifiers, binary_expression, call_expression, etc.) is not constant
    return false;
}

// Helper function to walk the AST
function walkTree(node: Node, callback: (node: Node) => void) {
    callback(node);
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) {
            walkTree(child, callback);
        }
    }
}

// Helper to find a child node of a specific type
function findChildOfType(node: Node, type: string): Node | null {
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child && child.type === type) {
            return child;
        }
    }
    // Also search recursively one level for init_declarator etc.
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) {
            for (let j = 0; j < child.childCount; j++) {
                const grandchild = child.child(j);
                if (grandchild && grandchild.type === type) {
                    return grandchild;
                }
            }
        }
    }
    return null;
}

/**
 * Parse a chain.cpp file and return all operators, parameters, and input calls
 */
export function parseChainFile(code: string): { operators: ParsedOperator[], params: ParsedParam[], inputCalls: ParsedInputCall[] } {
    const tree = parseCode(code);
    if (!tree) {
        return { operators: [], params: [], inputCalls: [] };
    }

    const operators = findOperatorDeclarations(tree);
    const operatorVars = operators.map(op => op.variableName);
    const params = findMemberAssignments(tree, operatorVars);
    const inputCalls = findInputCalls(tree, operatorVars);

    return { operators, params, inputCalls };
}

export function isInitialized(): boolean {
    return initialized;
}

export function dispose(): void {
    if (parser) {
        parser.delete();
        parser = null;
    }
    cppLanguage = null;
    initialized = false;
}
