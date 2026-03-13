/** Stateless signature verifier — one per chain family */
export interface WalletVerifier {
  readonly chains: readonly string[]
  verify(address: string, message: string, signature: string): Promise<boolean>
}

/** Maps chain → verifier at startup */
export class VerifierRegistry {
  private readonly byChain = new Map<string, WalletVerifier>()

  register(verifier: WalletVerifier): void {
    for (const chain of verifier.chains) {
      if (this.byChain.has(chain)) {
        throw new Error(`Chain "${chain}" already registered`)
      }
      this.byChain.set(chain, verifier)
    }
  }

  getForChain(chain: string): WalletVerifier | undefined {
    return this.byChain.get(chain)
  }

  getForChainOrThrow(chain: string): WalletVerifier {
    const v = this.byChain.get(chain)
    if (!v) throw new Error(`No verifier registered for chain "${chain}"`)
    return v
  }

  supportedChains(): string[] {
    return [...this.byChain.keys()]
  }
}

/** Singleton registry — populated at startup */
export const verifierRegistry = new VerifierRegistry()
