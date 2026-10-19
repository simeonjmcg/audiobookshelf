const SocketIO = require('socket.io')
const { v4: uuidv4 } = require('uuid')
const Logger = require('./Logger')
const Database = require('./Database')
const TokenManager = require('./auth/TokenManager')
const CoverSearchManager = require('./managers/CoverSearchManager')
const { LogLevel } = require('./utils/constants')

/**
 * @typedef SocketClient
 * @property {string} id socket id
 * @property {SocketIO.Socket} socket
 * @property {number} connected_at
 * @property {import('./models/User')} user
 */

class SocketAuthority {
  constructor() {
    this.Server = null
    this.socketIoServers = []

    /** @type {Object.<string, SocketClient>} */
    this.clients = {}

    this.instanceId = uuidv4()
    this.pgSubscriber = null
    this.pgCleanupInterval = null
    this.isClosing = false
    this._reconnecting = false
  }

  /**
   * returns an array of User.toJSONForPublic with `connections` for the # of socket connections
   *  a user can have many socket connections
   * @returns {object[]}
   */
  getUsersOnline() {
    const onlineUsersMap = {}
    Object.values(this.clients)
      .filter((c) => c.user)
      .forEach((client) => {
        if (onlineUsersMap[client.user.id]) {
          onlineUsersMap[client.user.id].connections++
        } else {
          onlineUsersMap[client.user.id] = {
            ...client.user.toJSONForPublic(this.Server.playbackSessionManager.sessions),
            connections: 1
          }
        }
      })
    return Object.values(onlineUsersMap)
  }

  getClientsForUser(userId) {
    return Object.values(this.clients).filter((c) => c.user?.id === userId)
  }

  _dispatchLocally(msg) {
    if (!msg || !msg.type) return
    if (msg.type === 'emitter') {
      const filter = msg.libraryId ? (user) => user.checkCanAccessLibrary?.(msg.libraryId) : null
      for (const socketId in this.clients) {
        if (this.clients[socketId].user) {
          if (filter && !filter(this.clients[socketId].user)) continue
          this.clients[socketId].socket.emit(msg.evt, msg.data)
        }
      }
    } else if (msg.type === 'clientEmitter') {
      const clients = this.getClientsForUser(msg.userId)
      clients.forEach((client) => {
        if (client.socket) client.socket.emit(msg.evt, msg.data)
      })
    } else if (msg.type === 'adminEmitter') {
      for (const socketId in this.clients) {
        if (this.clients[socketId].user?.isAdminOrUp) {
          this.clients[socketId].socket.emit(msg.evt, msg.data)
        }
      }
    } else if (msg.type === 'libraryItemEmitter') {
      for (const socketId in this.clients) {
        if (this.clients[socketId].user?.checkCanAccessLibraryItem(msg.expanded)) {
          this.clients[socketId].socket.emit(msg.evt, msg.expanded)
        }
      }
    } else if (msg.type === 'libraryItemsEmitter') {
      for (const socketId in this.clients) {
        if (this.clients[socketId].user) {
          const libraryItemsAccessibleToUser = (msg.items || []).filter((li) => this.clients[socketId].user.checkCanAccessLibraryItem(li))
          if (libraryItemsAccessibleToUser.length) {
            this.clients[socketId].socket.emit(msg.evt, libraryItemsAccessibleToUser)
          }
        }
      }
    }
  }

