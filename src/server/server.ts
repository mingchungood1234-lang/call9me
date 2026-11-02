import http from 'node:http';
import { Server } from 'socket.io';
import { createApp } from './app';
import { config, describeIceServers } from './config';
import { registerSocketHandlers } from './sockets';
import type { AppServer } from './sockets/types';

const httpServer = http.createServer(createApp());
const io: AppServer = new Server(httpServer);
registerSocketHandlers(io);

httpServer.listen(config.port, config.host, () => {
  console.log(`Call9me running at http://localhost:${config.port}`);
  console.log(`ICE servers: ${describeIceServers(config.iceServers)}`);
});
