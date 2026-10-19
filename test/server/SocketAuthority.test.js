const { expect } = require('chai')
const sinon = require('sinon')
const SocketAuthority = require('../../server/SocketAuthority')
const TaskManager = require('../../server/managers/TaskManager')
const Database = require('../../server/Database')

describe('SocketAuthority Multi-Replica Enhancements', () => {
  let originalClients
  let originalServer

  beforeEach(() => {
    originalClients = SocketAuthority.clients
    originalServer = SocketAuthority.Server
  })

  afterEach(() => {
    SocketAuthority.clients = originalClients
    SocketAuthority.Server = originalServer
    sinon.restore()
  })

  describe('TaskManager cross-pod synchronization', () => {
    it('should add and remove remote tasks when broadcast events are received', () => {
      const taskPayload = {
        id: 'remote-task-1',
        action: 'library-scan',
        title: 'Scanning Library',
        data: { libraryId: 'lib-1' }
      }

      TaskManager.handleRemoteTaskStarted(taskPayload)
      expect(TaskManager.tasks.some((t) => t.id === 'remote-task-1')).to.be.true
      const task = TaskManager.tasks.find((t) => t.id === 'remote-task-1')
      expect(task.toJSON()).to.deep.include({ id: 'remote-task-1', action: 'library-scan' })

      TaskManager.handleRemoteTaskFinished(taskPayload)
      expect(TaskManager.tasks.some((t) => t.id === 'remote-task-1')).to.be.false
    })
  })

  describe('SocketAuthority cluster-aware getUsersOnline', () => {
    it('should query abs_socket_presences when postgres is active', async () => {
      sinon.stub(Database, 'isPostgresDialect').returns(true)
      Database.sequelize = {
        query: sinon.stub().resolves([
          [
            {
              user_id: 'user-1',
              user_json: { id: 'user-1', username: 'alice' },
              connections: '2'
            },
            {
              user_id: 'user-2',
              user_json: JSON.stringify({ id: 'user-2', username: 'bob' }),
              connections: '1'
            }
          ]
        ])
      }

      const users = await SocketAuthority.getUsersOnline()
      expect(users).to.have.lengthOf(2)
      expect(users[0]).to.deep.include({ id: 'user-1', username: 'alice', connections: 2 })
      expect(users[1]).to.deep.include({ id: 'user-2', username: 'bob', connections: 1 })
    })

    it('should fall back to local clients when postgres query fails or on sqlite', async () => {
      sinon.stub(Database, 'isPostgresDialect').returns(false)
      SocketAuthority.clients = {
        'socket-local-1': {
          user: {
            id: 'user-local',
            toJSONForPublic: () => ({ id: 'user-local', username: 'localuser' })
          }
        }
      }

      const users = await SocketAuthority.getUsersOnline()
      expect(users).to.have.lengthOf(1)
      expect(users[0]).to.deep.include({ id: 'user-local', username: 'localuser', connections: 1 })
    })
  })

  describe('SocketAuthority cross-pod cancel_scan dispatch', () => {
    it('should publish cancel_scan broadcast and cancel locally', () => {
      const publishStub = sinon.stub(SocketAuthority, 'publishBroadcast')
      SocketAuthority.Server = {
        cancelLibraryScan: sinon.stub()
      }

      SocketAuthority.cancelScan('lib-123')
      expect(SocketAuthority.Server.cancelLibraryScan.calledWith('lib-123')).to.be.true
      expect(publishStub.calledWith({ type: 'cancel_scan', libraryId: 'lib-123' })).to.be.true
    })

    it('should cancel local scan when cancel_scan message is received from pub/sub', () => {
      SocketAuthority.Server = {
        cancelLibraryScan: sinon.stub()
      }

      SocketAuthority._dispatchLocally({ type: 'cancel_scan', libraryId: 'lib-remote-456' })
      expect(SocketAuthority.Server.cancelLibraryScan.calledWith('lib-remote-456')).to.be.true
    })
  })
})
