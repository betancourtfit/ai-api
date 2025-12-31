import { groqService } from "./services/groq";
import { cerebrasService } from "./services/cerebras";
import type { AIService, ChatMessage } from "./types";

const services: AIService[] = [
    groqService,
    cerebrasService
];

let currentServiceIndex = 0;

function getNextService() {
    const service = services[currentServiceIndex];
    currentServiceIndex = (currentServiceIndex + 1) % services.length;
    return service;
}

const server = Bun.serve({
  port: process.env.PORT ?? 3000,
  async fetch(request) {
    const { pathname } = new URL(request.url);


    // healthcheck para EasyPanel / reverse proxies
    if (request.method === "GET" && (pathname === "/" || pathname === "/health")) {
        return new Response("ok", { status: 200 });
      }

    if (request.method === "POST" && pathname === "/chat") {
        const { messages } = await request.json() as { messages: ChatMessage[] };
        const service = getNextService();
        console.log(`Using service: ${service?.name}`);
        const stream = await service?.chat(messages);

        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        })
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Server is running on ${server.url}`);