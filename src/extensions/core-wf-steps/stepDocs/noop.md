```json5
"done": { "type": "noop" }
```

Use it to mark a branch that intentionally does nothing, e.g. the `else` of an `if`, so it is distinguishable from a branch the author forgot to model. It ends only its own branch: the run and any parallel branches continue.
