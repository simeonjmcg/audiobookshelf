/**
 * Async utility functions
 */

/**
 * Limits the concurrency of async operations.
 *
 * @param {number} concurrency - Max concurrent executions (>= 1)
 * @returns {function(function(): Promise<any>): Promise<any>}
 */
function pLimit(concurrency) {
  if (!((Number.isInteger(concurrency) || concurrency === Infinity) && concurrency > 0)) {
    throw new TypeError('Expected `concurrency` to be a number from 1 and up')
  }

  const queue = []
  let activeCount = 0

  const next = () => {
    activeCount--
    if (queue.length > 0) {
      queue.shift()()
    }
  }

  const run = async (fn, resolve, reject, args) => {
    activeCount++
    try {
      const result = await fn(...args)
      resolve(result)
    } catch (err) {
      reject(err)
    } finally {
      next()
    }
  }

  const enqueue = (fn, resolve, reject, args) => {
    queue.push(run.bind(null, fn, resolve, reject, args))
    if (activeCount < concurrency && queue.length > 0) {
      queue.shift()()
    }
  }

  const generator = (fn, ...args) =>
    new Promise((resolve, reject) => {
      enqueue(fn, resolve, reject, args)
    })

  Object.defineProperties(generator, {
    activeCount: {
      get: () => activeCount
    },
    pendingCount: {
      get: () => queue.length
    },
    clearQueue: {
      value: () => {
        queue.length = 0
      }
    }
  })

  return generator
}

module.exports = {
  pLimit
}
