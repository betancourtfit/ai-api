// tests/services/http-whisper-service.test.ts — HttpWhisperService against in-process fake sidecar
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { HttpWhisperService } from '../../whisper-service';

let sidecar: ReturnType<typeof Bun.serve>;
let sawModelField = false;

beforeAll(() => {
    sidecar = Bun.serve({
        port: 0,
        async fetch(req) {
            const path = new URL(req.url).pathname;

            if (path === '/health') {
                return Response.json({ status: 'ok' });
            }

            if (path === '/inference') {
                const form = await req.formData();
                sawModelField = form.get('model') !== null;
                return Response.json({ text: 'hello world' });
            }

            return new Response('not found', { status: 404 });
        },
    });
});

afterAll(() => {
    sidecar.stop(true);
});

describe('HttpWhisperService', () => {
    test('WHSP-01: transcribe returns { text } from sidecar /inference', async () => {
        const service = new HttpWhisperService({ host: '127.0.0.1', port: sidecar.port });
        const result = await service.transcribe(new File(['x'], 'a'), 'whisper-1');
        expect(result).toEqual({ text: 'hello world' });
    });

    test('WHSP-02: transcribe does not forward model alias to sidecar', async () => {
        sawModelField = false;
        const service = new HttpWhisperService({ host: '127.0.0.1', port: sidecar.port });
        await service.transcribe(new File(['x'], 'a'), 'whisper-1');
        expect(sawModelField).toBe(false);
    });

    test('WHSP-03: transcribe rejects on non-2xx sidecar response', async () => {
        const service = new HttpWhisperService({
            host: '127.0.0.1',
            port: sidecar.port,
            inferencePath: '/missing',
        });
        await expect(service.transcribe(new File(['x'], 'a'), 'whisper-1')).rejects.toThrow();
    });

    test('health returns true when sidecar /health is 200', async () => {
        const service = new HttpWhisperService({ host: '127.0.0.1', port: sidecar.port });
        expect(await service.health()).toBe(true);
    });

    test('health returns false on unreachable port without throwing', async () => {
        const service = new HttpWhisperService({ host: '127.0.0.1', port: 1, healthTimeoutMs: 300 });
        await expect(service.health()).resolves.toBe(false);
    });
});
