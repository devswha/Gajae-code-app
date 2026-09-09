import type { Server } from 'node:http';

import type { WebSocketServer } from 'ws';

/** ws forwards HTTP server errors through its own emitter. Observe both until
 * startup finishes so EADDRINUSE rejects the initializer instead of escaping
 * as an unhandled WebSocketServer error and skipping resource cleanup. */
export function listenForStartup(server: Server, sockets: WebSocketServer, port: number, host: string, ready: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    let finished = false;
    let readyStarted = false;
    let failure: Error | undefined;
    const remove = () => { server.off('error', fail); sockets.off('error', fail); };
    const fail = (error: Error) => {
      if (finished) return;
      failure ??= error;
      // A socket error does not finish an already accepted initialization
      // callback. Its owner must join that callback before tearing services down.
      if (readyStarted) return;
      finished = true;
      remove();
      reject(error);
    };
    server.on('error', fail);
    sockets.on('error', fail);
    try {
      server.listen({ port, host }, () => {
        if (finished) return;
        readyStarted = true;
        void Promise.resolve().then(ready).then(() => {
          if (finished) return;
          finished = true;
          remove();
          if (failure) reject(failure); else resolve();
        }, (error: Error) => {
          if (finished) return;
          finished = true;
          remove();
          reject(failure ?? error);
        });
      });
    } catch (error) { fail(error as Error); }
  });
}
