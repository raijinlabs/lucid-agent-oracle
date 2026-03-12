import pg from 'pg'
import {
  OracleClickHouse,
  RedpandaProducer,
  AttestationService,
} from '@lucid/oracle-core'
import { loadConfig } from './config.js'
import { acquireAdvisoryLock } from './lock.js'
import { CheckpointManager } from './checkpoint.js'
import { runCycle, seedLastPublishTimes } from './cycle.js'

const { Pool } = pg
const config = loadConfig()

console.log('Oracle Worker starting...')
console.log(`  Poll interval: ${config.pollIntervalMs}ms`)
console.log(`  Computation window: ${config.computationWindowMs}ms`)
console.log(`  Heartbeat interval: ${config.heartbeatIntervalMs}ms`)

// Acquire advisory lock
const lock = await acquireAdvisoryLock(config.databaseUrl, config.workerLockId)
if (!lock) {
  console.log('Another worker instance is running — exiting cleanly')
  process.exit(0)
}

console.log('Advisory lock acquired')

// Initialize clients
const clickhouse = new OracleClickHouse({
  url: config.clickhouseUrl,
  username: config.clickhouseUser,
  password: config.clickhousePassword,
})

const producer = new RedpandaProducer({
  brokers: config.redpandaBrokers,
  clientId: 'oracle-worker',
})
await producer.connect()

const attestation = new AttestationService({ privateKeyHex: config.attestationKey })
const checkpointMgr = new CheckpointManager(config.databaseUrl)
const pool = new Pool({ connectionString: config.databaseUrl })

// Seed last publish times from ClickHouse (avoids spurious first-cycle publishes)
await seedLastPublishTimes(clickhouse)
console.log('Last publish times seeded from ClickHouse')

// Graceful shutdown
let shuttingDown = false
const shutdown = async () => {
  if (shuttingDown) return
  shuttingDown = true
  console.log('Shutting down...')
  await lock.release()
  await producer.disconnect()
  await clickhouse.close()
  await checkpointMgr.close()
  await pool.end()
  console.log('Shutdown complete')
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// Non-overlapping poll loop
const runLoop = async () => {
  while (!shuttingDown) {
    try {
      console.log(`[${new Date().toISOString()}] Starting poll cycle`)
      await runCycle(config, clickhouse, producer, attestation, checkpointMgr, pool)
      console.log(`[${new Date().toISOString()}] Cycle complete`)
    } catch (err) {
      console.error('Cycle error:', err)
    }

    // Non-overlapping: setTimeout after completion, not setInterval
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs))
  }
}

runLoop()
