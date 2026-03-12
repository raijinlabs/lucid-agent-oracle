import { describe, it, expect } from 'vitest'
import {
  transformReceiptEvent,
  transformAuditLogEntry,
  transformPaymentSession,
} from '../adapters/gateway-tap.js'

describe('GatewayTap', () => {
  describe('transformReceiptEvent', () => {
    it('transforms a receipt event into a RawEconomicEvent', () => {
      const receipt = {
        id: 'evt_abc123',
        tenant_id: 'tenant_demo',
        model: 'openai/gpt-4o',
        endpoint: '/v1/chat/completions',
        tokens_in: 500,
        tokens_out: 200,
        model_passport_id: null,
        compute_passport_id: null,
        created_at: '2026-03-12T10:00:00Z',
      }
      const event = transformReceiptEvent(receipt)

      expect(event.source).toBe('lucid_gateway')
      expect(event.event_type).toBe('llm_inference')
      expect(event.chain).toBe('offchain')
      expect(event.subject_raw_id).toBe('tenant_demo')
      expect(event.subject_id_type).toBe('tenant')
      expect(event.protocol).toBe('lucid')
      expect(event.model_id).toBe('gpt-4o')
      expect(event.provider).toBe('openai')
      expect(event.status).toBe('success')
      expect(event.economic_authentic).toBe(true)
      expect(event.event_id).toBeTruthy()
    })
  })

  describe('transformAuditLogEntry', () => {
    it('transforms an audit log entry into a tool_call event', () => {
      const entry = {
        id: '42',
        tenant_id: 'tenant_demo',
        server_id: 'github',
        tool_name: 'create_issue',
        status: 'success',
        duration_ms: 340,
        created_at: '2026-03-12T10:01:00Z',
      }
      const event = transformAuditLogEntry(entry)

      expect(event.event_type).toBe('tool_call')
      expect(event.tool_name).toBe('create_issue')
      expect(event.duration_ms).toBe(340)
      expect(event.status).toBe('success')
    })
  })

  describe('transformPaymentSession', () => {
    it('transforms a payment session into a payment event', () => {
      const session = {
        id: 'ps_abc',
        tenant_id: 'tenant_demo',
        token: 'USDC',
        deposit_amount: '10000000',
        chain: 'base',
        tx_hash: '0xabc123',
        status: 'active',
        created_at: '2026-03-12T10:02:00Z',
      }
      const event = transformPaymentSession(session)

      expect(event.event_type).toBe('payment')
      expect(event.chain).toBe('base')
      expect(event.tx_hash).toBe('0xabc123')
      expect(event.currency).toBe('USDC')
      expect(event.amount).toBe('10000000')
      expect(event.economic_authentic).toBe(true)
    })
  })
})
