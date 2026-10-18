const { expect } = require('chai')
const { pLimit } = require('../../../server/utils/asyncUtils')

describe('asyncUtils.pLimit', () => {
  it('should limit maximum concurrent executions', async () => {
    const limit = pLimit(2)
    let active = 0
    let maxActive = 0

    const makeTask = (delayMs) =>
      limit(async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        active--
        return delayMs
      })

    const tasks = [makeTask(20), makeTask(20), makeTask(20), makeTask(20)]
    const results = await Promise.all(tasks)

    expect(results).to.deep.equal([20, 20, 20, 20])
    expect(maxActive).to.equal(2)
    expect(active).to.equal(0)
  })

  it('should handle rejections properly without breaking subsequent tasks', async () => {
    const limit = pLimit(2)
    let reachedAfter = false

    const failTask = limit(async () => {
      throw new Error('Task exploded')
    })

    const succeedTask = limit(async () => {
      reachedAfter = true
      return 'ok'
    })

    let error = null
    try {
      await failTask
    } catch (err) {
      error = err
    }
    expect(error).to.be.an('error')
    expect(error.message).to.equal('Task exploded')

    const res = await succeedTask
    expect(res).to.equal('ok')
    expect(reachedAfter).to.be.true
  })

  it('should reject invalid concurrency values', () => {
    expect(() => pLimit(0)).to.throw(TypeError)
    expect(() => pLimit(-1)).to.throw(TypeError)
    expect(() => pLimit('invalid')).to.throw(TypeError)
  })
})
