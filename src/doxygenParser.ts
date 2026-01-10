// Doxygen Parser - extracts documentation from C++ header files

import * as fs from 'fs';
import { parse, Block, Spec } from 'comment-parser';

export interface InputDescription {
    name: string;
    description: string;
}

export interface ParsedDoxygenDoc {
    codeExamples: string[];
    inputs: InputDescription[];
    seeAlso: string[];
}

interface DocCache {
    docs: ParsedDoxygenDoc;
    mtime: number;
}

export class DoxygenParser {
    private cache: Map<string, DocCache> = new Map();

    /**
     * Parse documentation from a header file
     * @param absolutePath Absolute path to the header file
     * @returns Parsed documentation or null if file doesn't exist or has no docs
     */
    async parseHeaderFile(absolutePath: string): Promise<ParsedDoxygenDoc | null> {
        // Check if file exists
        if (!fs.existsSync(absolutePath)) {
            return null;
        }

        // Check cache with mtime validation
        const stats = fs.statSync(absolutePath);
        const mtime = stats.mtimeMs;
        const cached = this.cache.get(absolutePath);

        if (cached && cached.mtime === mtime) {
            return cached.docs;
        }

        // Read and parse file
        try {
            const content = fs.readFileSync(absolutePath, 'utf-8');
            const docs = this.parseContent(content);

            // Cache result
            this.cache.set(absolutePath, { docs, mtime });

            return docs;
        } catch (e) {
            console.error(`[DoxygenParser] Error parsing ${absolutePath}:`, e);
            return null;
        }
    }

    /**
     * Clear the cache (useful for refresh)
     */
    clearCache(): void {
        this.cache.clear();
    }

    /**
     * Parse documentation from file content
     */
    private parseContent(content: string): ParsedDoxygenDoc {
        const result: ParsedDoxygenDoc = {
            codeExamples: [],
            inputs: [],
            seeAlso: []
        };

        // Find the class documentation block (the one right before "class ClassName")
        const classDocBlock = this.extractClassDocBlock(content);
        if (!classDocBlock) {
            return result;
        }

        // Parse using comment-parser
        const parsed = parse(classDocBlock);
        if (parsed.length === 0) {
            return result;
        }

        const block = parsed[0];

        // Extract @par Example sections with @code blocks
        result.codeExamples = this.extractCodeExamples(block, classDocBlock);

        // Extract @par Inputs section
        result.inputs = this.extractInputs(block, classDocBlock);

        // Extract @see references
        result.seeAlso = this.extractSeeAlso(block);

        return result;
    }

    /**
     * Extract the documentation block immediately before a class declaration
     */
    private extractClassDocBlock(content: string): string | null {
        // Find pattern: /** ... */ followed by class declaration
        // This regex finds /** ... */ blocks that precede "class ClassName"
        const classDocPattern = /(\/\*\*[\s\S]*?\*\/)\s*class\s+\w+/g;

        let match: RegExpExecArray | null;
        let lastMatch: string | null = null;

        while ((match = classDocPattern.exec(content)) !== null) {
            // Skip file-level doc blocks (those with @file)
            if (!match[1].includes('@file')) {
                lastMatch = match[1];
                break; // Take the first non-file doc block before a class
            }
        }

        return lastMatch;
    }

    /**
     * Extract code examples from @par Example / @code blocks
     */
    private extractCodeExamples(block: Block, rawBlock: string): string[] {
        const examples: string[] = [];

        // comment-parser doesn't handle @code/@endcode well, so parse raw block
        const codePattern = /@code\s*([\s\S]*?)@endcode/g;
        let match: RegExpExecArray | null;

        while ((match = codePattern.exec(rawBlock)) !== null) {
            // Clean up the code: remove leading * from each line
            const code = match[1]
                .split('\n')
                .map(line => {
                    // Remove leading whitespace and * prefix
                    const cleaned = line.replace(/^\s*\*\s?/, '');
                    return cleaned;
                })
                .join('\n')
                .trim();

            if (code) {
                examples.push(code);
            }
        }

        return examples;
    }

    /**
     * Extract input descriptions from @par Inputs section
     */
    private extractInputs(block: Block, rawBlock: string): InputDescription[] {
        const inputs: InputDescription[] = [];

        // Look for @par Inputs section followed by bullet points
        const inputsPattern = /@par\s+Inputs?\s*\n([\s\S]*?)(?=@par|@see|\*\/|$)/i;
        const match = inputsPattern.exec(rawBlock);

        if (match) {
            const inputsSection = match[1];
            // Parse bullet points: "- name: description" or "- **name**: description"
            const bulletPattern = /^\s*\*?\s*-\s+(?:\*\*)?(\w+)(?:\*\*)?[:\s]+(.+)$/gm;
            let bulletMatch: RegExpExecArray | null;

            while ((bulletMatch = bulletPattern.exec(inputsSection)) !== null) {
                inputs.push({
                    name: bulletMatch[1].trim(),
                    description: bulletMatch[2].trim()
                });
            }
        }

        return inputs;
    }

    /**
     * Extract @see references
     */
    private extractSeeAlso(block: Block): string[] {
        const seeAlso: string[] = [];

        // Look for @see tags in parsed block
        for (const tag of block.tags) {
            if (tag.tag === 'see') {
                const ref = `${tag.name} ${tag.description}`.trim();
                if (ref) {
                    seeAlso.push(ref);
                }
            }
        }

        return seeAlso;
    }
}
