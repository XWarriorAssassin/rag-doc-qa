import "dotenv/config";
import { createApp } from "./app.js";
import { attachSocketServer } from "./ws/socketServer.js";

const port = process.env.PORT ? Number(process.env.PORT) : 4000;
const app = createApp();

// One HTTP server, shared by Express (HTTP requests) and the WebSocket
// server (streaming chat) — app.listen() normally creates this implicitly
// and hides it, but the WS upgrade handshake needs a direct handle on it to
// register its 'upgrade' listener, so it's created explicitly here instead.
const httpServer = app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
});

attachSocketServer(httpServer);
