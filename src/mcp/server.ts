#!/usr/bin/env node
/**
 * Vivid MCP Server
 *
 * Serves Vivid API documentation to Claude Code via the Model Context Protocol.
 * This is a standalone script spawned by Claude Code.
 *
 * Usage: node ~/.vivid/mcp-server.js
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
    ListToolsRequestSchema,
    CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Documentation directory - check env var first for local dev, fall back to ~/.vivid/docs
const DOCS_DIR = process.env.VIVID_DOCS_DIR || path.join(os.homedir(), '.vivid', 'docs');

// Documentation files and their descriptions
const DOC_FILES: Record<string, { file: string; description: string }> = {
    'reference': {
        file: 'LLM-REFERENCE.md',
        description: 'Core Vivid API reference - operators, chain API, context, common patterns'
    },
    'operator-api': {
        file: 'OPERATOR-API.md',
        description: 'Guide for creating custom operators - lifecycle, parameters, shaders'
    },
    'audio': {
        file: 'audio.md',
        description: 'vivid-audio addon - synthesis, effects, analysis, sequencing'
    },
    'video': {
        file: 'video.md',
        description: 'vivid-video addon - video playback, webcam capture'
    },
    'render3d': {
        file: 'render3d.md',
        description: 'vivid-render3d addon - 3D primitives, CSG, PBR rendering, instancing'
    }
};

/**
 * Read a documentation file
 */
function readDocFile(docId: string): string | null {
    const docInfo = DOC_FILES[docId];
    if (!docInfo) {
        return null;
    }

    const filePath = path.join(DOCS_DIR, docInfo.file);
    if (!fs.existsSync(filePath)) {
        return null;
    }

    return fs.readFileSync(filePath, 'utf8');
}

/**
 * Search across all documentation files
 */
function searchDocs(query: string): { docId: string; matches: string[] }[] {
    const results: { docId: string; matches: string[] }[] = [];
    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter(t => t.length > 2);

    for (const [docId, docInfo] of Object.entries(DOC_FILES)) {
        const content = readDocFile(docId);
        if (!content) continue;

        const lines = content.split('\n');
        const matches: string[] = [];

        // Find lines containing query terms
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const lineLower = line.toLowerCase();

            // Check if line contains any query terms
            const hasMatch = queryTerms.some(term => lineLower.includes(term));
            if (hasMatch) {
                // Include context: 2 lines before and after
                const start = Math.max(0, i - 2);
                const end = Math.min(lines.length - 1, i + 2);
                const context = lines.slice(start, end + 1).join('\n');

                // Avoid duplicate contexts
                if (!matches.includes(context)) {
                    matches.push(context);
                }
            }
        }

        if (matches.length > 0) {
            results.push({ docId, matches: matches.slice(0, 5) }); // Limit to 5 matches per doc
        }
    }

    return results;
}

/**
 * Get operator information from the reference doc
 */
function getOperatorInfo(operatorName: string): string | null {
    const content = readDocFile('reference');
    if (!content) return null;

    const nameLower = operatorName.toLowerCase();
    const lines = content.split('\n');

    // Find the operator in a table or heading
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineLower = line.toLowerCase();

        // Check if line contains operator name in a table row or heading
        if (lineLower.includes(`\`${nameLower}\``) ||
            lineLower.includes(`| ${nameLower} |`) ||
            lineLower.match(new RegExp(`^###?\\s+${nameLower}`, 'i'))) {

            // Gather context - find section boundaries
            const contextLines: string[] = [];

            // Go back to find section header
            let start = i;
            for (let j = i; j >= 0; j--) {
                if (lines[j].startsWith('##')) {
                    start = j;
                    break;
                }
            }

            // Go forward to find next section or table end
            let end = i;
            for (let j = i + 1; j < lines.length; j++) {
                if (lines[j].startsWith('##') || (lines[j].trim() === '' && j > i + 3)) {
                    end = j - 1;
                    break;
                }
                end = j;
            }

            return lines.slice(start, end + 1).join('\n');
        }
    }

    return null;
}

async function main() {
    const server = new Server(
        {
            name: 'vivid',
            version: '1.0.0',
        },
        {
            capabilities: {
                resources: {},
                tools: {},
            },
        }
    );

    // List available resources
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
        const resources = Object.entries(DOC_FILES)
            .filter(([docId]) => {
                const filePath = path.join(DOCS_DIR, DOC_FILES[docId].file);
                return fs.existsSync(filePath);
            })
            .map(([docId, info]) => ({
                uri: `vivid://docs/${docId}`,
                name: `Vivid ${docId} documentation`,
                description: info.description,
                mimeType: 'text/markdown',
            }));

        return { resources };
    });

    // Read a specific resource
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        const uri = request.params.uri;
        const match = uri.match(/^vivid:\/\/docs\/(.+)$/);

        if (!match) {
            throw new Error(`Invalid resource URI: ${uri}`);
        }

        const docId = match[1];
        const content = readDocFile(docId);

        if (!content) {
            throw new Error(`Documentation not found: ${docId}. Make sure Vivid runtime is installed.`);
        }

        return {
            contents: [
                {
                    uri,
                    mimeType: 'text/markdown',
                    text: content,
                },
            ],
        };
    });

    // List available tools
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: [
                {
                    name: 'search_vivid_docs',
                    description: 'Search across all Vivid documentation for relevant information. Use this to find operators, patterns, or API details.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            query: {
                                type: 'string',
                                description: 'Search query (e.g., "noise operator", "feedback effect", "audio synthesis")',
                            },
                        },
                        required: ['query'],
                    },
                },
                {
                    name: 'get_vivid_operator',
                    description: 'Get detailed information about a specific Vivid operator including parameters and usage examples.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            name: {
                                type: 'string',
                                description: 'Operator name (e.g., "Noise", "Blur", "Feedback", "VideoPlayer")',
                            },
                        },
                        required: ['name'],
                    },
                },
            ],
        };
    });

    // Handle tool calls
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;

        if (name === 'search_vivid_docs') {
            const query = (args as { query: string }).query;
            const results = searchDocs(query);

            if (results.length === 0) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `No results found for "${query}". Try different search terms or read the full documentation using the resources.`,
                        },
                    ],
                };
            }

            let output = `## Search Results for "${query}"\n\n`;
            for (const result of results) {
                output += `### From ${result.docId}\n`;
                for (const match of result.matches) {
                    output += `\`\`\`\n${match}\n\`\`\`\n\n`;
                }
            }

            return {
                content: [
                    {
                        type: 'text',
                        text: output,
                    },
                ],
            };
        }

        if (name === 'get_vivid_operator') {
            const operatorName = (args as { name: string }).name;
            const info = getOperatorInfo(operatorName);

            if (!info) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Operator "${operatorName}" not found. Try searching with search_vivid_docs or check the operator spelling.`,
                        },
                    ],
                };
            }

            return {
                content: [
                    {
                        type: 'text',
                        text: info,
                    },
                ],
            };
        }

        throw new Error(`Unknown tool: ${name}`);
    });

    // Start the server
    const transport = new StdioServerTransport();
    await server.connect(transport);

    // Log startup (to stderr so it doesn't interfere with stdio protocol)
    console.error('Vivid MCP server started');
}

main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
