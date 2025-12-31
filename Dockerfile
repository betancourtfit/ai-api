# Imagen oficial de Bun
FROM oven/bun:1.1.29

# Directorio de trabajo dentro del container
WORKDIR /app

# Copiamos archivos de dependencias primero (mejor cache)
COPY package.json bun.lock ./

# Instalamos dependencias
RUN bun install --frozen-lockfile

# Copiamos el resto del código
COPY . .

# Variables de entorno
ENV NODE_ENV=production
ENV PORT=3001

# Exponemos el puerto que usa Bun.serve
EXPOSE 3001

# Comando de arranque (usa tu script start)
CMD ["bun", "index.ts"]