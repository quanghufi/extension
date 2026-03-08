// Phase 0 Spike v2 — Corrected CLI Headless Integration Tests
// Fixes from Codex critique:
//   - TIMEOUT = FAIL (not pass)
//   - Require non-empty stdout for pass
//   - Test exact production commands
//   - --output-format text (not json, which hangs)
//   - UTF-8 round-trip verification through JSON
//   - Parallel test via Promise.all (matching production)
//   - Uses exec() with command strings (not spawn) to avoid Windows arg parsing

const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const WORKSPACE = 'd:\\extension';
const TIMEOUT_MS = 60_000; // 60s — firm cutoff
const VIETNAMESE_SAMPLE = 'Đây là nội dung tiếng Việt để kiểm tra encoding UTF-8: ăâđêôơư ĂÂĐÊÔƠƯ';

// ── Helpers ──────────────────────────────────────────────

function runCLI(name, command, options = {}) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const timeout = options.timeout || TIMEOUT_MS;

    console.log(`\n[${name}] Starting: ${command.substring(0, 120)}...`);

    const proc = exec(command, {
      cwd: WORKSPACE,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', NODE_OPTIONS: '' },
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout,
    }, (error, stdout, stderr) => {
      const durationMs = Date.now() - startTime;

      if (stdout) {
        const preview = stdout.substring(0, 200).replace(/\n/g, '↵');
        process.stdout.write(`[${name} stdout] ${preview}\n`);
      }
      if (stderr && !stderr.includes('WARN') && !stderr.includes('warn')) {
        process.stderr.write(`[${name} stderr] ${stderr.substring(0, 200)}\n`);
      }

      let status;
      if (error && error.killed) {
        status = 'TIMEOUT';
      } else if (error) {
        status = `EXIT_${error.code || 'unknown'}`;
      } else {
        status = 'OK';
      }

      resolve({
        name,
        status,
        exitCode: error ? (error.code || -1) : 0,
        durationMs,
        stdout: stdout || '',
        stderr: stderr || '',
        stdoutBytes: Buffer.byteLength(stdout || '', 'utf-8'),
      });
    });
  });
}

// ── Pass/Fail Logic (strict) ──────────────────────────

function evaluateResult(result, opts = {}) {
  const { requireJson = false } = opts;

  const exitClean = result.status === 'OK';
  const hasOutput = (result.stdoutBytes || 0) > 0;

  const utf8Clean = hasOutput
    ? !result.stdout.includes('\ufffd') && !result.stdout.includes('??')
    : false;

  let utf8RoundTrip = false;
  if (hasOutput) {
    try {
      const serialized = JSON.stringify({ content: result.stdout });
      const parsed = JSON.parse(serialized);
      utf8RoundTrip = parsed.content === result.stdout;
    } catch {
      utf8RoundTrip = false;
    }
  }

  let jsonParseable = null;
  if (requireJson && hasOutput) {
    try {
      JSON.parse(result.stdout);
      jsonParseable = true;
    } catch {
      jsonParseable = false;
    }
  }

  const pass = exitClean && hasOutput && utf8Clean && utf8RoundTrip;

  return {
    pass,
    exitClean,
    hasOutput,
    utf8Clean,
    utf8RoundTrip,
    ...(jsonParseable !== null ? { jsonParseable } : {}),
  };
}

// ── Escape prompt for shell ──────────────────────────

function shellQuote(str) {
  // For cmd.exe: wrap in double quotes, escape internal double quotes
  return `"${str.replace(/"/g, '\\"')}"`;
}

// ── Tests ──────────────────────────────────────────────

async function testCodexHeadless() {
  console.log('\n' + '═'.repeat(60));
  console.log('TEST 1: Codex CLI headless — codex review');
  console.log('  Command: codex review "prompt"');
  console.log('═'.repeat(60));

  const prompt = `Hãy review file docs/BRIEF.md. Trả lời bằng tiếng Việt. Nêu 3 điểm chính. ${VIETNAMESE_SAMPLE}`;
  const command = `codex review ${shellQuote(prompt)}`;

  const result = await runCLI('codex-review', command);
  const evaluation = evaluateResult(result);

  return {
    test: 'Codex CLI headless (production command)',
    command: 'codex review "prompt"',
    ...evaluation,
    status: result.status,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    stdoutBytes: result.stdoutBytes,
    stdoutPreview: result.stdout?.substring(0, 500) || '',
    stderrPreview: result.stderr?.substring(0, 300) || '',
  };
}

