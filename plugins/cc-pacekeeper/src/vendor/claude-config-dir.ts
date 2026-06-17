// SPDX-License-Identifier: MIT
// Extracted from ccstatusline (https://github.com/sirmalloc/ccstatusline)
// Copyright (c) 2025 Matthew Breedlove. Used under the MIT License.
// Upstream: src/utils/claude-settings.ts @ 151521ca6e (getClaudeConfigDir only)

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Determines the Claude config directory, checking CLAUDE_CONFIG_DIR
 * environment variable first, then falling back to the default
 * ~/.claude directory.
 */
export function getClaudeConfigDir(): string {
    const envConfigDir = process.env.CLAUDE_CONFIG_DIR;

    if (envConfigDir) {
        try {
            const resolvedPath = path.resolve(envConfigDir);
            if (fs.existsSync(resolvedPath)) {
                const stats = fs.statSync(resolvedPath);
                if (stats.isDirectory()) {
                    return resolvedPath;
                }
            } else {
                return resolvedPath;
            }
        } catch {
            // Fall through to default on any error
        }
    }

    return path.join(os.homedir(), '.claude');
}
