# Plan: Receipts

- **Email:** the transactional mail service's template API; one template, localized later.
- **Trigger:** the provider's `payment.succeeded` webhook enqueues the receipt.
- **Totals:** reuse the checkout's cents arithmetic; fix the rounding bug first.
