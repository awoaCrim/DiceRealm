import { EventEmitter } from 'node:events';

const emitter = new EventEmitter();

export function publishRoomUpdate(roomId: string): void {
  emitter.emit('room-updated', roomId);
}

export function subscribeRoomUpdate(roomId: string, listener: () => void): () => void {
  const wrapped = (updatedRoomId: string) => {
    if (updatedRoomId === roomId) listener();
  };
  emitter.on('room-updated', wrapped);
  return () => emitter.off('room-updated', wrapped);
}
