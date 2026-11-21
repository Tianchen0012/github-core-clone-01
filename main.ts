// main.ts — entrypoint. Bind an ephemeral port, register it with the trial
// environment, serve until the environment says the trial is done, exit 0.
//
// The environment hands us its base URL in MAKEFUN_ENV_URL. We never bind
// port 8080 (the suite listens there) and never read the wall clock for
// stored data: every timestamp in the store is the fixed epoch.

import { createForgeServer } from './app.ts';

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl === undefined || envUrl === '') {
  console.error('MAKEFUN_ENV_URL is not set');
  process.exit(1);
}
const base = envUrl.replace(/\/+$/, '');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(port: number): Promise<void> {
  // The environment is normally already listening when it starts us, but
  // allow up to ~30 s of retries so a slow environment start cannot make
  // a healthy entry score 0 for never registering.
  for (let attempt = 1; attempt <= 150; attempt++) {
    try {
      const response = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.ok) return;
    } catch {
      // The environment may not be listening yet; retry.
    }
    await sleep(200);
  }
  throw new Error('could not register with the environment');
}

async function waitForDone(): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${base}/done`);
      if (response.ok) {
        const body = (await response.json()) as { done?: boolean };
        if (body.done === true) return;
      }
    } catch {
      // Transient; keep polling.
    }
    await sleep(500);
  }
}

const { server } = createForgeServer();
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  if (port === 0) {
    console.error('could not bind an ephemeral port');
    process.exit(1);
  }
  register(port)
    .then(() => waitForDone())
    .then(() => {
      // The suite may still hold keep-alive connections open; drop them so
      // the process can exit promptly instead of waiting on idle sockets.
      server.closeAllConnections();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1000).unref();
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
});
