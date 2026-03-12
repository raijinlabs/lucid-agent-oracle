// apps/worker/src/config.ts

export interface WorkerConfig {
  pollIntervalMs: number
  computationWindowMs: number
  heartbeatIntervalMs: number
  workerLockId: number
  databaseUrl: string
  clickhouseUrl: string
  clickhouseUser: string
  clickhousePassword: string
  redpandaBrokers: string[]
  attestationKey: string
}

export function loadConfig(): WorkerConfig {
  const required = (key: string): string => {
    const val = process.env[key]
    if (!val) throw new Error(`Missing required env var: ${key}`)
    return val
  }

  return {
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS ?? '300000', 10),
    computationWindowMs: parseInt(process.env.COMPUTATION_WINDOW_MS ?? '3600000', 10),
    heartbeatIntervalMs: parseInt(process.env.HEARTBEAT_INTERVAL_MS ?? '900000', 10),
    workerLockId: parseInt(process.env.WORKER_LOCK_ID ?? '1', 10),
    databaseUrl: required('DATABASE_URL'),
    clickhouseUrl: required('CLICKHOUSE_URL'),
    clickhouseUser: process.env.CLICKHOUSE_USER ?? 'default',
    clickhousePassword: required('CLICKHOUSE_PASSWORD'),
    redpandaBrokers: required('REDPANDA_BROKERS').split(','),
    attestationKey: required('ORACLE_ATTESTATION_KEY'),
  }
}
