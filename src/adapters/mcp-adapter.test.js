// @ts-check
/**
 * Unit tests for MCP Adapter — error classification, finding conversion,
 * and state machine transitions.
 *
 * @module adapters/mcp-adapter.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    classifyMcpError,
    isRetryable,
    convertMcpFindings,
    parseMcpMessages,
    writeMcpMessage,
    MCP_STATES,
    MAX_RETRIES,
    McpCodexAdapter,
} from './mcp-adapter.js';

// ── Error Classification ─────────────────────────────

describe('classifyMcpError', () => {
    it('classifies ENOENT as spawn_error', () => {
        assert.equal(classifyMcpError(new Error('ENOENT: python not found')), 'spawn_error');
    });

    it('classifies spawn failure as spawn_error', () => {
        assert.equal(classifyMcpError(new Error('Failed to spawn process')), 'spawn_error');
    });

    it('classifies no such file as spawn_error', () => {
        assert.equal(classifyMcpError(new Error('No such file or directory')), 'spawn_error');
    });

    it('classifies timeout as timeout', () => {
        assert.equal(classifyMcpError(new Error('MCP request timed out after 600s')), 'timeout');
    });

    it('classifies stall as stall', () => {
        assert.equal(classifyMcpError(new Error('Process stall detected, idle too long')), 'stall');
    });

    it('classifies idle detection as stall', () => {
        assert.equal(classifyMcpError(new Error('idle timeout exceeded')), 'stall');
    });

    it('classifies JSON parse error as protocol_error', () => {
        assert.equal(classifyMcpError(new Error('Unexpected token in JSON')), 'protocol_error');
    });

    it('classifies protocol issue as protocol_error', () => {
        assert.equal(classifyMcpError(new Error('Protocol version mismatch')), 'protocol_error');
    });

    it('classifies unknown errors as unknown', () => {
        assert.equal(classifyMcpError(new Error('Something completely different')), 'unknown');
    });

    it('handles non-Error arguments', () => {
        assert.equal(classifyMcpError('some string error'), 'unknown');
    });

    it('handles ENOENT in string form', () => {
        assert.equal(classifyMcpError('ENOENT: no such file'), 'spawn_error');
    });
});

// ── Retryable Check ──────────────────────────────────

describe('isRetryable', () => {
    it('spawn_error is retryable', () => {
        assert.equal(isRetryable('spawn_error'), true);
    });

    it('stall is retryable', () => {
        assert.equal(isRetryable('stall'), true);
    });

    it('timeout is NOT retryable', () => {
        assert.equal(isRetryable('timeout'), false);
    });

    it('protocol_error is NOT retryable', () => {
        assert.equal(isRetryable('protocol_error'), false);
    });

    it('unknown is NOT retryable', () => {
        assert.equal(isRetryable('unknown'), false);
    });
});

// ── Finding Conversion ───────────────────────────────

describe('convertMcpFindings', () => {
    it('converts a finding with all fields', () => {
        const mcpFindings = [{
            summary: 'Missing null check',
            severity: 'high',
            confidence: 0.9,
            file: 'src/server.js',
            line: 42,
            evidence: 'Variable can be null at line 42',
            fix_instructions: 'Add null check before usage',
            why_it_matters: 'Crash in production',
        }];

        const results = convertMcpFindings(mcpFindings);
        assert.equal(results.length, 1);
        assert.equal(results[0].summary, 'Missing null check');
        assert.equal(results[0].severity, 'high');
        assert.equal(results[0].confidence, 0.9);
        assert.equal(results[0].file, 'src/server.js');
        assert.equal(results[0].line, 42);
    });

    it('maps severity aliases (error → critical, warning → high)', () => {
        const findings = convertMcpFindings([
            { summary: 'A', severity: 'error' },
            { summary: 'B', severity: 'warning' },
            { summary: 'C', severity: 'info' },
            { summary: 'D', severity: 'hint' },
        ]);

        assert.equal(findings[0].severity, 'critical');
        assert.equal(findings[1].severity, 'high');
        assert.equal(findings[2].severity, 'medium');
        assert.equal(findings[3].severity, 'low');
    });

    it('defaults severity to medium for unknown values', () => {
        const findings = convertMcpFindings([
            { summary: 'A', severity: 'banana' },
        ]);
        assert.equal(findings[0].severity, 'medium');
    });

    it('clamps confidence to [0, 1]', () => {
        const findings = convertMcpFindings([
            { summary: 'A', confidence: 1.5 },
            { summary: 'B', confidence: -0.3 },
        ]);
        assert.equal(findings[0].confidence, 1);
        assert.equal(findings[1].confidence, 0);
    });

    it('defaults confidence to 0.5 if missing', () => {
        const findings = convertMcpFindings([
            { summary: 'A' },
        ]);
        assert.equal(findings[0].confidence, 0.5);
    });

    it('skips findings with empty summary', () => {
        const findings = convertMcpFindings([
            { summary: '' },
            { summary: 'Valid' },
        ]);
        assert.equal(findings.length, 1);
        assert.equal(findings[0].summary, 'Valid');
    });

    it('falls back to title or message for summary', () => {
        const findings = convertMcpFindings([
            { title: 'From title' },
            { message: 'From message' },
        ]);
        assert.equal(findings[0].summary, 'From title');
        assert.equal(findings[1].summary, 'From message');
    });

    it('returns empty array for empty input', () => {
        assert.deepEqual(convertMcpFindings([]), []);
    });
});

// ── Legacy Protocol Helpers ──────────────────────────

describe('parseMcpMessages (deprecated, backward compat)', () => {
    it('parses a single framed message', () => {
        const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} });
        const frame = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
        const { messages, remaining } = parseMcpMessages(frame);
        assert.equal(messages.length, 1);
        assert.deepEqual(messages[0], { jsonrpc: '2.0', id: 1, result: {} });
        assert.equal(remaining.length, 0);
    });

    it('handles incomplete message', () => {
        const body = '{"partial":';
        const frame = Buffer.from(`Content-Length: 100\r\n\r\n${body}`);
        const { messages, remaining } = parseMcpMessages(frame);
        assert.equal(messages.length, 0);
    });
});

// ── Adapter Class ────────────────────────────────────

describe('McpCodexAdapter', () => {
    it('has agentId mcp-codex', () => {
        const adapter = new McpCodexAdapter();
        assert.equal(adapter.agentId, 'mcp-codex');
    });

    it('starts in idle state', () => {
        const adapter = new McpCodexAdapter();
        assert.equal(adapter._state, MCP_STATES.IDLE);
    });

    it('transitions state correctly', () => {
        const adapter = new McpCodexAdapter();
        adapter._transition(MCP_STATES.SPAWNING);
        assert.equal(adapter._state, MCP_STATES.SPAWNING);
        adapter._transition(MCP_STATES.RECOVERING);
        assert.equal(adapter._state, MCP_STATES.RECOVERING);
    });

    it('buildCommand returns python with correct args', () => {
        const adapter = new McpCodexAdapter();
        const { cmd, args } = adapter.buildCommand('/project/snapshot', 'review code');
        assert.equal(cmd, 'python');
        assert.ok(args.includes('--workspace'));
        assert.ok(args.includes('/project/snapshot'));
        assert.ok(args.includes('--schema'));
    });

    it('parseChunk returns empty array (protocol handled by SDK)', () => {
        const adapter = new McpCodexAdapter();
        assert.deepEqual(adapter.parseChunk('data', 'session-1'), []);
    });

    it('parseResult returns empty array (protocol handled by SDK)', () => {
        const adapter = new McpCodexAdapter();
        assert.deepEqual(adapter.parseResult('data', 'session-1'), []);
    });
});

// ── Constants ────────────────────────────────────────

describe('Constants', () => {
    it('STATES includes RECOVERING', () => {
        assert.ok('RECOVERING' in MCP_STATES);
        assert.equal(MCP_STATES.RECOVERING, 'recovering');
    });

    it('MAX_RETRIES is 2', () => {
        assert.equal(MAX_RETRIES, 2);
    });
});