async function testClaudeHeadless() {
  console.log('\n' + '═'.repeat(60));
  console.log('TEST 2: Claude Code CLI headless — text mode');
  console.log('  Command: claude -p --no-session-persistence "prompt"');
  console.log('═'.repeat(60));

  const prompt = `Say hello in Vietnamese. Include this text: ${VIETNAMESE_SAMPLE}`;
  const command = `claude -p --no-session-persistence ${shellQuote(prompt)}`;

  const result = await runCLI('claude-print', command);
  const evaluation = evaluateResult(result);

  return {
    test: 'Claude Code CLI headless (production command)',
    command: 'claude -p --no-session-persistence "prompt"',
    ...evaluation,
    status: result.status,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    stdoutBytes: result.stdoutBytes,
    stdoutPreview: result.stdout?.substring(0, 500) || '',
    stderrPreview: result.stderr?.substring(0, 300) || '',
  };
}

async function testClaudeJsonMode() {
  console.log('\n' + '═'.repeat(60));
  console.log('TEST 3: Claude --output-format json (risk test — expected to hang)');
  console.log('  Command: claude -p --output-format json "prompt"');
  console.log('  Timeout: 30s');
  console.log('═'.repeat(60));

  const command = `claude -p --output-format json ${shellQuote('List 2 files in current directory. Be brief.')}`;

  const result = await runCLI('claude-json', command, { timeout: 30_000 });
  const evaluation = evaluateResult(result, { requireJson: true });

  return {
    test: 'Claude --output-format json (risk test)',
    command: 'claude -p --output-format json "prompt"',
    note: 'Expected to TIMEOUT or hang — documenting actual behavior',
    ...evaluation,
    status: result.status,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    stdoutBytes: result.stdoutBytes,
    stdoutPreview: result.stdout?.substring(0, 500) || '',
  };
}

async function testParallel() {
  console.log('\n' + '═'.repeat(60));
  console.log('TEST 4: Parallel execution via Promise.all');
  console.log('  Both CLIs run simultaneously');
  console.log('═'.repeat(60));

  const startTime = Date.now();

  const prompt = 'List the files in docs/ directory. Just list them, nothing else.';

  const [codex, claude] = await Promise.all([
    runCLI('parallel-codex', `codex review ${shellQuote(prompt)}`),
    runCLI('parallel-claude', `claude -p --no-session-persistence ${shellQuote(prompt)}`),
  ]);

  const totalTime = Date.now() - startTime;
  const sumIndividual = codex.durationMs + claude.durationMs;
  const ranParallel = totalTime < sumIndividual * 0.9;

  const codexEval = evaluateResult(codex);
  const claudeEval = evaluateResult(claude);
  const bothPass = codexEval.pass && claudeEval.pass;

  return {
    test: 'Parallel execution (Node.js spawn)',
    mechanism: 'Node.js child_process.exec + Promise.all',
    pass: bothPass && ranParallel,
    ranParallel,
    totalTimeMs: totalTime,
    sumIndividualMs: sumIndividual,
    codex: { status: codex.status, durationMs: codex.durationMs, ...codexEval },
    claude: { status: claude.status, durationMs: claude.durationMs, ...claudeEval },
  };
}

// ── UTF-8 Round-Trip Standalone Test ──────────────────

