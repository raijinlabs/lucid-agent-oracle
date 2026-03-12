export interface PublisherConfig {
  redpandaBrokers: string[]
  clickhouseUrl: string
  clickhouseUser: string
  clickhousePassword: string
  solanaRpcUrl: string
  solanaKeypairPath: string
  solanaProgramId: string
  baseRpcUrl: string
  basePrivateKey: string
  baseContractAddress: string
  consumerGroup: string
}

export function loadConfig(): PublisherConfig {
  const required = (key: string): string => {
    const val = process.env[key]
    if (!val) throw new Error(`Missing required env var: ${key}`)
    return val
  }

  return {
    redpandaBrokers: required('REDPANDA_BROKERS').split(','),
    clickhouseUrl: required('CLICKHOUSE_URL'),
    clickhouseUser: process.env.CLICKHOUSE_USER ?? 'default',
    clickhousePassword: required('CLICKHOUSE_PASSWORD'),
    solanaRpcUrl: required('SOLANA_RPC_URL'),
    solanaKeypairPath: required('SOLANA_KEYPAIR_PATH'),
    solanaProgramId: required('SOLANA_PROGRAM_ID'),
    baseRpcUrl: required('BASE_RPC_URL'),
    basePrivateKey: required('BASE_PRIVATE_KEY'),
    baseContractAddress: required('BASE_CONTRACT_ADDRESS'),
    consumerGroup: process.env.PUBLISHER_CONSUMER_GROUP ?? 'oracle-publisher',
  }
}
