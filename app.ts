// app.ts — the forge HTTP server: one in-memory store, four surfaces.
//
//  /healthz              liveness probe (no auth)
//  /{owner}/{repo}.git   git smart HTTP (upload-pack v2 + receive-pack v0)
//  /api/v3               REST v3 (bearer required)
//  /api/graphql          GraphQL (bearer required)
//  /mcp                  MCP over Streamable HTTP (bearer required)
//
// Every reply is JSON (never HTML); unknown routes answer 404 JSON. A bad
// request can never crash the process: the handler catches and answers 500.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './gitproto.ts';
import { pathOf, sendJson } from './util.ts';

export function createForgeServer(): { store: Store; server: Server } {
  const store = new Store();
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const path = pathOf(req);
      if (path === '/healthz') {
        sendJson(res, 200, { status: 'ok' });
        return;
      }
      if (await handleGit(store, req, res)) return;
      if (path === '/mcp' || path.startsWith('/mcp?')) {
        await handleMcp(store, req, res);
        return;
      }
      if (path === '/api/graphql' || path.startsWith('/api/graphql?')) {
        await handleGraphql(store, req, res);
        return;
      }
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        await handleRest(store, req, res);
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
    } catch {
      if (!res.headersSent) {
        sendJson(res, 500, { message: 'Internal Server Error' });
      } else {
        try {
          res.end();
        } catch {
          // The socket is already gone; nothing more to do.
        }
      }
    }
  });
  return { store, server };
}
