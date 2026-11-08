# Payd: Devpost submission

**Tagline:** Tap two phones together. Get paid with PayPal. Any iPhone, any Android, no hardware.

---

## Inspiration

Paying with a phone is solved. **Getting paid** with one is not. A food-truck owner, a market stall, a babysitter or a friend who covered dinner still reads out an email address, spells a handle or waves a QR code. Apple Pay and Google Pay only work in one direction (phone to card terminal). Phone-to-phone NFC is closed on iOS and not available on the web anywhere.

We wanted the Apple Pay feeling in both directions, for everyone who has PayPal: **tap, and the money moves.**

## What it does

Payd turns any phone into a PayPal terminal.

- **Tap to pay / tap to get paid**: the receiver enters an amount and the payer knocks their phone against it. The payer sees who they are paying and how much, then *holds to pay*. Both phones flash green within a second or two.
- **Works between iPhone and Android** because it doesn't rely on NFC. Both phones feel the same physical impact through their accelerometers. Each reports the tap on a synchronised server clock, and Payd pairs the *pay* tap with the *receive* tap that land within 900 ms (and within 250 m if location is shared).
- **Business terminal**: catalog, cart, custom amounts, live QR, and a **$0.20 NFC sticker** that any iPhone or Android opens natively to pay whatever is on the counter right now. The Sales tab has one-tap refunds.
- **One-touch after the first payment**: the first time, the payer approves with PayPal. Payd stores the wallet with **PayPal Vault**, so every later tap is instant.

### Where AI comes in (Claude)

1. **Voice checkout**: the barista says *"two flat whites, one with oat, and a banana bread"*. Claude turns it into a structured cart from the menu (synonyms, add-ons, off-menu items flagged). One more tap charges it.
2. **Snap & Split**: photograph the restaurant bill. Claude Vision extracts every line, tax, tip and total, and you pick how many people. Then each friend **taps their phone on yours** to pay their share through PayPal. A live progress bar fills as they pay.
3. **Payd Guard**: before any money moves, every tap is reviewed. Instant rule signals (amount vs. your history, your tap limit, first-time payee, tap velocity, ambiguous pairing, GPS distance) feed a Claude review, and Claude explains the risk to the payer in plain English. High-risk taps require an explicit "I know them and the amount is right". `block` is enforced on the server.
4. **Merchant Copilot**: an agent with tools over the merchant's PayPal transactions. "How did we do today?", "Top sellers this week?", "Ring up 2 lattes and a croissant", "Refund Alice, her coffee was cold", "Pay supplier@beans.co $120". **The agent can't move money on its own.** Refund and payout tools create proposals, and the merchant approves each one. This is agentic commerce with a human in the loop.

## How we built it

- **Frontend**: a dependency-free PWA (vanilla ES modules) that installs to the home screen on iOS and Android. Accelerometer bump detection uses a jerk + magnitude impulse detector that ignores sustained shaking. NTP-style clock sync runs over WebSocket. Press-and-hold confirmation, WebAudio chimes and haptics complete the experience.
- **Backend**: Node + Express + `ws`. A tested **TapMatcher** pairs taps (closest-in-time, geo gate, ambiguity flag, expiry). Payment intents flow over WebSocket to both phones.
- **PayPal** (sandbox):
  - **Orders v2** create + capture. `payee.email_address` sends the funds straight to the person or business being paid, line items + breakdown cover terminal sales, and `PayPal-Request-Id` gives idempotency per tap.
  - **Vault** (`store_in_vault: ON_SUCCESS`, then `payment_source.paypal.vault_id`) for one-touch repeat taps.
  - **Smart Payment Buttons** (JS SDK) for first-time approval.
  - **Refunds** (`/v2/payments/captures/{id}/refund`) from the Sales tab and the Copilot.
  - **Payouts** (`/v1/payments/payouts`) for Copilot-proposed supplier payments.
- **Claude** (`@anthropic-ai/sdk`, `claude-opus-5-5`):
  - **structured outputs** (JSON schema) for carts, receipts and Guard verdicts
  - **vision** for receipts
  - the **tool runner** for the Copilot agent
  - **server-side refusal fallbacks** (`fallbacks: "default"`)
  - low effort for the latency-critical Guard and checkout calls

  Every AI feature has a deterministic fallback, so the payment path never waits on a model: the Guard shows the rule verdict instantly and Claude refines it a moment later.
