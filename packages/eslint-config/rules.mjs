// The rules every fwd-stack project shares, whichever preset it starts from. A project's own
// guards (Concert Crawl's copy lint, The 99's hover-state rule) stay in that project's config,
// layered after these.
export const sharedTypeScriptRules = {
  // The `eslint-recommended` override inside typescript-eslint's recommended preset turns this off
  // for TS files and defers to ts(7027), but tsc reports 7027 as an error only under
  // `allowUnreachableCode: false`, which no fwd-stack tsconfig sets. Without this, code after a
  // `return` or `throw` passes both lint and typecheck.
  'no-unreachable': 'error',
  'no-unused-vars': 'off',
  // An underscore marks a name as deliberately unused: an argument, a caught error, a
  // destructured value dropped on purpose (`const { id: _drop, ...rest } = row`).
  '@typescript-eslint/no-unused-vars': [
    'error',
    {
      argsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      destructuredArrayIgnorePattern: '^_',
      ignoreRestSiblings: true,
    },
  ],
  '@typescript-eslint/no-explicit-any': 'warn',
  // `typeof import('./module')` stays legal: Vitest's `vi.importActual<typeof import(...)>` and
  // `vi.mock` factories need it, and both apps use them.
  '@typescript-eslint/consistent-type-imports': [
    'error',
    { disallowTypeAnnotations: false },
  ],
};

export const sharedIgnores = {
  ignores: [
    '**/dist/**',
    '**/.next/**',
    '**/coverage/**',
    '**/next-env.d.ts',
    // Feature worktrees live inside the repo; without this the main checkout lints every one.
    '.worktrees/**',
    '.claude/worktrees/**',
  ],
};
