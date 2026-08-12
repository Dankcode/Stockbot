import "dotenv/config";
import { createStockbot } from "./bootstrap.js";

let runtime;
let server;
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await runtime?.close();
  if (signal) console.log(`Stockbot stopped (${signal}).`);
}

try {
  runtime = await createStockbot();
  server = runtime.app.listen(runtime.config.port, runtime.config.host, () => {
    console.log(`Stockbot API listening on http://${runtime.config.host}:${runtime.config.port}`);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      shutdown(signal).catch((error) => {
        console.error("Stockbot shutdown failed:", error);
        process.exitCode = 1;
      });
    });
  }
} catch (error) {
  console.error("Stockbot failed to start:", error);
  process.exitCode = 1;
  await runtime?.close().catch(() => undefined);
}
