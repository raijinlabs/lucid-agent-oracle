import { encodeOnChainValue, type PublicationRequest, type FeedId } from '@lucid/oracle-core'

export interface BaseClient {
  writeContract(args: {
    address: `0x${string}`
    abi: readonly unknown[]
    functionName: string
    args: readonly unknown[]
  }): Promise<`0x${string}`>
  waitForTransactionReceipt(args: { hash: `0x${string}` }): Promise<{ transactionHash: `0x${string}`; status: string }>
}

const LUCID_ORACLE_ABI = [
  {
    type: 'function',
    name: 'postReport',
    inputs: [
      { name: 'feedId', type: 'bytes16' },
      { name: 'value', type: 'uint64' },
      { name: 'decimals', type: 'uint8' },
      { name: 'confidence', type: 'uint16' },
      { name: 'revision', type: 'uint16' },
      { name: 'reportTimestamp', type: 'uint64' },
      { name: 'inputManifestHash', type: 'bytes32' },
      { name: 'computationHash', type: 'bytes32' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

const RETRY_DELAYS = [0, 2000, 4000]

function feedIdToBytes16(feedId: string): `0x${string}` {
  const hex = Buffer.from(feedId.padEnd(16, '\0')).toString('hex')
  return `0x${hex}` as `0x${string}`
}

function toBytes32(hex: string): `0x${string}` {
  const padded = hex.replace(/^0x/, '').padStart(64, '0')
  return `0x${padded}` as `0x${string}`
}

export async function postToBase(
  client: BaseClient,
  req: PublicationRequest,
  contractAddress?: `0x${string}`,
): Promise<string> {
  const addr = contractAddress ?? (process.env.BASE_CONTRACT_ADDRESS as `0x${string}`)
  const { value, decimals } = encodeOnChainValue(req.feed_id as FeedId, req.value_usd, req.value_index)
  const confidenceBps = Math.round(req.confidence * 10000)
  const timestamp = BigInt(new Date(req.computed_at).getTime()) // milliseconds since epoch

  let lastError: Error | undefined
  for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS[attempt])
    try {
      const hash = await client.writeContract({
        address: addr,
        abi: LUCID_ORACLE_ABI,
        functionName: 'postReport',
        args: [
          feedIdToBytes16(req.feed_id),
          value,
          decimals,
          confidenceBps,
          req.revision,
          timestamp,
          toBytes32(req.input_manifest_hash),
          toBytes32(req.computation_hash),
        ],
      })
      await client.waitForTransactionReceipt({ hash })
      return hash
    } catch (err) {
      lastError = err as Error
    }
  }
  throw lastError
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
