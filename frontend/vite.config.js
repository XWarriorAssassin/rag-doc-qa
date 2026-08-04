import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// Dev-only proxy: lets the frontend call same-origin "/api/..." paths while
// the actual Express server runs on :4000. Avoids CORS entirely in local
// dev and means VITE_API_URL only has to be set for the deployed build
// (Vercel), where the frontend and backend are on genuinely different
// origins and a real fetch to the Render URL is unavoidable.
export default defineConfig({
    plugins: [react()],
    server: {
        proxy: {
            "/api": {
                target: process.env.VITE_DEV_API_PROXY_TARGET ?? "http://localhost:4000",
                changeOrigin: true,
            },
            // ws: true tells Vite's proxy to also forward the WebSocket Upgrade
            // handshake, not just plain HTTP — without it, a ws:// connection to
            // this same path would 404 instead of reaching the backend's WS
            // server (see backend src/ws/socketServer.ts).
            "/ws": {
                target: process.env.VITE_DEV_API_PROXY_TARGET ?? "http://localhost:4000",
                ws: true,
                changeOrigin: true,
            },
        },
    },
});
