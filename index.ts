// index.ts — process entrypoint.
// The HTTP delivery layer lives in adapters/inbound/http/. See ARCHITECTURE.md for the layer map.
import { config } from './config';
import { createServer } from './adapters/inbound/http/server';
import { cerebrasAdapter } from './services/cerebras';
import { groqAdapter } from './services/groq';
import { HttpWhisperService, NoopWhisperService } from './whisper-service';

// D-02: re-exported so tests and embedders can boot a server without running this file.
export { createServer };

// Entrypoint guard — bun index.ts boots the server; import { createServer } from './index' does not
if (import.meta.main) {
    const whisperService = config.whisperModelAlias !== null
        ? new HttpWhisperService()
        : new NoopWhisperService();
    const server = createServer(
        { cerebras: cerebrasAdapter, groq: groqAdapter },
        config.port,
        whisperService
    );
    console.log(`Server is running on ${server.url}`);
}
