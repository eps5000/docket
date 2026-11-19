# Tasks: Checkout revamp

- [ ] T001 Card form validation (TL-2)
  - Acceptance: invalid number, expiry or CVC shows an inline error; submit stays disabled.
- [x] T002 Add Luhn check [TL-7]
  - Acceptance: numbers failing the Luhn check are rejected.
- [ ] T003 Wire payment provider sandbox
  - Acceptance: a test card pays in the sandbox end to end.
- [ ] T004 Evaluate fraud scoring
  - Acceptance: a one-page recommendation with costs.
- [ ] T005 Saved cards (TL-11)
  - Acceptance: a returning customer pays with a saved card; only tokens are stored.
- [ ] T006 Handle 3-D Secure challenges
  - Depends on: T003
  - Acceptance: a challenge card shows the modal and completes payment.
- [ ] T007 Emit checkout analytics events
  - Depends on: T001
  - Acceptance: the three step events arrive with the order ID.
