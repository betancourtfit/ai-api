// application/use-cases/list-models.ts — the advertised alias list, transport-free (HEX-09).
// Returns ids only; the route builds the OpenAI `{ object: 'list', data: [...] }` envelope.

export interface ListModelsDeps {
    listAliases(): string[];
    whisperModelAlias: string | null;
}

export function listModels(deps: ListModelsDeps) {
    return function run(): string[] {
        const ids = deps.listAliases();
        // EP2-02: the whisper alias is advertised alongside the chat aliases when configured.
        return deps.whisperModelAlias !== null ? [...ids, deps.whisperModelAlias] : ids;
    };
}
