import type { Server, Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, SocketData } from '../../shared/types';

export type AppServer = Server<ClientToServerEvents, ServerToClientEvents, {}, SocketData>;
export type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, {}, SocketData>;
