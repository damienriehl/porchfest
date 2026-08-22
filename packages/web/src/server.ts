import { serve } from "@hono/node-server";
import "dotenv/config";
import { createRuntime } from "./composition.js";

const hostname = process.env.PORCHFEST_HOST ?? "127.0.0.1";
const parsedPort = Number(process.env.PORCHFEST_PORT ?? "9398");
if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
  throw new Error(`Invalid PORCHFEST_PORT: ${process.env.PORCHFEST_PORT}`);
}

const runtime = await createRuntime();

const server = serve(
  { fetch: runtime.fetch, hostname, port: parsedPort },
  (info) => {
    console.log(`Porchfest listening on http://${hostname}:${info.port}`);
  },
);

let shutdownStarted = false;
function shutdown(): void {
  if (shutdownStarted) return;
  shutdownStarted = true;

  server.close((serverError) => {
    if (serverError) {
      console.error("Failed to stop the Porchfest HTTP server", serverError);
      process.exitCode = 1;
    }

    try {
      runtime.close();
    } catch (closeError) {
      console.error("Failed to close the Porchfest runtime", closeError);
      process.exitCode = 1;
    }
  });
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
