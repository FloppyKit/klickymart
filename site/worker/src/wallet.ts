/** /wallet guide data, shared by the page and the MCP tool wallet_setup_guide. Non-custodial: KlickyMart never generates,
 * holds or sees wallet seeds, funds, NWC connection secrets or Cashu tokens. Links checked 2026-10-30; no affiliate links. */
export interface WalletOption { name: string; url: string; source?: string; custody: string; agent_fit: string }
export const WALLET_GUIDE = {
  principle: "Non-custodial: KlickyMart never generates, holds or sees your wallet seed, funds, NWC connection string or Cashu tokens. Never paste them into KlickyMart.",
  nostr_key: { how: "Create a Nostr key in your browser (the secret never leaves the page) or with your own tooling.", url: "/report#km-sign" },
  lightning: [
    { name: "Nostr Wallet Connect (NWC, NIP-47)", url: "https://nwc.dev", source: "https://github.com/nostr-protocol/nips/blob/master/47.md", custody: "A protocol, not a wallet: funds stay in whichever wallet or node you connect. The connection string is a spending secret; keep it on your side and set budgets.", agent_fit: "Lets an agent request payments from your wallet with spending limits." },
    { name: "Alby Hub", url: "https://albyhub.com", source: "https://github.com/getAlby/hub", custody: "Self-custodial when you run it yourself (your node, your keys). A hosted Alby Cloud plan is run by Alby on your behalf.", agent_fit: "Built-in NWC connections with per-app budgets." },
    { name: "phoenixd (Phoenix server)", url: "https://github.com/ACINQ/phoenixd", source: "https://github.com/ACINQ/phoenixd", custody: "Self-custodial: you hold the seed; ACINQ provides channel liquidity (as your Lightning service provider), not custody.", agent_fit: "Small HTTP API for headless send/receive." },
    { name: "Phoenix (mobile)", url: "https://phoenix.acinq.co", source: "https://github.com/ACINQ/phoenix", custody: "Self-custodial mobile wallet: you hold the seed.", agent_fit: "For a human topping up or receiving; not headless." },
    { name: "LNbits (self-hosted)", url: "https://lnbits.com", source: "https://github.com/lnbits/lnbits", custody: "Whoever runs the LNbits server holds the funds of its sub-wallets. Self-hosted on your own node = you; someone else's instance = them.", agent_fit: "Per-agent sub-wallets with API keys, Lightning addresses via extensions." },
  ] as WalletOption[],
  lud16: {
    what: "A Lightning address (name@domain, LUD-16) lets others pay or zap you.",
    get: "Use the address your wallet or server provides (Alby Hub, LNbits with its address extension, or your own domain). See https://lightningaddress.com.",
    add_to_notes: 'Add ["lud16","you@your-wallet.example"] to your 422 notes (or template param lud16=) so readers can tip useful notes. Tips are NIP-57 zaps; see https://github.com/nostr-protocol/nips/blob/master/57.md.',
  },
  cashu: {
    custody: "Cashu is custodial ecash: the MINT holds the bitcoin; your tokens are claims on that mint. If the mint disappears or refuses redemption, the tokens are worth nothing. Tokens are bearer secrets: whoever has them can spend them.",
    wallets: [
      { name: "Cashu.me", url: "https://cashu.me", source: "https://github.com/cashubtc/cashu.me", custody: "Wallet holds tokens locally; the mint holds the funds.", agent_fit: "Browser/PWA wallet for humans." },
      { name: "Nutstash", url: "https://nutstash.app", source: "https://github.com/gandlafbtc/nutstash-wallet", custody: "Wallet holds tokens locally; the mint holds the funds.", agent_fit: "Browser wallet for humans." },
      { name: "cashu-ts", url: "https://github.com/cashubtc/cashu-ts", source: "https://github.com/cashubtc/cashu-ts", custody: "Library; your code holds the tokens, the mint holds the funds.", agent_fit: "TypeScript library for agents." },
      { name: "Nutshell", url: "https://github.com/cashubtc/nutshell", source: "https://github.com/cashubtc/nutshell", custody: "Python wallet and mint. As a wallet, the mint you use holds the funds; running your own mint makes you the custodian.", agent_fit: "CLI/API wallet for agents." },
    ] as WalletOption[],
    pick_a_mint: "Prefer a mint run by someone you can identify, with a public track record and an operator you would trust with the amount; keep balances small; spread across mints; redeem to Lightning regularly. Docs: https://docs.cashu.space and https://cashu.space.",
  },
  fkt: "FKT wallet onboarding: coming later.",
  checklist: [
    { step: "nostr-key", do: "Create a Nostr key for shopping notes and keep its secret local.", where: "/report#km-sign" },
    { step: "choose-custody", do: "Decide who should hold funds: you (self-hosted node, Alby Hub, phoenixd), a server operator (LNbits instance), or a Cashu mint." },
    { step: "lightning", do: "Set up a Lightning wallet or node you control; for agents, create an NWC connection with a small budget." },
    { step: "budget", do: "Fund only what the agent needs; set per-connection spending limits." },
    { step: "lud16", do: "Get a Lightning address and add [\"lud16\", ...] to your notes so others can tip you." },
    { step: "cashu-optional", do: "If using Cashu, pick a mint deliberately, keep balances small, and back up tokens; the mint holds the funds." },
    { step: "never-share", do: "Never send seeds, NWC strings, Cashu tokens or nsec to KlickyMart or any website that asks." },
  ],
};
