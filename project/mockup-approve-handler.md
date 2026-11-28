# Unreachable mockup-approve handler in MockupDrawer (f-qvmbmh)

## Goal

The Approve button in the factory board's mockup drawer must release a parked
mockup as approved, in every state where the drawer offers it: a normal park
and a park at the revision cap. The report says the handler is unreachable.

## Status of the report

Not reproduced. Traced on the current code:

- `factory-board.ts` `onClick` → `onAction` sends every `data-fb="mockup-*"`
  to `MockupDrawer.onAction` (`factory-mockup.ts`), which posts
  `outcome: 'approved'` to `/api/factory/items/:id/release`.
- The server accepts that release when parked at `mockup` with a ready page,
  including at the revision cap (`board-routes.ts`, `factory-mockup.test.ts`).
- Every park path in `runner.ts` sets the item to `parked`, so `waiting` is
  true at the cap and Approve is enabled.
- `requestJson` never throws, so `busy` cannot stay true after a failed call.

If the bug is real, the observed state is not one of these. The fix needs the
reporter's state (unit status, browser, what the button did) before any
source change.

## Acceptance criteria

1. In the mockup drawer, Approve is enabled when the item waits on its mockup,
   including at the revision cap, and disabled only when `waiting` is false.
2. Clicking Approve posts `outcome: 'approved'` to the release route with the
   item's `cwd`.
3. The server accepts that release at the cap (no 409).

## Verification

- `tests/factory-mockup-dom.test.ts`: the Approve click posts `approved`; the
  disabled rule holds; the capped state is enabled and posts.
- `tests/factory-mockup.test.ts`: the end-to-end approve at the cap returns 200.
- `npx vitest run tests/factory-mockup-dom.test.ts tests/factory-mockup.test.ts`
  and `npm run lint`.

## Out of scope

- Changing the drawer's rendering, the release route's rules, or the
  revision cap.
- Any source change without a reproduced failure.
