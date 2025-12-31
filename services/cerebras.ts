import Cerebras from '@cerebras/cerebras_cloud_sdk';
import type { AIService, ChatMessage } from '../types';


const cerebras = new Cerebras();

export const cerebrasService: AIService = {
    name: "cerebras",
    async chat(messages: ChatMessage[]) {
        const chatCompletion = await cerebras.chat.completions.create({
            messages: messages as any,
            model: 'qwen-3-32b',
            stream: true,
            max_completion_tokens: 16382,
            temperature: 0.6,
            top_p: 0.95
        });
        return (async function* () {
            for await (const chunk of chatCompletion) {
                yield chunk.choices[0]?.delta?.content || '';
            }
        });
    }
}
