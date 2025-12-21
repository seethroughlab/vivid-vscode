// Chain Validator - validates operator input references and type compatibility

import * as vscode from 'vscode';
import { ParsedOperator, ParsedInputCall } from './cppParser';
import { OperatorCatalog } from './operatorCatalog';

export interface ValidationError {
    message: string;
    line: number;
    startColumn: number;
    endColumn: number;
    severity: vscode.DiagnosticSeverity;
}

/**
 * Validate .input() calls in a chain file
 * - Check that referenced operators exist
 * - Check that output types are compatible with input requirements
 */
export function validateInputCalls(
    operators: ParsedOperator[],
    inputCalls: ParsedInputCall[],
    catalog: OperatorCatalog
): ValidationError[] {
    const errors: ValidationError[] = [];

    // Build lookup: chainName -> operator info
    const operatorMap = new Map<string, ParsedOperator>();
    for (const op of operators) {
        operatorMap.set(op.name, op);
    }

    // Build lookup: variableName -> operator info
    const varToOp = new Map<string, ParsedOperator>();
    for (const op of operators) {
        varToOp.set(op.variableName, op);
    }

    for (const call of inputCalls) {
        const callingOp = varToOp.get(call.operatorVar);
        const referencedOp = operatorMap.get(call.inputName);

        // Check 1: Does the referenced operator exist?
        if (!referencedOp) {
            const suggestions = findSimilar(call.inputName, [...operatorMap.keys()]);
            let msg = `Operator "${call.inputName}" is not defined in this chain`;
            if (suggestions.length > 0) {
                msg += `. Did you mean "${suggestions[0]}"?`;
            }
            errors.push({
                message: msg,
                line: call.line,
                startColumn: call.startColumn,
                endColumn: call.endColumn,
                severity: vscode.DiagnosticSeverity.Error
            });
            continue;
        }

        // Check 2: Type compatibility
        if (callingOp && catalog.isLoaded()) {
            const callingDef = catalog.getOperator(callingOp.typeName);
            const referencedDef = catalog.getOperator(referencedOp.typeName);

            if (callingDef && referencedDef) {
                // TextureOperators need Texture input
                if (callingDef.requiresInput && referencedDef.outputType !== 'Texture') {
                    errors.push({
                        message: `${referencedOp.typeName} outputs ${referencedDef.outputType}, but ${callingOp.typeName} expects Texture input`,
                        line: call.line,
                        startColumn: call.startColumn,
                        endColumn: call.endColumn,
                        severity: vscode.DiagnosticSeverity.Warning
                    });
                }
            }
        }
    }

    return errors;
}

/**
 * Find similar strings using Levenshtein distance
 * Returns up to 2 suggestions with distance <= 3
 */
function findSimilar(target: string, candidates: string[]): string[] {
    return candidates
        .filter(c => c !== target)
        .map(c => ({ name: c, dist: levenshtein(target.toLowerCase(), c.toLowerCase()) }))
        .filter(x => x.dist <= 3)
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 2)
        .map(x => x.name);
}

/**
 * Standard Levenshtein distance calculation
 */
function levenshtein(a: string, b: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= a.length; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= b.length; j++) {
        matrix[0][j] = j;
    }

    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1,      // deletion
                matrix[i][j - 1] + 1,      // insertion
                matrix[i - 1][j - 1] + cost // substitution
            );
        }
    }

    return matrix[a.length][b.length];
}
