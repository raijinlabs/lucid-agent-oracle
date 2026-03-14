import { Type, type Static } from '@sinclair/typebox'
import { DataEnvelope } from './common.js'

// ---------------------------------------------------------------------------
// Verify Report request body — matches ReportEnvelope from oracle-core
// ---------------------------------------------------------------------------

const ReportSignature = Type.Object({
  signer: Type.String(),
  sig: Type.String(),
})

const ReportEnvelopeSchema = Type.Object({
  feed_id: Type.String(),
  feed_version: Type.Integer(),
  report_timestamp: Type.Number(),
  values: Type.Record(Type.String(), Type.Unknown()),
  input_manifest_hash: Type.String(),
  computation_hash: Type.String(),
  revision: Type.Integer(),
  signer_set_id: Type.String(),
  signatures: Type.Array(ReportSignature, { minItems: 1 }),
})

export const VerifyReportBody = Type.Object(
  {
    report: ReportEnvelopeSchema,
  },
  { $id: 'VerifyReportBody' },
)

export type VerifyReportBody = Static<typeof VerifyReportBody>

// ---------------------------------------------------------------------------
// Verify Report response
// ---------------------------------------------------------------------------

const VerifyChecks = Type.Object({
  signature: Type.Union([Type.Literal('pass'), Type.Literal('fail')]),
  payload_integrity: Type.Union([Type.Literal('pass'), Type.Literal('fail')]),
  signer_set_id: Type.String(),
  signers: Type.Array(Type.String()),
})

const VerifyPublication = Type.Object({
  solana_tx: Type.Union([Type.String(), Type.Null()]),
  base_tx: Type.Union([Type.String(), Type.Null()]),
})

const VerifyReportData = Type.Object({
  valid: Type.Boolean(),
  checks: VerifyChecks,
  publication: VerifyPublication,
})

export const VerifyReportResponse = DataEnvelope(VerifyReportData, 'VerifyReportResponse')

export type VerifyReportResponse = Static<typeof VerifyReportResponse>
