import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';

function runCanonical(input: string, timeoutMs = 5000): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('bun', ['run', 'src/cli/there.ts', 'examples/promo/canonical.th'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stdout += d.toString(); });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('timeout'));
    }, timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, code: code ?? 0 });
    });
    proc.stdin.write(input);
    proc.stdin.end();
  });
}

describe('canonical promo example', () => {
  test('runs and exits via quit', async () => {
    const { stdout } = await runCanonical('quit\n');
    expect(stdout).toContain('Welcome to the Old Forest');
    expect(stdout).toContain('Hero:');
    expect(stdout).toContain('Dragon:');
    expect(stdout).toContain('You flee the field');
  }, 10000);
});
