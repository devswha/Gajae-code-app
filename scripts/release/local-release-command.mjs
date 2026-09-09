import { spawn } from 'node:child_process';
import { closeSync, openSync, writeSync } from 'node:fs';

// No shell, inherited stdin, credential arguments, or raw command-error output.
// Downloads use exclusive creation in a fresh temporary directory.
export async function releaseCommand(program, args, { output, timeout = 120_000, maxOutputBytes = 2 * 1024 ** 3 } = {}) {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new Error('Command file output limit must be a positive safe integer.');
  }
  const fd = output ? openSync(output, 'wx', 0o600) : undefined;
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(program, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GH_PROMPT_DISABLED: '1' },
      });
      let stdout = '';
      let stderr = '';
      let fileBytes = 0;
      let textBytes = 0;
      let failure;
      const timer = setTimeout(() => {
        failure = 'timed out';
        child.kill('SIGKILL');
      }, timeout);
      const collect = (stream, target) => {
        const fileOutput = target === 'stdout' && fd !== undefined;
        if (!fileOutput) stream?.setEncoding('utf8');
        stream?.on('data', chunk => {
          if (failure) return;
          if (fileOutput) {
            fileBytes += chunk.length;
            if (fileBytes > maxOutputBytes) {
              failure = 'exceeded the file output limit';
              child.kill('SIGKILL');
              return;
            }
            try {
              // Synchronous bounded chunks keep disk writes backpressured and
              // complete before the child-close handler closes this descriptor.
              let offset = 0;
              while (offset < chunk.length) {
                const written = writeSync(fd, chunk, offset, chunk.length - offset);
                if (written === 0) throw new Error('Incomplete output write.');
                offset += written;
              }
            } catch {
              failure = 'could not write output';
              child.kill('SIGKILL');
            }
            return;
          }
          textBytes += Buffer.byteLength(chunk);
          if (target === 'stdout') stdout += chunk;
          else stderr += chunk;
          if (textBytes > 8 * 1024 * 1024) {
            failure = 'exceeded the output limit';
            child.kill('SIGKILL');
          }
        });
      };
      collect(child.stdout, 'stdout');
      collect(child.stderr, 'stderr');
      child.on('error', () => { failure = 'could not start'; });
      child.on('close', code => {
        clearTimeout(timer);
        if (failure || code !== 0) reject(new Error(`${program} ${failure ?? `failed (exit ${code})`}; raw output suppressed.`));
        else resolve({ stdout, stderr });
      });
    });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
