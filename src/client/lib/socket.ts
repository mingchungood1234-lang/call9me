import type { Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '../../shared/types';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
