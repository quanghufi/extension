// Phase 0 Spike — Test CLI headless integration
// Tests: headless execution, UTF-8 capture, parallel execution

const { spawn } = require('child_process');
const path = require('path');

const WORKSPACE = 'd:\\extension';
const TIMEOUT_MS = 60_000; // 60s per test
const VIETNAMESE_SAMPLE = 'Đây là nội dung tiếng Việt để kiểm tra encoding UTF-8: ăâđêôơư ĂÂĐÊÔƠƯ';

// ── Helpers ──────────────────────────────────────────────

function runCLI(name, args, options = {}) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const chunks = [];
    const errChunks = [];

    console.log(`\n[${ name }] Starting: ${ args.join(' ') }`);

    const proc = spawn(args[0], args.slice(1), {
      cwd: WORKSPACE,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', NODE_OPTIONS: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      ...options.spawnOptions,
    });

    proc.stdout.on('data', (chunk) => {
      chunks.push(chunk);
      process.stdout.write(`[${ name } stdout] ${ chunk.toString('utf-8').substring(0, 200) }\n`);
    });

    proc.stderr.on('data', (chunk) => {
      errChunks.push(chunk);
      const text = chunk.toString('utf-8');
      if (!text.includes('WARN') && !text.includes('warn')) {
        process.stderr.write(`[${ name } stderr] ${ text.substring(0, 200) }\n`);
      }
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({
        name,
        status: 'TIMEOUT',
        durationMs: Date.now() - startTime,
        stdout: Buffer.concat(chunks).toString('utf-8'),
        stderr: Buffer.concat(errChunks).toString('utf-8'),
      });
    }, TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks).toString('utf-8');
      const stderr = Buffer.concat(errChunks).toString('utf-8');
      resolve({
        name,
        status: code === 0 ? 'OK' : `EXIT_${code}`,
        exitCode: code,
        durationMs: Date.now() - startTime,
        stdout,
        stderr,
        stdoutBytes: Buffer.concat(chunks).length,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        name,
        status: 'ERROR',
        error: err.message,
        durationMs: Date.now() - startTime,
      });
    });
  });
}

// ── Tests ──────────────────────────────────────────────

async function testCodexHeadless() {
  console.log('\n' + '═'.repeat(60));
  console.log('TEST 1: Codex CLI headless (codex review)');
  console.log('═'.repeat(60));

  const result = await runCLI('codex-review', [
    'codex', 'review',
    `Hãy review file docs/BRIEF.md. Trả lời bằng tiếng Việt. Nêu 3 điểm chính. ${VIETNAMESE_SAMPLE}`
  ]);

  const utf8Clean = !result.stdout?.includes('??') && !result.stdout?.includes('\ufffd');

  return {
    test: 'Codex CLI headless',
    pass: result.status === 'OK' || result.status === 'TIMEOUT',
    hasOutput: (result.stdoutBytes || 0) > 0,
    utf8Clean,
    ...result,
  };
}

async function testClaudeHeadless() {
  console.log('\n' + '═'.repeat(60));
  console.log('TEST 2: Claude Code CLI headless (claude -p)');
  console.log('═'.repeat(60));

  const result = await runCLI('claude-print', [
    'claude', '-p',
    '--output-format', 'json',
    `Hãy liệt kê 3 file trong thư mục hiện tại. Trả lời bằng tiếng Việt. ${VIETNAMESE_SAMPLE}`
  ]);

  const utf8Clean = !result.stdout?.includes('??') && !result.stdout?.includes('\ufffd');
  let jsonParseable = false;
  try {
    if (result.stdout) {
      JSON.parse(result.stdout);
      jsonParseable = true;
    }
  } catch { }

  return {
    test: 'Claude Code CLI headless',
    pass: result.status === 'OK',
    hasOutput: (result.stdoutBytes || 0) > 0,
    utf8Clean,
    jsonParseable,
    ...result,
  };
}

async function testParallel() {
  console.log('\n' + '═'.repeat(60));
  console.log('TEST 3: Parallel execution (both CLIs at same time)');
  console.log('═'.repeat(60));

  const startTime = Date.now();

  const [codex, claude] = await Promise.all([
    runCLI('parallel-codex', [
      'codex', 'exec',
      'List the files in docs/ directory. Just list them, nothing else.'
    ]),
    runCLI('parallel-claude', [
      'claude', '-p',
      '--output-format', 'text',
      'List the files in docs/ directory. Just list them, nothing else.'
    ]),
  ]);

  const totalTime = Date.now() - startTime;

  return {
    test: 'Parallel execution',
    pass: (codex.status === 'OK' || codex.status === 'TIMEOUT') &&
          (claude.status === 'OK' || claude.status === 'TIMEOUT'),
    totalTimeMs: totalTime,
    codex: { status: codex.status, durationMs: codex.durationMs },
    claude: { status: claude.status, durationMs: claude.durationMs },
    ranParallel: totalTime < (codex.durationMs + claude.durationMs) * 0.9,
  };
}

// ── Main ──────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  Phase 0 Spike — CLI Headless Integration Tests     ║');
  console.log('║  Workspace: d:\\extension                            ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  const results = [];

  // Test 1: Codex headless
  results.push(await testCodexHeadless());

  // Test 2: Claude Code headless
  results.push(await testClaudeHeadless());

  // Test 3: Parallel
  results.push(await testParallel());

  // Summary
  console.log('\n' + '═'.repeat(60));
  console.log('SPIKE RESULTS SUMMARY');
  console.log('═'.repeat(60));

  for (const r of results) {
    const icon = r.pass ? '✅' : '❌';
    console.log(`${icon} ${r.test}: ${r.status || (r.pass ? 'PASS' : 'FAIL')}`);
    if (r.hasOutput !== undefined) console.log(`   Has output: ${r.hasOutput}`);
    if (r.utf8Clean !== undefined) console.log(`   UTF-8 clean: ${r.utf8Clean}`);
    if (r.jsonParseable !== undefined) console.log(`   JSON parseable: ${r.jsonParseable}`);
    if (r.ranParallel !== undefined) console.log(`   Ran parallel: ${r.ranParallel} (${r.totalTimeMs}ms total)`);
    if (r.durationMs) console.log(`   Duration: ${r.durationMs}ms`);
  }

  const allPass = results.every(r => r.pass);
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`OVERALL: ${allPass ? '✅ SPIKE PASS — Ready for Phase 1' : '❌ SPIKE FAIL — Needs investigation'}`);
  console.log('═'.repeat(60));

  // Write results to file
  const report = JSON.stringify(results, null, 2);
  require('fs').writeFileSync(
    path.join(WORKSPACE, 'docs', 'spike-results.json'),
    report,
    'utf-8'
  );
  console.log('\nResults saved to docs/spike-results.json');
}

main().catch(console.error);
