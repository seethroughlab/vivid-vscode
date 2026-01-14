// Header Parser - extracts @par Example blocks from Vivid header files
// Uses comment-parser library for robust Doxygen-style comment parsing

import * as fs from 'fs';
import * as path from 'path';
import { parse, Block } from 'comment-parser';

export interface OperatorExample {
    operatorName: string;
    description: string;      // @brief content
    exampleCode: string;      // @code block content
}

/**
 * Parse a Vivid header file to extract the operator example
 * Uses comment-parser with spacing: 'preserve' to capture multiline @code blocks
 */
export function parseHeaderFile(headerContent: string, operatorName: string): OperatorExample | null {
    // Parse all comment blocks
    const blocks = parse(headerContent, { spacing: 'preserve' });

    // Find the block that contains @brief and @code (class documentation)
    // Skip file-level comments (they have @file tag)
    for (const block of blocks) {
        const hasFileTag = block.tags.some(t => t.tag === 'file');
        if (hasFileTag) {
            continue; // Skip file-level documentation
        }

        const briefTag = block.tags.find(t => t.tag === 'brief');
        const codeTag = block.tags.find(t => t.tag === 'code');

        if (briefTag && codeTag) {
            // Extract description from @brief
            const description = cleanDescription(briefTag.name + ' ' + briefTag.description);

            // Extract code from @code tag's description (contains multiline content)
            const exampleCode = cleanCodeBlock(codeTag.description);

            if (exampleCode) {
                return {
                    operatorName,
                    description,
                    exampleCode
                };
            }
        }
    }

    return null;
}

/**
 * Clean up a description string
 */
function cleanDescription(desc: string): string {
    return desc
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Clean up a code block (remove leading asterisks and normalize)
 */
function cleanCodeBlock(code: string): string {
    if (!code) return '';

    const lines = code.split('\n');

    // Remove leading * from each line and trim
    const cleanedLines = lines.map(line => {
        return line.replace(/^\s*\*\s?/, '').trimEnd();
    });

    // Find minimum indentation (ignoring empty lines)
    let minIndent = Infinity;
    for (const line of cleanedLines) {
        if (line.trim().length > 0) {
            const indent = line.match(/^\s*/)?.[0].length || 0;
            minIndent = Math.min(minIndent, indent);
        }
    }

    if (minIndent === Infinity) {
        minIndent = 0;
    }

    // Remove common indentation
    const normalized = cleanedLines
        .map(line => line.slice(minIndent))
        .join('\n')
        .trim();

    return normalized;
}

/**
 * Find the absolute path to a header file given the runtime path and relative header path
 */
export function findHeaderPath(runtimePath: string, relativeHeaderPath: string): string | null {
    // The runtime is typically at ~/.vivid/runtime/vivid-X.X.X/bin/vivid
    // Headers are at ~/.vivid/runtime/vivid-X.X.X/modules/...

    // Get the runtime root (parent of bin/)
    const runtimeDir = path.dirname(runtimePath);
    const runtimeRoot = path.dirname(runtimeDir);

    // Check if headers exist at the expected location
    const headerPath = path.join(runtimeRoot, relativeHeaderPath);

    if (fs.existsSync(headerPath)) {
        return headerPath;
    }

    // For development builds, the header might be relative to the source tree
    // Check a few common patterns
    const devPatterns = [
        path.join(runtimeRoot, '..', relativeHeaderPath),
        path.join(runtimeRoot, '..', '..', relativeHeaderPath),
    ];

    for (const pattern of devPatterns) {
        if (fs.existsSync(pattern)) {
            return pattern;
        }
    }

    return null;
}

/**
 * Read and parse a header file to extract the operator example
 */
export async function loadOperatorExample(
    runtimePath: string,
    relativeHeaderPath: string,
    operatorName: string
): Promise<OperatorExample | null> {
    const headerPath = findHeaderPath(runtimePath, relativeHeaderPath);

    if (!headerPath) {
        return null;
    }

    try {
        const content = await fs.promises.readFile(headerPath, 'utf-8');
        return parseHeaderFile(content, operatorName);
    } catch (e) {
        return null;
    }
}
