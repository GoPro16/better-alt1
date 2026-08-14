# Contributing

Thanks for caring enough to read this. The short version: **issues are very welcome,
pull requests are not accepted.**

## Why

This project is fully vibe-coded: AI writes the code, a human directs and reviews it.
That means writing code is the solved part of the pipeline — a well-described issue is
all it takes for a fix or feature to get built, reviewed, and landed. A PR doesn't skip
any of that; it just adds a second copy of the work that still needs the same human
review before it can merge. So the issue *is* the contribution here.

It's also a stopgap by design — when official plugin support lands in the game client,
this repo gets archived — so building a contributor pipeline around it isn't worth
anyone's time. If you want to try something out, **fork it**; that's encouraged.

Pull requests from non-collaborators are closed automatically. It's not personal, and
it's not a comment on your code.

## What to do instead

- **Bugs** — [open an issue](../../issues/new). Include your Windows version, client
  display mode, and interface theme; a screenshot of the misbehaving watch area helps
  enormously.
- **Feature ideas** — open an issue. Anything that would require the app to *act* on the
  game (send input, read memory, touch packets) will be closed; see the compliance rules
  in the README — passive observation is the entire identity of this project.
- **Want to change the code?** Fork it. It's a good codebase to poke at, and the
  fixtures make analysis code genuinely testable without a running client.

## Security / compliance concerns

If you believe something in here crosses the passive-observer line (or could be made
to), open an issue immediately — that class of report gets priority over everything
else.
