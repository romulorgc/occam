# Contributing

Thanks for helping. The project has no dependencies, so there is nothing to install.

## Run the tests

```
npm test
```

This needs Node 18 or newer. CI runs it on Linux, macOS and Windows.

## Guidelines

- Keep it dependency free. Use only Node built-ins.
- One subject per pull request.
- A change in the hook's behavior needs a test case that fails without the change.
- The installer must stay idempotent and must never print the contents of `settings.json`.