- **Two-phone simulator** (`/sim`): two live phones side by side. Drag one onto the other, and a live server log shows each tap's clock skew, the match Δt, the Guard verdict, every PayPal API call and every Claude call.
- **Tests**: 23 `node:test` cases, including an end-to-end run with two WebSocket "phones" that tap, pay, refund, pay via an NFC sticker link and collect a split. The Claude integration is tested against a fake transport.

## Challenges we ran into

- **NFC isn't available.** iOS doesn't expose phone-to-phone NFC and the web has no host card emulation. We switched to *physics*: both phones feel the same knock. The hard parts were clock sync (each phone stamps the tap on the server's clock), rejecting walking and shaking, and handling two pairs tapping at once in the same café (ambiguity detection that feeds the Guard).
- **Making AI safe around money.** The model never moves funds. Guard verdicts are advisory except `block`, which the server enforces. Copilot refunds and payouts are proposals that need human approval.
- **Latency.** Payments must feel instant, so the AI has to stay off the critical path. The rule verdict renders at once, and Claude's review streams in after.

## Accomplishments we're proud of

- A real cross-platform tap-to-pay experience in a browser, iPhone ↔ Android.
- Phones become terminals: a cheap NFC sticker gives any café contactless PayPal with no hardware contract.
- Snap & Split shows the whole idea in one flow: Claude reads the bill, friends tap, PayPal settles it.

## What we learned

- Accelerometer impulses from two phones colliding line up within tens of milliseconds once clocks are synced, which is tight enough to pair reliably.
- PayPal Vault plus a press-and-hold gesture gets close to the Apple Pay feel with a wallet people already have.
- Structured outputs make LLM features dependable enough to sit next to a payment flow.

## What's next

- Native wrappers (App Clip / Instant App) for background tap detection and true NFC where available.
- PayPal Log In + passkeys for identity, and PayPal webhooks for settlement notifications.
- Ultrasonic chirp as a third pairing signal for crowded venues.
- Tipping prompts and multi-currency for travellers.

## Built with

`paypal-orders-v2` · `paypal-vault` · `paypal-js-sdk` · `paypal-payouts` · `paypal-refunds` · `claude` · `anthropic-sdk` · `node.js` · `express` · `websockets` · `pwa` · `devicemotion` · `web-nfc`

## AI tools used (required disclosure)

- **Claude API (`claude-opus-5-5`, via `@anthropic-ai/sdk`)**, used at runtime for:
  - voice/text checkout (structured outputs)
  - receipt extraction (vision + structured outputs)
  - Payd Guard risk review (structured outputs)
  - the Merchant Copilot agent (tool use via the SDK tool runner)
  - server-side refusal fallbacks on every call
- **Claude Code** was used as a coding assistant while building the project.

---

## Demo video script (under 3 minutes)

| Time | Shot | Voice-over |
|---|---|---|
| 0:00–0:12 | Two real phones (one iPhone, one Android) on a café counter | "Paying with your phone is solved. Getting paid with it isn't. Meet Payd." |
| 0:12–0:40 | Café terminal: barista says "two flat whites, one with oat, and a banana bread" → cart fills → Charge $14.90 | "The barista just says the order. Claude builds the cart from the menu." |
| 0:40–1:05 | Customer knocks iPhone on the Android terminal → pay sheet with Payd Guard → hold to pay → both phones go green | "Tap. Payd matches the two taps in milliseconds. Guard checks it, PayPal captures it, done. iPhone to Android, no NFC." |
| 1:05–1:20 | Show the NFC sticker on the counter, tap it with a third phone | "No sensor? A twenty-cent NFC sticker opens the same checkout on any phone." |
| 1:20–1:55 | Snap & Split: photograph receipt → Claude extracts lines → 3 people → two friends tap in turn → progress bar fills | "Dinner for three: snap the bill, and friends tap their phones on yours to pay their share." |
| 1:55–2:15 | P2P $480 request → Guard turns red with plain-English reasons → requires acknowledgement | "Something unusual? Guard explains why before any money moves." |
| 2:15–2:40 | Merchant Copilot: "How did we do today?" → "Refund the last payment" → Approve | "And the Copilot runs the shop on PayPal data. It proposes refunds and payouts, and you approve them." |
| 2:40–2:55 | Simulator log showing taps, Δt, PayPal calls | "PayPal Orders, Vault, Refunds and Payouts, with Claude for the intelligence. Payd: tap phones, get paid." |
