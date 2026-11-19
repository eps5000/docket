# Plan: Checkout revamp

- **Stack:** TypeScript, React, the provider's JS SDK in sandbox mode.
- **Card form:** the provider's hosted fields (ADR 0001); our own validation layer on top.
- **3-D Secure:** the provider's challenge API, shown in a modal; needs the sandbox wired first.
- **Analytics:** one event per step (`checkout.form_shown`, `checkout.submitted`, `checkout.paid`).
- **Testing:** unit tests for validation; an end-to-end test against the sandbox.
