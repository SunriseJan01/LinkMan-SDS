FROM node:18-alpine

WORKDIR /app

COPY package.json secure-delivery-server.js ./

RUN npm install

EXPOSE 3000

CMD ["node", "secure-delivery-server.js"]
