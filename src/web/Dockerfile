# Dev image: Vite dev server on 5173 (compose mounts nothing; rebuild on change).
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev"]