  async publishBroadcast(msg) {
    if (!Database.isPostgresDialect?.() || !Database.sequelize || this.isClosing) return
    msg.origin = this.instanceId
    try {
      const json = JSON.stringify(msg)
      if (json.length <= 7500) {
        const escaped = json.replace(/'/g, "''")
        await Database.sequelize.query(`NOTIFY abs_socket_events, '${escaped}';`)
      } else {
        const [result] = await Database.sequelize.query(
          `INSERT INTO abs_broadcast_events (origin, payload) VALUES (:origin, :payload) RETURNING id;`,
          {
            replacements: {
              origin: this.instanceId,
              payload: json
            }
          }
        )
        const id = result[0]?.id
        if (id) {
          await Database.sequelize.query(`NOTIFY abs_socket_events, '{"id":${id},"origin":"${this.instanceId}"}';`)
        }
      }
    } catch (err) {
      Logger.error('[SocketAuthority] Error publishing broadcast message', err)
    }
  }

  /**
   * Emits event to all authorized clients
   * @param {string} evt
   * @param {any} data
   * @param {Function} [filter] optional filter function to only send event to specific users
   */
  emitter(evt, data, filter = null) {
    for (const socketId in this.clients) {
      if (this.clients[socketId].user) {
        if (filter && !filter(this.clients[socketId].user)) continue

        this.clients[socketId].socket.emit(evt, data)
      }
    }
    const libraryId = evt.startsWith('library_') && data?.id ? data.id : null
    this.publishBroadcast({ type: 'emitter', evt, data, libraryId })
  }

  // Emits event to all clients for a specific user
  clientEmitter(userId, evt, data) {
    const clients = this.getClientsForUser(userId)
    if (!clients.length) {
      Logger.debug(`[SocketAuthority] clientEmitter - no local clients found for user ${userId}`)
    } else {
      clients.forEach((client) => {
        if (client.socket) {
          client.socket.emit(evt, data)
        }
      })
    }
    this.publishBroadcast({ type: 'clientEmitter', userId, evt, data })
  }

  // Emits event to all admin user clients
  adminEmitter(evt, data) {
    for (const socketId in this.clients) {
      if (this.clients[socketId].user?.isAdminOrUp) {
        this.clients[socketId].socket.emit(evt, data)
      }
    }
    this.publishBroadcast({ type: 'adminEmitter', evt, data })
  }

  requireAdminSocket(socket, eventName) {
    const client = this.clients[socket.id]
    if (client?.user?.isAdminOrUp) return true

    Logger.warn(`[SocketAuthority] Unauthorized ${eventName} socket event from socket ${socket.id}`)
    return false
  }

  /**
   * Emits event with library item to all clients that can access the library item
   * Note: Emits toOldJSONExpanded()
   *
   * @param {string} evt
   * @param {import('./models/LibraryItem')} libraryItem
   */
  libraryItemEmitter(evt, libraryItem) {
    const expanded = typeof libraryItem?.toOldJSONExpanded === 'function' ? libraryItem.toOldJSONExpanded() : libraryItem
    for (const socketId in this.clients) {
      if (this.clients[socketId].user?.checkCanAccessLibraryItem(libraryItem)) {
        this.clients[socketId].socket.emit(evt, expanded)
      }
    }
    this.publishBroadcast({ type: 'libraryItemEmitter', evt, expanded })
  }

  /**
   * Emits event with library items to all clients that can access the library items
   * Note: Emits toOldJSONExpanded()
   *
   * @param {string} evt
   * @param {import('./models/LibraryItem')[]} libraryItems
   */
  libraryItemsEmitter(evt, libraryItems) {
    const items = (libraryItems || []).map((li) => (typeof li?.toOldJSONExpanded === 'function' ? li.toOldJSONExpanded() : li))
    for (const socketId in this.clients) {
      if (this.clients[socketId].user) {
        const libraryItemsAccessibleToUser = items.filter((li) => this.clients[socketId].user.checkCanAccessLibraryItem(li))
        if (libraryItemsAccessibleToUser.length) {
          this.clients[socketId].socket.emit(evt, libraryItemsAccessibleToUser)
        }
      }
    }
    this.publishBroadcast({ type: 'libraryItemsEmitter', evt, items })
  }

  /**
   * Closes the Socket.IO server and disconnect all clients
   *
   * @param {Function} callback
   */
  async close() {
    Logger.info('[SocketAuthority] closing...')
    this.isClosing = true
    if (this.pgCleanupInterval) {
      clearInterval(this.pgCleanupInterval)
      this.pgCleanupInterval = null
    }
    if (this.pgSubscriber) {
      try {
        await this.pgSubscriber.end()
      } catch (e) {}
      this.pgSubscriber = null
    }
    const closePromises = this.socketIoServers.map((io) => {
      return new Promise((resolve) => {
        Logger.info(`[SocketAuthority] Closing Socket.IO server: ${io.path}`)
        io.close(() => {
          Logger.info(`[SocketAuthority] Socket.IO server closed: ${io.path}`)
          resolve()
        })
      })
    })
    await Promise.all(closePromises)
    Logger.info('[SocketAuthority] closed')
    this.socketIoServers = []
  }

  async initPgPubSub() {
    if (!Database.isPostgresDialect?.() || !process.env.DATABASE_URL) return

    try {
      await Database.sequelize.query(`
        CREATE UNLOGGED TABLE IF NOT EXISTS abs_broadcast_events (
          id BIGSERIAL PRIMARY KEY,
          origin VARCHAR(64) NOT NULL,
          payload JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_abs_broadcast_events_created ON abs_broadcast_events (created_at);
      `)

      this.pgCleanupInterval = setInterval(async () => {
        try {
          if (!this.isClosing && Database.sequelize) {
            await Database.sequelize.query("DELETE FROM abs_broadcast_events WHERE created_at < NOW() - INTERVAL '5 minutes';")
          }
        } catch (err) {
          Logger.error('[SocketAuthority] Failed to clean up broadcast events table', err)
        }
      }, 5 * 60 * 1000)
      if (this.pgCleanupInterval.unref) this.pgCleanupInterval.unref()

      await this.connectPgSubscriber()
    } catch (err) {
      Logger.error('[SocketAuthority] Failed to initialize PostgreSQL Pub/Sub', err)
    }
  }

  async connectPgSubscriber() {
    if (this.isClosing) return
    try {
      const { Client } = require('pg')
      this.pgSubscriber = new Client({ connectionString: process.env.DATABASE_URL })
      await this.pgSubscriber.connect()
      await this.pgSubscriber.query('LISTEN abs_socket_events;')
      Logger.info(`[SocketAuthority] PostgreSQL Pub/Sub listener active (instance ${this.instanceId})`)

      this.pgSubscriber.on('notification', async (msg) => {
        try {
          if (!msg.payload) return
          let eventData = JSON.parse(msg.payload)
          if (eventData.id) {
            const [rows] = await Database.sequelize.query(`SELECT payload FROM abs_broadcast_events WHERE id = :id;`, {
              replacements: { id: eventData.id }
            })
            if (rows && rows[0]?.payload) {
              eventData = rows[0].payload
            } else {
              return
            }
          }
          if (eventData.origin === this.instanceId) return
          this._dispatchLocally(eventData)
        } catch (err) {
          Logger.error('[SocketAuthority] Error processing pub/sub notification', err)
        }
      })

      this.pgSubscriber.on('error', (err) => {
        Logger.error('[SocketAuthority] PostgreSQL Pub/Sub connection error', err)
        this.reconnectPgSubscriber()
      })

      this.pgSubscriber.on('end', () => {
        if (!this.isClosing) {
          this.reconnectPgSubscriber()
        }
      })
    } catch (err) {
      Logger.error('[SocketAuthority] Error connecting pg subscriber', err)
      this.reconnectPgSubscriber()
    }
  }

  reconnectPgSubscriber() {
    if (this.isClosing || this._reconnecting) return
    this._reconnecting = true
    if (this.pgSubscriber) {
      try {
        this.pgSubscriber.end().catch(() => {})
      } catch (e) {}
      this.pgSubscriber = null
    }
    setTimeout(async () => {
      this._reconnecting = false
      await this.connectPgSubscriber()
    }, 5000)
  }

  initialize(Server) {
    this.Server = Server
    this.initPgPubSub()

    const socketIoOptions = {
      cors: {
        origin: '*',
        methods: ['GET', 'POST']
      }
    }

    const ioServer = new SocketIO.Server(Server.server, socketIoOptions)
    ioServer.path = '/socket.io'
    this.socketIoServers.push(ioServer)

    if (global.RouterBasePath) {
      // open a separate socket.io server for the router base path, keeping the original server open for legacy clients
      const ioBasePath = `${global.RouterBasePath}/socket.io`
      const ioBasePathServer = new SocketIO.Server(Server.server, { ...socketIoOptions, path: ioBasePath })
      ioBasePathServer.path = ioBasePath
      this.socketIoServers.push(ioBasePathServer)
    }

    this.socketIoServers.forEach((io) => {
      io.on('connection', (socket) => {
        this.clients[socket.id] = {
          id: socket.id,
          socket,
          connected_at: Date.now()
        }
        socket.sheepClient = this.clients[socket.id]

        Logger.info(`[SocketAuthority] Socket Connected to ${io.path}`, socket.id)

        // Required for associating a User with a socket
        socket.on('auth', (token) => this.authenticateSocket(socket, token))

        // Scanning
        socket.on('cancel_scan', (libraryId) => {
          if (!this.requireAdminSocket(socket, 'cancel_scan')) return
          this.cancelScan(libraryId)
        })

        // Cover search streaming
        socket.on('search_covers', (payload) => this.handleCoverSearch(socket, payload))
        socket.on('cancel_cover_search', (requestId) => this.handleCancelCoverSearch(socket, requestId))

        // Logs
        socket.on('set_log_listener', (level) => {
          if (!this.requireAdminSocket(socket, 'set_log_listener')) return

          if (!Number.isInteger(level) || !Object.values(LogLevel).includes(level)) {
            Logger.warn(`[SocketAuthority] Invalid set_log_listener level from socket ${socket.id}`)
            return
          }
          Logger.addSocketListener(socket, level)
        })
        socket.on('remove_log_listener', () => Logger.removeSocketListener(socket.id))

        // Sent automatically from socket.io clients
        socket.on('disconnect', (reason) => {
          Logger.removeSocketListener(socket.id)

          const _client = this.clients[socket.id]
          if (!_client) {
            Logger.warn(`[SocketAuthority] Socket ${socket.id} disconnect, no client (Reason: ${reason})`)
          } else if (!_client.user) {
            Logger.info(`[SocketAuthority] Unauth socket ${socket.id} disconnected (Reason: ${reason})`)
            delete this.clients[socket.id]
          } else {
            Logger.debug('[SocketAuthority] User Offline ' + _client.user.username)
            this.adminEmitter('user_offline', _client.user.toJSONForPublic(this.Server.playbackSessionManager.sessions))

            const disconnectTime = Date.now() - _client.connected_at
            Logger.info(`[SocketAuthority] Socket ${socket.id} disconnected from client "${_client.user.username}" after ${disconnectTime}ms (Reason: ${reason})`)

            // Cancel any active cover searches for this socket
            this.cancelSocketCoverSearches(socket.id)

            delete this.clients[socket.id]
          }
        })

        //
        // Events for testing
        //
        socket.on('message_all_users', (payload) => {
          // admin user can send a message to all authenticated users
          //   displays on the web app as a toast
          const client = this.clients[socket.id] || {}
          if (client.user?.isAdminOrUp) {
            this.emitter('admin_message', payload.message || '')
          } else {
            Logger.error(`[SocketAuthority] Non-admin user sent the message_all_users event`)
          }
        })
        socket.on('ping', () => {
          const client = this.clients[socket.id] || {}
          const user = client.user || {}
          Logger.debug(`[SocketAuthority] Received ping from socket ${user.username || 'No User'}`)
          socket.emit('pong')
        })
      })
    })
  }

  /**
   * When setting up a socket connection the user needs to be associated with a socket id
   * for this the client will send a 'auth' event that includes the users API token
   *
   * Sends event 'init' to the socket. For admins this contains an array of users online.
   * For failed authentication it sends event 'auth_failed' with a message
   *
   * @param {SocketIO.Socket} socket
   * @param {string} token JWT
   */
  async authenticateSocket(socket, token) {
    // we don't use passport to authenticate the jwt we get over the socket connection.
    // it's easier to directly verify/decode it.
    const token_data = TokenManager.validateAccessToken(token)

    if (!token_data) {
      // Token invalid
      Logger.error('Cannot validate socket - invalid token')
      return socket.emit('auth_failed', { message: 'Invalid token' })
    }

    let user = null

    if (token_data.type === 'api') {
      // Api key based authentication
      const apiKey = await Database.apiKeyModel.getById(token_data.keyId)

      if (!apiKey?.isActive) {
        Logger.error('Cannot validate socket - API key not found or inactive')
        return socket.emit('auth_failed', { message: 'Invalid API key' })
      }

      if (token_data.exp && token_data.exp < Date.now() / 1000) {
        apiKey.isActive = false
        await apiKey.save()
        Logger.info(`[SocketAuthority] API key ${apiKey.id} is expired - deactivated`)
        return socket.emit('auth_failed', { message: 'API key expired' })
      }

      user = await Database.userModel.getUserById(apiKey.userId)
      if (!user) {
        Logger.error('Cannot validate socket - user not found for API key')
        return socket.emit('auth_failed', { message: 'Invalid API key' })
      }
    } else {
      // JWT based authentication
      if (!TokenManager.isBearerAccessTokenPayload(token_data)) {
        Logger.error('Cannot validate socket - invalid token')
        return socket.emit('auth_failed', { message: 'Invalid token' })
      }

      if (token_data.exp && token_data.exp < Date.now() / 1000) {
        Logger.error('Cannot validate socket - token expired')
        return socket.emit('auth_failed', { message: 'Token expired' })
      }

      // get the user via the id from the decoded jwt.
      user = await Database.userModel.getUserByIdOrOldId(token_data.userId)
      if (!user) {
        // user not found
        Logger.error('Cannot validate socket - invalid token')
        return socket.emit('auth_failed', { message: 'Invalid token' })
      }
    }

    if (!user.isActive) {
      Logger.error('Cannot validate socket - user is not active')
      return socket.emit('auth_failed', { message: 'Invalid user' })
    }

    const client = this.clients[socket.id]
    if (!client) {
      Logger.error(`[SocketAuthority] Socket for user ${user.username} has no client`)
      return
    }

    if (client.user !== undefined) {
      if (client.user.id === user.id) {
        // Allow re-authentication of a socket to the same user
        Logger.info(`[SocketAuthority] Authenticating socket already associated to user "${client.user.username}"`)
      } else {
        // Allow re-authentication of a socket to a different user but shouldn't happen
        Logger.warn(`[SocketAuthority] Authenticating socket to user "${user.username}", but is already associated with a different user "${client.user.username}"`)
      }
    } else {
      Logger.debug(`[SocketAuthority] Authenticating socket to user "${user.username}"`)
    }

    client.user = user
    this.adminEmitter('user_online', client.user.toJSONForPublic(this.Server.playbackSessionManager.sessions))

    // Update user lastSeen without firing sequelize bulk update hooks
    user.lastSeen = Date.now()
    await user.save({ hooks: false })

    const initialPayload = {
      userId: client.user.id,
      username: client.user.username
    }
    if (user.isAdminOrUp) {
      initialPayload.usersOnline = this.getUsersOnline()
    }
    client.socket.emit('init', initialPayload)
  }

  cancelScan(id) {
    Logger.debug('[SocketAuthority] Cancel scan', id)
    this.Server.cancelLibraryScan(id)
  }

  /**
   * Handle cover search request via WebSocket
   * @param {SocketIO.Socket} socket
   * @param {Object} payload
   */
  async handleCoverSearch(socket, payload) {
    const client = this.clients[socket.id]
    if (!client?.user) {
      Logger.error('[SocketAuthority] Unauthorized cover search request')
      socket.emit('cover_search_error', {
        requestId: payload.requestId,
        error: 'Unauthorized'
      })
      return
    }

    const { requestId, title, author, provider, podcast } = payload

    if (!requestId || !title) {
      Logger.error('[SocketAuthority] Invalid cover search request')
      socket.emit('cover_search_error', {
        requestId,
        error: 'Invalid request parameters'
      })
      return
    }

    Logger.info(`[SocketAuthority] User ${client.user.username} initiated cover search ${requestId}`)

    // Callback for streaming results to client
    const onResult = (result) => {
      socket.emit('cover_search_result', {
        requestId,
        provider: result.provider,
        covers: result.covers,
        total: result.total
      })
    }

    // Callback when search completes
    const onComplete = () => {
      Logger.info(`[SocketAuthority] Cover search ${requestId} completed`)
      socket.emit('cover_search_complete', { requestId })
    }

    // Callback for provider errors
    const onError = (provider, errorMessage) => {
      socket.emit('cover_search_provider_error', {
        requestId,
        provider,
        error: errorMessage
      })
    }

    // Start the search
    CoverSearchManager.startSearch(requestId, { title, author, provider, podcast }, onResult, onComplete, onError).catch((error) => {
      Logger.error(`[SocketAuthority] Cover search ${requestId} failed:`, error)
      socket.emit('cover_search_error', {
        requestId,
        error: error.message
      })
    })
  }

  /**
   * Handle cancel cover search request
   * @param {SocketIO.Socket} socket
   * @param {string} requestId
   */
  handleCancelCoverSearch(socket, requestId) {
    const client = this.clients[socket.id]
    if (!client?.user) {
      Logger.error('[SocketAuthority] Unauthorized cancel cover search request')
      return
    }

    Logger.info(`[SocketAuthority] User ${client.user.username} cancelled cover search ${requestId}`)

    const cancelled = CoverSearchManager.cancelSearch(requestId)
    if (cancelled) {
      socket.emit('cover_search_cancelled', { requestId })
    }
  }

  /**
   * Cancel all cover searches associated with a socket (called on disconnect)
   * @param {string} socketId
   */
  cancelSocketCoverSearches(socketId) {
    // Get all active search request IDs and cancel those that might belong to this socket
    // Since we don't track socket-to-request mapping, we log this for debugging
    // The client will handle reconnection gracefully
    Logger.debug(`[SocketAuthority] Socket ${socketId} disconnected, any active searches will timeout`)
  }
}
module.exports = new SocketAuthority()
