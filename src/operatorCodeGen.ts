// Operator Code Generation - generates C++ code for operator insertion

import { OperatorDefinition, OperatorParam } from './operatorCatalog';

/**
 * Generate a unique variable name by appending a number suffix if needed
 */
export function generateVariableName(baseName: string, existingVars: string[]): string {
    // Convert PascalCase to camelCase for variable name
    let varName = baseName.charAt(0).toLowerCase() + baseName.slice(1);

    if (!existingVars.includes(varName)) {
        return varName;
    }

    // Try appending numbers
    let suffix = 2;
    while (existingVars.includes(`${varName}${suffix}`)) {
        suffix++;
    }
    return `${varName}${suffix}`;
}

/**
 * Format a parameter value for C++ code
 */
function formatParamValue(param: OperatorParam): string {
    if (param.default === undefined) {
        return '';
    }

    switch (param.type) {
        case 'Float':
            const f = typeof param.default === 'number' ? param.default : 0;
            return `${f.toFixed(2)}f`;

        case 'Int':
            const i = typeof param.default === 'number' ? Math.round(param.default) : 0;
            return `${i}`;

        case 'Bool':
            return param.default ? 'true' : 'false';

        case 'Vec2':
            if (Array.isArray(param.default) && param.default.length >= 2) {
                return `${param.default[0].toFixed(2)}f, ${param.default[1].toFixed(2)}f`;
            }
            return '0.0f, 0.0f';

        case 'Vec3':
            if (Array.isArray(param.default) && param.default.length >= 3) {
                return `${param.default[0].toFixed(2)}f, ${param.default[1].toFixed(2)}f, ${param.default[2].toFixed(2)}f`;
            }
            return '0.0f, 0.0f, 0.0f';

        case 'Vec4':
        case 'Color':
            if (Array.isArray(param.default) && param.default.length >= 4) {
                return `${param.default[0].toFixed(2)}f, ${param.default[1].toFixed(2)}f, ${param.default[2].toFixed(2)}f, ${param.default[3].toFixed(2)}f`;
            }
            return '0.0f, 0.0f, 0.0f, 1.0f';

        case 'String':
        case 'FilePath':
            const s = typeof param.default === 'string' ? param.default : '';
            return `"${s}"`;

        default:
            return '';
    }
}

/**
 * Generate parameter assignment code for a parameter
 */
function generateParamAssignment(varName: string, param: OperatorParam): string {
    const value = formatParamValue(param);
    if (!value) {
        return '';
    }

    switch (param.type) {
        case 'Vec2':
        case 'Vec3':
            return `${varName}.${param.name}.set(${value});`;

        case 'Color':
            return `${varName}.${param.name}.set(${value});`;

        case 'Float':
        case 'Int':
        case 'Bool':
        case 'String':
        case 'FilePath':
            return `${varName}.${param.name} = ${value};`;

        case 'Vec4':
            return `${varName}.${param.name}.set(${value});`;

        default:
            return '';
    }
}

export interface GeneratedCode {
    declaration: string;
    params: string[];
    inputConnection?: string;
}

/**
 * Generate C++ code for adding an operator to the chain
 */
export function generateOperatorCode(
    operator: OperatorDefinition,
    variableName: string,
    chainName: string,
    previousOperatorVar?: string,
    indent: string = '    '
): GeneratedCode {
    const result: GeneratedCode = {
        declaration: `${indent}auto& ${variableName} = chain.add<${operator.name}>("${chainName}");`,
        params: []
    };

    // Add input connection for effects
    if (operator.requiresInput && previousOperatorVar) {
        result.inputConnection = `${indent}${variableName}.input(&${previousOperatorVar});`;
    }

    // Generate parameter assignments for key parameters
    // Only include a few important params to keep code clean
    const importantParams = operator.params.slice(0, 3); // First 3 params
    for (const param of importantParams) {
        const assignment = generateParamAssignment(variableName, param);
        if (assignment) {
            result.params.push(`${indent}${assignment}`);
        }
    }

    return result;
}

/**
 * Generate full code block for operator insertion
 */
export function generateFullOperatorBlock(
    operator: OperatorDefinition,
    variableName: string,
    chainName: string,
    previousOperatorVar?: string,
    indent: string = '    '
): string {
    const code = generateOperatorCode(operator, variableName, chainName, previousOperatorVar, indent);

    const lines: string[] = [code.declaration];

    if (code.inputConnection) {
        lines.push(code.inputConnection);
    }

    // Add parameter assignments
    for (const param of code.params) {
        lines.push(param);
    }

    return lines.join('\n');
}
