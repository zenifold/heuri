FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 8787
CMD ["npm", "start"]
