# Feature: Checkout revamp

Jira epic: TL-1

## Summary
Customers pay by card in one step, with clear errors, saved cards and 3-D Secure.

## User stories
1. As a customer, I enter my card and see inline errors before I submit.
2. As a returning customer, I pay with a saved card.
3. As the business, we pass 3-D Secure challenges so issuers don't decline.

## Requirements
- FR-001: Validate card number (Luhn), expiry and CVC before submit.
- FR-002: Store only provider tokens for saved cards.
- FR-003: Handle 3-D Secure challenges in a modal.
- FR-004: Emit analytics events for each checkout step.
