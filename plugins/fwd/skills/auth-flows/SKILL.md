---
name: auth-flows
description: Use when building or changing a custom Clerk sign-in, sign-up or password-reset flow (your own screens on useSignIn and useSignUp rather than Clerk's prebuilt components), and when reviewing a PR that touches one. Rules and short reference snippets for Clerk error handling, the resend-code countdown, the one-time-code input and password-strength checks.
---

# auth-flows

A guide for apps that build their own Clerk screens. It states the rules that keep those screens
safe and consistent, and gives short snippets to copy from. It ships no package and no runtime
code: every app writes the few lines it needs.

**Each app keeps its own screens, styling, copy and emails.** Nothing here dictates layout, tokens,
wording or the look of a message. The rules say what a screen must do, not what it looks like.

## What this skill does not cover

- **A shared package.** There is none to install. Copy a snippet and adapt it.
- **Shared themed UI.** Inputs, buttons and screens belong to the app's own design system.
- **Shared email templates.** Verification and reset emails are written and branded per app.

If you find yourself wanting one of those, that is a separate decision, not a gap in this skill.

## 1 · Clerk errors: map the code, never show it

Clerk rejects a call by throwing an error whose `errors` array holds objects with a `code`, a
`message` and a `longMessage`. Those strings are written for developers. They can name internals,
differ between Clerk versions, and leak whether an account exists. Rules:

- **Never render `code`, `message` or `longMessage` to the user.** Look the code up in a table the
  app owns and show the app's own sentence.
- **Have a fallback.** An unknown code, or a thrown value that is not a Clerk error at all (a
  network failure), shows one generic sentence. Never an empty message, never `[object Object]`.
- **Do not reveal whether an account exists.** For sign-in, show the same sentence for an unknown
  email and a wrong password. For reset, behave the same whether or not the email is registered.
- **Keep the table in one module,** so copy review reads one file. Log the raw code for debugging
  if the app has a logger, but never log a password or a code the user typed.
- **Treat rate limiting as its own case.** `too_many_requests` should say to wait and try again, and
  the screen should stop offering the action for a while.

```ts
import { isClerkAPIResponseError } from '@clerk/nextjs/errors';

// Codes are Clerk's; the sentences are the app's own copy.
const MESSAGES: Record<string, string> = {
  form_identifier_not_found: COPY.signInFailed, // same as a wrong password
  form_password_incorrect: COPY.signInFailed,
  form_code_incorrect: COPY.codeWrong,
  verification_expired: COPY.codeExpired,
  form_password_pwned: COPY.passwordBreached,
  form_password_not_strong_enough: COPY.passwordTooWeak,
  form_identifier_exists: COPY.emailTaken, // see the enumeration note below
  too_many_requests: COPY.slowDown,
};

export function authMessage(err: unknown): string {
  if (isClerkAPIResponseError(err)) {
    const hit = err.errors.map((e) => MESSAGES[e.code]).find(Boolean);
    if (hit) return hit;
  }
  return COPY.somethingWentWrong;
}
```

Check the code names against the Clerk version in use, since Clerk can add or rename them. On
sign-up, an "email taken" answer does reveal an account. Decide per app whether that is acceptable
and write the choice down; the default for a sensitive product is to send the existing owner a
notice and show the same "check your email" screen either way.

## 2 · The resend-code countdown

A verification code can be resent, but never instantly and never without limit. Rules:

- **Start the countdown when the code is sent,** not when the screen renders, and disable the resend
  control until it reaches zero. 30 seconds is a sound default.
- **Compute the remaining time from a timestamp,** `waitUntil - now`, not by decrementing a counter.
  Counters drift when the tab is throttled or the phone sleeps.
- **Show the remaining time in the control** ("Resend in 0:24"), so the person knows it is not broken.
- **A resend replaces the code:** clear the input and any error, restart the countdown, and move
  focus back to the first box.
- **Lock the control while a request is in flight,** so a double tap cannot send two.
- **Server limits win.** If Clerk answers with `too_many_requests`, extend the wait rather than
  letting the button come back.

```ts
function useCountdown(seconds: number) {
  const [waitUntil, setWaitUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (now >= waitUntil) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [now, waitUntil]);
  return {
    remaining: Math.max(0, Math.ceil((waitUntil - now) / 1000)),
    start: () => {
      setNow(Date.now());
      setWaitUntil(Date.now() + seconds * 1000);
    },
  };
}
```

## 3 · The one-time-code input

Six boxes are a convention people expect, and they are easy to get wrong. Rules:

- **One real input underneath.** The least fragile build is a single `<input>` that holds the value,
  with the boxes drawn from its characters. If the app uses six separate inputs instead, every rule
  below must still hold.
- **`autocomplete="one-time-code"`, `inputMode="numeric"` and `pattern="[0-9]*"`,** so phones offer
  the code from the SMS or mail app and show the number pad.
- **Paste works.** Pasting "123456", or a code with spaces or a dash, fills every box. Strip
  non-digits and cap the length.
- **Backspace walks back,** and arrow keys move between boxes if there are separate inputs.
- **Submit when the last digit lands,** once. Guard against a second submit while the first is in
  flight, and against submitting the same code again after a failure.
- **A wrong code clears the boxes,** shows the mapped message, and returns focus to the first box.
- **Announce it.** Give the group a label, give each box an accessible name ("digit 1 of 6"), and put
  the error in a live region.

```tsx
<input
  value={code}
  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
  autoComplete="one-time-code"
  inputMode="numeric"
  pattern="[0-9]*"
  maxLength={6}
  aria-label="Verification code"
/>
```

## 4 · Password strength

Clerk is the judge of a password, so the app's rules must agree with Clerk's or people see a green
meter followed by a rejection.

- **Clerk's setting:** in the dashboard, set the minimum password strength to **2** and turn the
  **breached-password check on** (it refuses passwords found in known leaks). Do not lower either to
  make a test pass.
- **The app enforces 8 characters** before it calls Clerk, with its own message. Do not rely on
  Clerk's length rule alone, and do not set the bar below 8.
- **Use the off-the-shelf `@zxcvbn-ts` library** (`@zxcvbn-ts/core` with the `language-common`
  pack) for a live strength meter. Do not write an estimator. Map its score onto Clerk's line: 0 and 1
  are weak and Clerk will refuse them, 2 and 3 are good, 4 is strong.
- **Lazy-load it.** The dictionaries are large. Import them with a dynamic `import()` the first time
  the person types in the password field, so they stay out of the sign-in and sign-up first load. Add
  a check (a test or a bundle assertion) that fails if anything imports the library statically.
- **Fail weak.** If the dynamic import fails or has not finished, show no score rather than a wrong
  one, and let Clerk's answer decide on submit.
- **Feed it the person's own words** (their name and the parts of their email) as user input, so a
  password built from them scores low.
- **The meter advises; Clerk decides.** Never block submit on the meter alone, and never log, store
  or send the password anywhere except to Clerk.

```ts
// strength.ts: the only module that imports the library, and only via dynamic import().
let estimator: Promise<(pw: string, extra: string[]) => number> | null = null;

export function score(pw: string, extra: string[] = []) {
  estimator ??= (async () => {
    const [{ ZxcvbnFactory }, common] = await Promise.all([
      import('@zxcvbn-ts/core'),
      import('@zxcvbn-ts/language-common'),
    ]);
    const z = new ZxcvbnFactory({
      graphs: common.adjacencyGraphs,
      dictionary: common.dictionary,
    });
    return (p: string, user: string[]) => z.check(p, user).score;
  })();
  return estimator.then((run) => run(pw, extra)).catch(() => null); // null: show no score
}
```

Check the factory's constructor options against the installed `@zxcvbn-ts` version; the API has
changed between majors.

## Review checklist

- No raw Clerk `code`, `message` or `longMessage` reaches the screen; unknown errors fall back.
- Sign-in and reset do not reveal whether an account exists.
- Resend is disabled during the countdown and while a request is in flight.
- The code input accepts paste, offers the platform's one-time-code autofill and submits once.
- The password has an 8-character floor in the app, Clerk's strength is 2 with the breached check
  on, and the estimator is lazy-loaded with a guard against a static import.
- No password or typed code is logged, stored or sent anywhere but Clerk.
