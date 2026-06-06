# Phase 6: Whisper Sidecar + Models + Ready - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-06
**Phase:** 6-Whisper Sidecar + Models + Ready
**Areas discussed:** Arranque en producción

---

## Arranque en producción

### Q1: ¿Qué condición activa HttpWhisperService en el entrypoint?

| Option | Description | Selected |
|--------|-------------|----------|
| Solo WHISPER_MODEL_ALIAS definido | HttpWhisperService si alias set; Noop si falta | ✓ |
| Alias + host/port definidos | Requiere config explícita de conexión | |
| Siempre HttpWhisperService | Noop solo en tests | |
| Tú decides | Opción más segura | |

**User's choice:** Solo si `WHISPER_MODEL_ALIAS` está definido.

### Q2: ¿Dónde vive HttpWhisperService?

| Option | Description | Selected |
|--------|-------------|----------|
| whisper-service.ts | Junto a interface + NoopWhisperService | ✓ |
| whisper-http-client.ts | Archivo separado | |
| createWhisperService() factory | Entrypoint llama factory | |
| Tú decides | Convenciones del repo | |

**User's choice:** Mismo archivo `whisper-service.ts`.

### Q3: ¿Cómo conectar sin romper inyección en tests?

| Option | Description | Selected |
|--------|-------------|----------|
| Inline en import.meta.main | if (alias) new HttpWhisperService() | ✓ |
| resolveWhisperService() helper | Exportado desde whisper-service.ts | |
| createServer() elige internamente | Rompe tercer parámetro explícito | |
| Tú decides | Preservar tests Phase 5 | |

**User's choice:** Lógica inline en el bloque `import.meta.main`.

### Q4: ¿Qué pasa si alias está set pero sidecar no corre al boot?

| Option | Description | Selected |
|--------|-------------|----------|
| Siempre arrancar | Sin health check al boot; 503 en runtime | ✓ |
| Arrancar + warn log | Probe opcional no bloqueante | |
| Fallar boot | Forzar sidecar antes de proxy | |
| Tú decides | Coherente con missing-secrets policy | |

**User's choice:** Siempre arrancar — 503 solo en request de transcripción.

---

## Claude's Discretion

Áreas no seleccionadas para discusión — defaults documentados en CONTEXT.md:

- Visibilidad del alias en `GET /v1/models`
- Comportamiento de `whisperAvailable` en `GET /ready`
- Payload FormData hacia whisper-server

## Deferred Ideas

None.
