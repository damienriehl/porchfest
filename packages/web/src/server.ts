import { serve } from '@hono/node-server';
import 'dotenv/config';
import { createRuntime } from './composition.js';

const hostname = process.env.PORCHFEST_HOST ?? '127.0.0.1';
const parsedPort = Number(process.env.PORCHFEST_PORT ?? '9398');
if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
  throw new Error(`Invalid PORCHFEST_PORT: ${process.env.PORCHFEST_PORT}`);
}

const runtime = await createRuntime();

serve({ fetch: runtime.app.fetch, hostname, port: parsedPort }, (info) => {
  console.log(`Porchfest listening on http://${hostname}:${info.port}`);
});