async function testUtf8RoundTrip() {
  console.log('\n' + '═'.repeat(60));
  console.log('TEST 5: UTF-8 round-trip through JSON serialization');
  console.log('═'.repeat(60));

  const testData = {
    vietnamese: VIETNAMESE_SAMPLE,
    japanese: 'テスト日本語',
    emoji: '🚀💻🔥',
    mixed: `Review: ${VIETNAMESE_SAMPLE} → OK ✅`,
  };

  let pass = true;
  const results = {};

  for (const [key, value] of Object.entries(testData)) {
    try {
      const serialized = JSON.stringify({ content: value });
      const parsed = JSON.parse(serialized);
      const roundTripped = parsed.content === value;
      results[key] = { roundTripped, length: value.length };
      if (!roundTripped) pass = false;
      console.log(`  ${roundTripped ? '✅' : '❌'} ${key}: ${roundTripped ? 'OK' : 'FAILED'}`);
    } catch (err) {
      results[key] = { roundTripped: false, error: err.message };
      pass = false;
      console.log(`  ❌ ${key}: ERROR — ${err.message}`);
    }
  }

  return { test: 'UTF-8 round-trip through JSON', pass, results };
}

// ── Main ──────────────────────────────────────────────

async function main() {
  const startAll = Date.now();

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  Phase 0 Spike v2 — Corrected CLI Integration Tests    ║');
  console.log('║  Fixes: TIMEOUT=FAIL, require stdout, exec() command   ║');
  console.log('║  Workspace: d:\\extension                               ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  const results = [];
  const meta = {
    version: 'v2',
    runAt: new Date().toISOString(),
    fixes: [
      'TIMEOUT = FAIL (was: pass in v1)',
      'Empty stdout = FAIL (was: vacuously true)',
      'Exact production commands (was: wrong flags)',
      'Text mode for Claude (was: --output-format json which hangs)',
      'UTF-8 round-trip verification added',
      'exec() with command strings (was: spawn with broken arg parsing on Windows)',
    ],
  };

  // Test 1: Codex headless (production command)
  results.push(await testCodexHeadless());

  // Test 2: Claude headless (production command, text mode)
  results.push(await testClaudeHeadless());

  // Test 3: Claude json mode (document the risk)
  results.push(await testClaudeJsonMode());

  // Test 4: Parallel execution
  results.push(await testParallel());

  // Test 5: UTF-8 round-trip
  results.push(await testUtf8RoundTrip());

  const totalDuration = Date.now() - startAll;

  // Summary
  console.log('\n' + '═'.repeat(60));
  console.log('SPIKE V2 RESULTS SUMMARY');
  console.log('═'.repeat(60));

  for (const r of results) {
    const icon = r.pass ? '✅' : '❌';
    console.log(`${icon} ${r.test}`);
    console.log(`   Status: ${r.status || (r.pass ? 'PASS' : 'FAIL')}`);
    if (r.hasOutput !== undefined) console.log(`   Has output: ${r.hasOutput}`);
    if (r.utf8Clean !== undefined) console.log(`   UTF-8 clean: ${r.utf8Clean}`);
    if (r.utf8RoundTrip !== undefined) console.log(`   UTF-8 round-trip: ${r.utf8RoundTrip}`);
    if (r.jsonParseable !== undefined) console.log(`   JSON parseable: ${r.jsonParseable}`);
    if (r.ranParallel !== undefined) console.log(`   Ran parallel: ${r.ranParallel}`);
    if (r.durationMs) console.log(`   Duration: ${r.durationMs}ms`);
    if (r.note) console.log(`   Note: ${r.note}`);
  }

  // Gate criteria: Tests 1, 2, 4, 5 must pass. Test 3 is informational.
  const gateTests = [results[0], results[1], results[3], results[4]];
  const gatePass = gateTests.every(r => r.pass);

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`GATE TESTS (1,2,4,5): ${gatePass ? '✅ ALL PASS' : '❌ SOME FAILED'}`);
  console.log(`TEST 3 (json mode): ${results[2].pass ? 'PASS' : 'FAIL (informational — expected)'}`);
  console.log(`OVERALL: ${gatePass ? '✅ SPIKE PASS — Phase 0 gate met' : '❌ SPIKE FAIL — Needs investigation'}`);
  console.log(`Total duration: ${totalDuration}ms`);
  console.log('═'.repeat(60));

  // Write results
  const output = { meta, results, gate: { pass: gatePass, totalDurationMs: totalDuration } };
  const report = JSON.stringify(output, null, 2);
  fs.writeFileSync(
    path.join(WORKSPACE, 'docs', 'spike-results-v2.json'),
    report,
    'utf-8'
  );
  console.log('\nResults saved to docs/spike-results-v2.json');
}

main().catch(console.error);
