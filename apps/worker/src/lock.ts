import pg from 'pg'

const { Client } = pg

export interface LockHandle {
  release: () => Promise<void>
}

/**
 * Acquire a Postgres advisory lock on a dedicated connection.
 * Returns a LockHandle if acquired, null if already held.
 * If the connection drops, calls onLost (default: process.exit(1)).
 */
export async function acquireAdvisoryLock(
  connectionString: string,
  lockId: number,
  onLost?: () => void,
): Promise<LockHandle | null> {
  const client = new Client({ connectionString })
  await client.connect()

  client.on('error', () => {
    console.error('Advisory lock connection lost — exiting')
    ;(onLost ?? (() => process.exit(1)))()
  })

  const result = await client.query('SELECT pg_try_advisory_lock($1)', [lockId])
  const acquired = result.rows[0]?.pg_try_advisory_lock === true

  if (!acquired) {
    await client.end()
    return null
  }

  return {
    release: async () => {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [lockId])
      } finally {
        await client.end()
      }
    },
  }
}

// Re-export for backward compat in tests
export async function releaseAdvisoryLock(handle: LockHandle): Promise<void> {
  await handle.release()
}
