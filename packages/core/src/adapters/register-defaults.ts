import { adapterRegistry } from './registry.js'
import { gatewayTapAdapter } from './gateway-tap-adapter.js'
import { erc8004Adapter } from './erc8004-adapter.js'
import { heliusAdapter } from './helius-adapter.js'

/**
 * Register all built-in adapters with the global registry.
 *
 * Called once at process startup. After this, any code can discover adapters via:
 *   import { adapterRegistry } from '@lucid/oracle-core'
 *   const adapter = adapterRegistry.get('erc8004')
 *
 * To add a new provider:
 *   1. Create a new *-adapter.ts file implementing AdapterDefinition
 *   2. Import and register it here
 *   3. That's it — webhook routes and identity resolution wire up automatically
 */
export function registerDefaultAdapters(): void {
  if (adapterRegistry.size > 0) return // idempotent

  adapterRegistry.register(gatewayTapAdapter)
  adapterRegistry.register(erc8004Adapter)
  adapterRegistry.register(heliusAdapter)
}
