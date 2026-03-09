// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BaseAdapter, containsGarble, DEFAULT_TIMEOUTS } from './base-adapter.js';

describe('BaseAdapter', () => {
    it('throws if instantiated directly', () => {
        assert.throws(
            () => new BaseAdapter('test'),
            /BaseAdapter is abstract/
        );
    });

    it('allows subclass instantiation', () => {
        class TestAdapter extends BaseAdapter {
            buildCommand() { return { cmd: 'echo', args: ['hi'] }; }
            parseChunk() { return []; }
            parseResult() { return []; }
        }
        const adapter = new TestAdapter('test-agent');
        assert.equal(adapter.agentId, 'test-agent');
    });

    it('uses default timeouts when no options provided', () => {
        class TestAdapter extends BaseAdapter {
            buildCommand() { return { cmd: 'echo', args: [] }; }
            parseChunk() { return []; }
            parseResult() { return []; }
        }
        const adapter = new TestAdapter('test', {});
        assert.equal(adapter.timeouts.firstByteMs, DEFAULT_TIMEOUTS.firstByteMs);
        assert.equal(adapter.timeouts.idleMs, DEFAULT_TIMEOUTS.idleMs);
        assert.equal(adapter.timeouts.hardMs, DEFAULT_TIMEOUTS.hardMs);
    });

    it('accepts custom timeout overrides', () => {
        class TestAdapter extends BaseAdapter {
            buildCommand() { return { cmd: 'echo', args: [] }; }
            parseChunk() { return []; }
            parseResult() { return []; }
        }
        const adapter = new TestAdapter('test', {
            firstByteMs: 1000,
            idleMs: 2000,
            hardMs: 3000,
        });
        assert.equal(adapter.timeouts.firstByteMs, 1000);
        assert.equal(adapter.timeouts.idleMs, 2000);
        assert.equal(adapter.timeouts.hardMs, 3000);
    });

    it('timeouts object is frozen', () => {
        class TestAdapter extends BaseAdapter {
            buildCommand() { return { cmd: 'echo', args: [] }; }
            parseChunk() { return []; }
            parseResult() { return []; }
        }
        const adapter = new TestAdapter('test');
        assert.ok(Object.isFrozen(adapter.timeouts));
    });

    it('abstract methods throw if not overridden', () => {
        class PartialAdapter extends BaseAdapter {
            // Intentionally don't override anything
        }
        // Need a workaround to instantiate abstract
        const proto = PartialAdapter.prototype;
        assert.throws(() => proto.buildCommand('', ''), /must be overridden/);
        assert.throws(() => proto.parseChunk('', ''), /must be overridden/);
        assert.throws(() => proto.parseResult('', ''), /must be overridden/);
    });
});

