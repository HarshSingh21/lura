// A local webhook sink: Lura's webhook channel (LURA_WEBHOOK_URL) posts each
// pushed reminder here, so a suite can count what went out, and to whom.

import { createServer } from 'node:http';

/**
 * startSink listens on 127.0.0.1:port (0 = any free port) and records every
 * POST. Each hit keeps the parsed JSON body when it is JSON (the webhook
 * notifier sends the whole message, recipient `userId` included).
 */
export async function startSink(port = 0) {
  const hits = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let json = null;
      try {
        json = JSON.parse(body);
      } catch {
        // not JSON: keep the text
      }
      hits.push({ at: Date.now(), body, json });
      res.writeHead(204).end();
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return {
    hits,
    url: `http://127.0.0.1:${server.address().port}/hook`,
    /** since counts hits after a wall-clock time, optionally for one recipient. */
    since: (at, userId) => hits.filter((h) => h.at >= at && (!userId || h.json?.userId === userId)),
    close: () => new Promise((r) => server.close(r)),
  };
}
