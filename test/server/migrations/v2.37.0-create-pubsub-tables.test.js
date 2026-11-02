const { expect } = require('chai')
const sinon = require('sinon')
const { up, down } = require('../../../server/migrations/v2.37.0-create-pubsub-tables')
const Logger = require('../../../server/Logger')

describe('migration-v2.37.0-create-pubsub-tables', () => {
  let loggerInfoStub

  beforeEach(() => {
    loggerInfoStub = sinon.stub(Logger, 'info')
  })

  afterEach(() => {
    sinon.restore()
  })

  describe('up', () => {
    it('should skip on non-postgres dialect', async () => {
      const fakeQueryInterface = {
        sequelize: {
          getDialect: () => 'sqlite',
          query: sinon.stub().resolves()
        }
      }

      await up({ context: { queryInterface: fakeQueryInterface, logger: Logger } })

      expect(loggerInfoStub.calledWithMatch('Skipping 2.37.0-create-pubsub-tables on non-postgres dialect')).to.be.true
      expect(fakeQueryInterface.sequelize.query.called).to.be.false
    })

    it('should create unlogged tables and indexes on postgres', async () => {
      const fakeQueryInterface = {
        sequelize: {
          getDialect: () => 'postgres',
          query: sinon.stub().resolves()
        }
      }

      await up({ context: { queryInterface: fakeQueryInterface, logger: Logger } })

      expect(fakeQueryInterface.sequelize.query.calledOnce).to.be.true
      const ddl = fakeQueryInterface.sequelize.query.firstCall.args[0]
      expect(ddl).to.include('CREATE UNLOGGED TABLE IF NOT EXISTS abs_broadcast_events')
      expect(ddl).to.include('CREATE UNLOGGED TABLE IF NOT EXISTS abs_socket_presences')
      expect(ddl).to.include('CREATE INDEX IF NOT EXISTS idx_abs_broadcast_events_created')
      expect(loggerInfoStub.calledWithMatch('UPGRADE END: 2.37.0-create-pubsub-tables')).to.be.true
    })
  })

  describe('down', () => {
    it('should skip on non-postgres dialect', async () => {
      const fakeQueryInterface = {
        sequelize: {
          getDialect: () => 'sqlite',
          query: sinon.stub().resolves()
        }
      }

      await down({ context: { queryInterface: fakeQueryInterface, logger: Logger } })

      expect(loggerInfoStub.calledWithMatch('Skipping 2.37.0-create-pubsub-tables on non-postgres dialect')).to.be.true
      expect(fakeQueryInterface.sequelize.query.called).to.be.false
    })

    it('should drop tables on postgres', async () => {
      const fakeQueryInterface = {
        sequelize: {
          getDialect: () => 'postgres',
          query: sinon.stub().resolves()
        }
      }

      await down({ context: { queryInterface: fakeQueryInterface, logger: Logger } })

      expect(fakeQueryInterface.sequelize.query.calledOnce).to.be.true
      const ddl = fakeQueryInterface.sequelize.query.firstCall.args[0]
      expect(ddl).to.include('DROP TABLE IF EXISTS abs_socket_presences')
      expect(ddl).to.include('DROP TABLE IF EXISTS abs_broadcast_events')
      expect(loggerInfoStub.calledWithMatch('DOWNGRADE END: 2.37.0-create-pubsub-tables')).to.be.true
    })
  })
})
