From provided diff, generate a concise Git commit subject.

Format: `type(scope): description`
Type: feat|fix|refactor|chore|test|docs. Scope optional.
Description MUST use lowercase imperative mood, no trailing period, and fewer than 72 characters. This path emits a subject only; the commit formatter supplies any body paragraphs.

MUST output ONLY the commit subject.

Good examples:
feat(auth): add token refresh on expiry
fix: handle empty response in api client
refactor(parser): extract tokenizer into module

Bad—capitalized, past tense: Fix: Handled empty response
Bad—trailing period: fix: handle empty response.
Bad—extra prose: Here is the commit message: fix: handle empty response
