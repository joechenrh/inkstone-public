import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import type { ServerEvent } from '../shared/events.js'

export class WsHub {
  readonly #clients = new Set<WebSocket>()

  get clientCount(): number {
    return this.#clients.size
  }

  registerRoute(app: FastifyInstance): void {
    app.get('/ws', { websocket: true }, (socket, req) => {
      // WebSocket upgrade requests bypass the /api/ onRequest guard; authenticate each upgrade here.
      if (!app.isAuthenticated(req)) {
        socket.close(4401, 'unauthorized')
        return
      }
      this.#clients.add(socket)
      socket.on('close', () => this.#clients.delete(socket))
      socket.on('error', () => this.#clients.delete(socket))
    })
  }

  broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(event)
    for (const socket of this.#clients) {
      if (socket.readyState === socket.OPEN) {
        socket.send(payload)
      }
    }
  }
}
