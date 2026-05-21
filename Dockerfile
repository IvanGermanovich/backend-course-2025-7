FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

# Порт додатка та порт для дебаггера
EXPOSE 3000 9229

CMD ["npm", "run", "dev"]
