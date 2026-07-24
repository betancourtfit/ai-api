// index.ts — process entrypoint.
// The HTTP delivery layer lives in adapters/inbound/http/; all wiring lives in
// composition/container.ts. See ARCHITECTURE.md for the layer map.
import { config } from './config';
import { buildContainer } from './composition/container';
import { createServer } from './adapters/inbound/http/server';

// D-02: re-exported so tests and embedders can boot a server without running this file.
export { createServer };

// Entrypoint guard — bun index.ts boots the server; import { createServer } from './index' does not
if (import.meta.main) {
    const container = buildContainer(config);
    const server = createServer(
        container.chatProviders,
        config.port,
        container.transcription,
        config.audioMaxFileBytes,
        container
    );
    console.log(`Server is running on ${server.url}`);
}
