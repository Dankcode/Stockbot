# Local git hooks

`pre-commit` is a dependency-free guardrail against committing an obvious
real secret to this (public) repo. It is **not** installed by default --
`.git/hooks/` isn't tracked by git, so every clone needs to opt in once:

```bash
git config core.hooksPath scripts/git-hooks
```

This is a local, best-effort check. It complements, not replaces, GitHub's
own secret scanning and push protection (Settings -> Code security on the
GitHub repo) -- enable those too.