describe('BaseAdapter.execute (integration with echo)', () => {
    it('returns stream and done', () => {
        class EchoAdapter extends BaseAdapter {
            buildCommand() {
                if (process.platform === 'win32') {
                    return { cmd: 'cmd', args: ['/c', 'echo', 'hello world'] };
                }
                return { cmd: 'echo', args: ['hello world'] };
            }
            parseChunk(chunk, sessionId) { return []; }
            parseResult(allOutput) { return []; }
        }

        const adapter = new EchoAdapter('echo-test', {
            firstByteMs: 5000,
            idleMs: 5000,
            hardMs: 10000,
        });

        const { stream, done } = adapter.execute('sess-1', process.cwd(), 'test prompt');

        // Verify return shape
        assert.ok(stream);
        assert.ok(typeof stream[Symbol.asyncIterator] === 'function');
        assert.ok(done instanceof Promise);
    });

    it('passes adapter env overrides to child process', async () => {
        class EnvAdapter extends BaseAdapter {
            buildCommand() {
                if (process.platform === 'win32') {
                    return { cmd: 'cmd', args: ['/c', 'echo', '%TEST_ROUTER_ENV%'] };
                }
                return { cmd: 'sh', args: ['-c', 'echo "$TEST_ROUTER_ENV"'] };
            }
            getExecutionOptions() {
                return { env: { TEST_ROUTER_ENV: '9router' } };
            }
            parseChunk() { return []; }
            parseResult(allOutput) {
                return allOutput.includes('9router') ? [] : [{ missing: true }];
            }
        }

        const adapter = new EnvAdapter('env-test', {
            firstByteMs: 5000,
            idleMs: 5000,
            hardMs: 10000,
        });

        const { done } = adapter.execute('sess-1', process.cwd(), 'test');
        const result = await done;

        assert.equal(result.status, 'ok');
        assert.equal(result.findings.length, 0);
    });

    it('completes with ok status for successful command', async () => {
        class EchoAdapter extends BaseAdapter {
            buildCommand() {
                if (process.platform === 'win32') {
                    return { cmd: 'cmd', args: ['/c', 'echo', 'test output'] };
                }
                return { cmd: 'echo', args: ['test output'] };
            }
            parseChunk() { return []; }
            parseResult() { return []; }
        }

        const adapter = new EchoAdapter('echo-test', {
            firstByteMs: 5000,
            idleMs: 5000,
            hardMs: 10000,
        });

        const { done } = adapter.execute('sess-1', process.cwd(), 'test');
        const result = await done;

        assert.equal(result.status, 'ok');
        assert.ok(Array.isArray(result.findings));
        assert.ok(result.timingMs.totalMs > 0);
        assert.ok(result.timingMs.firstByteMs >= 0);
    });

    it('streams events including started and done status', async () => {
        class EchoAdapter extends BaseAdapter {
            buildCommand() {
                if (process.platform === 'win32') {
                    return { cmd: 'cmd', args: ['/c', 'echo', 'data'] };
                }
                return { cmd: 'echo', args: ['data'] };
            }
            parseChunk() { return []; }
            parseResult() { return []; }
        }

        const adapter = new EchoAdapter('echo-test', {
            firstByteMs: 5000,
            idleMs: 5000,
            hardMs: 10000,
        });

        const { stream, done } = adapter.execute('sess-1', process.cwd(), 'test');

        const events = [];
        for await (const event of stream) {
            events.push(event);
        }
        await done;

        // Should have at least 'started' status and 'done' status
        const statusEvents = events.filter((e) => e.event_type === 'status');
        const startedEvent = statusEvents.find((e) => e.payload.state === 'started');
        const doneEvent = statusEvents.find((e) => e.payload.state === 'done');

        assert.ok(startedEvent, 'Should emit started status');
        assert.ok(doneEvent, 'Should emit done status');
    });

    it('returns failed status for nonexistent command', async () => {
        class BadAdapter extends BaseAdapter {
            buildCommand() {
                return { cmd: 'nonexistent_command_xyz_12345', args: [] };
            }
            parseChunk() { return []; }
            parseResult() { return []; }
        }

        const adapter = new BadAdapter('bad-test', {
            firstByteMs: 5000,
            idleMs: 5000,
            hardMs: 10000,
        });

        const { done } = adapter.execute('sess-1', process.cwd(), 'test');
        const result = await done;

        assert.equal(result.status, 'failed');
    });
});

describe('containsGarble', () => {
    it('returns false for clean text', () => {
        assert.equal(containsGarble('Hello, world!'), false);
    });

    it('returns true for text with replacement character', () => {
        assert.equal(containsGarble('Hello \ufffd world'), true);
    });

    it('returns false for empty string', () => {
        assert.equal(containsGarble(''), false);
    });

    it('returns false for Unicode text without garble', () => {
        assert.equal(containsGarble('Thiếu kiểm tra null 日本語'), false);
    });

    it('returns true for single replacement character', () => {
        assert.equal(containsGarble('\ufffd'), true);
    });
});

describe('DEFAULT_TIMEOUTS', () => {
    it('has expected default values', () => {
        assert.equal(DEFAULT_TIMEOUTS.firstByteMs, 60000);
        assert.equal(DEFAULT_TIMEOUTS.idleMs, 30000);
        assert.equal(DEFAULT_TIMEOUTS.hardMs, 300000);
    });

    it('is frozen', () => {
        assert.ok(Object.isFrozen(DEFAULT_TIMEOUTS));
    });
});
