// Restarting Lura from a suite, mid-run.
//
// e2e/run.sh writes a restart script per phase and passes its path as
// E2E_RESTART (see the header of run.sh). With E2E_STORE=postgres the database
// outlives the process, so a suite can check what survives a restart; with the
// memory store a restart is a clean slate and canKeepData() says so.

import { spawn } from 'node:child_process';

/** The store the server runs on: 'memory' (default) or 'postgres'. */
export const STORE = process.env.E2E_STORE ?? 'memory';

/** canRestart says whether this run can restart its server at all. */
export function canRestart() {
  return !!process.env.E2E_RESTART;
}

/** canKeepData says whether a restart keeps users, places, notes and history. */
export function canKeepData() {
  return canRestart() && STORE === 'postgres';
}

/** Every restart this process asked for, for reports and for error filters. */
export const restarts = [];

/**
 * restartServer stops this phase's Lura (SIGTERM: it closes sockets with a
 * "closing" frame and drains, as a deploy would), waits `downMs`, starts it again
 * with the same environment and database, and resolves once /readyz answers.
 *
 * Returns { stoppedAt, readyAt, downMs } in wall-clock milliseconds: `stoppedAt`
 * is when the stop was asked for, so anything a browser logged between the two
 * is the outage, not the app.
 */
export async function restartServer({ downMs = 0, timeoutMs = 60000 } = {}) {
  const script = process.env.E2E_RESTART;
  if (!script) throw new Error('restartServer: E2E_RESTART is not set (run through e2e/run.sh)');
  const stoppedAt = Date.now();
  await new Promise((resolve, reject) => {
    const child = spawn('bash', [script], {
      env: { ...process.env, E2E_DOWN_MS: String(downMs) },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`restartServer: no ready server after ${timeoutMs} ms`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`restartServer: ${script} exited with ${code}`));
    });
  });
  const entry = { stoppedAt, readyAt: Date.now(), downMs };
  restarts.push(entry);
  return entry;
}

/**
 * duringRestart says whether wall-clock time `at` falls in a restart's outage,
 * give or take `graceMs` for the clients to notice and reconnect.
 */
export function duringRestart(at, graceMs = 15000) {
  return restarts.some((r) => at >= r.stoppedAt && at <= r.readyAt + graceMs);
}
