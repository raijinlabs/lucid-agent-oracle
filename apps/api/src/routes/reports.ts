import type { FastifyInstance } from 'fastify'
import {
  AttestationService,
  type ReportEnvelope,
  type OracleClickHouse,
  V1_FEEDS,
  type FeedId,
} from '@lucid/oracle-core'
import { VerifyReportBody, VerifyReportResponse } from '../schemas/reports.js'

export function registerReportRoutes(
  app: FastifyInstance,
  clickhouse: OracleClickHouse | null,
): void {
  // Single instance — verifyReport() uses the envelope's public keys, not this service's key
  const attestation = new AttestationService({ seed: 'verify-only' })

  // ---- POST /v1/oracle/reports/verify ----
  app.post('/v1/oracle/reports/verify', {
    schema: {
      tags: ['reports'],
      summary: 'Verify oracle report',
      description: 'Verify a signed oracle report envelope — Ed25519 signature + payload integrity + publication status.',
      body: VerifyReportBody,
      response: {
        200: VerifyReportResponse,
        400: { $ref: 'ProblemDetail' },
      },
    },
    config: {
      rateLimit: { max: 10 },
    },
  }, async (request, reply) => {
    const { report } = request.body as { report: ReportEnvelope }

    // 1. Signature check — verifyReport() strips signer_set_id/signatures,
    //    canonicalizes the remaining ReportPayload, and verifies each Ed25519 signature.
    let signaturePass = false
    try {
      signaturePass = attestation.verifyReport(report)
    } catch {
      signaturePass = false
    }

    // 2. Payload integrity — if the signature over the canonical payload verifies,
    //    the payload has not been tampered with. Signature verification IS the
    //    integrity check (the sig covers the exact canonical JSON of the payload).
    //    A separate hash comparison is not needed and computation_hash is the
    //    code-version hash, not a payload hash.
    const integrityPass = signaturePass

    // 3. Publication lookup (optional — depends on ClickHouse availability)
    //    Convert report_timestamp (epoch ms) → ISO string to match computed_at column.
    let solanaTx: string | null = null
    let baseTx: string | null = null

    if (clickhouse && report.feed_id) {
      const feedDef = V1_FEEDS[report.feed_id as FeedId]
      if (feedDef) {
        try {
          const computedAt = new Date(report.report_timestamp).toISOString()
          const pub = await clickhouse.queryPublicationStatus(
            report.feed_id,
            feedDef.version,
            computedAt,
            report.revision,
          )
          if (pub) {
            solanaTx = pub.published_solana
            baseTx = pub.published_base
          }
        } catch {
          // Publication lookup failure is non-fatal
        }
      }
    }

    const valid = signaturePass && integrityPass

    return reply.send({
      data: {
        valid,
        checks: {
          signature: signaturePass ? 'pass' : 'fail',
          payload_integrity: integrityPass ? 'pass' : 'fail',
          signer_set_id: report.signer_set_id,
          signers: report.signatures.map((s) => s.signer),
        },
        publication: {
          solana_tx: solanaTx,
          base_tx: baseTx,
        },
      },
    })
  })
}
