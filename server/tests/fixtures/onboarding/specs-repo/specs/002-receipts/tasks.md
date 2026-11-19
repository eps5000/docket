# Tasks: Receipts

- [ ] T010 Fix rounding on totals (TL-5)
  - Acceptance: a three-item order's total matches the sum of its lines, to the cent.
- [ ] T011 Receipt email template
  - Acceptance: the template renders the order lines, total and date.
- [ ] T012 Send the receipt after payment
  - Depends on: T011, T010, 001-checkout/T003
  - Acceptance: a sandbox payment sends one receipt within a minute.
