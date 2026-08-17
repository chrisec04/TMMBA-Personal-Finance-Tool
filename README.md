# Personal Finance Tool

A Claude-powered tool for making a confident financial decision: where you stand, whether you can
afford something, and what to pay down this month — with the arithmetic shown for every figure.

Built to the Module 4 v1 build brief.

---

## Try it in one minute

No API key required. Nothing to configure.

**Just want to run it?**

| | |
| --- | --- |
| **Windows** | double-click **`Start.cmd`** |
| **macOS / Linux** | run **`./start.sh`** |

That installs what it needs on first run, starts the app, and opens it in your browser. If the
`.sh` file will not run, it lost its executable bit in transit: `chmod +x start.sh`. From a
Windows terminal, run it as `.\Start.cmd` — some systems do not search the current directory.

**Prefer a terminal?**

```bash
npm start
```

Or the plain underlying commands:

```bash
npm install
npm run dev
```

Then open <http://localhost:1430>. The app loads with a **fictional demo dataset** — an invented
persona, invented accounts, eight months of invented history — so every screen has something real
to show immediately.

The only prerequisite is [Node.js](https://nodejs.org) 20 or newer. The launcher checks for it and
says so if it is missing.

To check the arithmetic:

```bash
npm test     # the whole suite
npm run eval # just the twenty-scenario math gate
```

Both run **offline, with no API key**, because none of the calculation goes near a model.

### Adding your own API key

Optional, and done **inside the app** — there is no `.env` to edit and no restart.

Open **Settings**, paste an Anthropic API key, and save. The key is verified against the API
before it is accepted, so a typo fails there and then rather than halfway through a
recommendation. Without a key the tool runs on recorded commentary and is clearly labelled as
doing so.

Where the key is held:

| Mode | Held by | Written to disk? |
| --- | --- | --- |
| `npm run dev` (browser) | The Vite dev server's memory | **No.** It dies with the server |
| Packaged desktop app | Your OS keychain, via Rust | Only in the keychain, never in a file |
| Neither | Nothing is stored | — |

The key is never in the frontend bundle, never returned to the browser after it is set, masked to
its last four characters in the UI, and stripped from every log line and error message —
including upstream errors, which sometimes echo the credential that failed.

---

## The one design decision everything else follows from

The brief makes math accuracy the load-bearing metric — twenty scenarios, 100%, "if any
calculation fails, the tool is not deployment-ready" — and rates the cost of being wrong as
medium-high. So:

> **Claude never produces a number that this tool presents as fact.**

Every balance, payment, projection, threshold and total is computed in ordinary TypeScript by the
engine in `src/domain`, which is covered by 185 tests. Claude's job is narrative: why an ordering
makes sense, what it costs, what would change the advice.

And when Claude *does* quote a figure, it is compared to the engine's own, to the cent. If they
disagree:

1. the engine's number wins and is what you see;
2. **the disagreement is shown to you** rather than quietly corrected;
3. the commentary is still displayed, flagged as unreliable.

Point 2 is the one that matters. Silently patching a wrong number would produce a tool that looks
flawless while hiding the fact that its prose and its arithmetic disagreed. Seeing *"the write-up
said $1,700.00, the calculation says $1,775.00"* tells you something true about how much to trust
the paragraph next to it.

This also buys the latency budgets outright. The Snapshot and Affordability surfaces are pure
arithmetic and make **no network call at all**, so their 2s and 3s budgets are met by
construction. Only the Recommendation surface talks to Claude.

---

## The five surfaces

| Screen | Budget | Calls Claude? |
| --- | --- | --- |
| **Financial Snapshot** — balances, health, cushion headroom, staleness | 2s | No |
| **Affordability Check** — yes/no on a purchase, with confidence | 3s | No |
| **Debt Allocation** — ranked plan, four strategies compared, commentary | 5s | Yes |
| **Validation & Approval** — every rule, pass/fail, and the remedy | 5s | No |
| **Trends & History** — series, chart, deterministic confidence | — | No |

### Affordability answers "until payday", not "right now"

Comparing a price to a balance is how a green light on the 3rd becomes a bounced rent payment on
the 1st. Every commitment falling due between now and your next payday is subtracted before
anything is called affordable, so the same $1,000 purchase can be affordable on the 5th and
correctly refused on the 20th.

### Validation failures are hard stops

There is no override, no "approve anyway", and no severity ladder. Ten rules, all of which must
pass.

A hard stop is only humane if it tells you the way out, so **every rule that can fail returns a
specific remedy** naming the input to change and the value that would make it pass — *"reduce
total payments to $1,800.00, or lower the cushion on Checking to $800.00"*. That is enforced by a
test which asserts no failure path can produce a verdict without one.

The rules also re-derive from your recorded balances rather than trusting the planner that
produced the plan, so they still hold for a plan you have edited by hand — and a bug in the
allocator gets caught here rather than shipped.

### Confidence is computed, never claimed

Trend confidence comes from sample count, residual variance and goodness of fit, in code, with
documented thresholds. The underlying `n`, R² and coefficient of variation are shown so you can
check the label rather than take it. A model's own sense of its certainty is not reproducible and
is not used.

---

## How the money works

Every amount is an **integer number of cents**. `0.1 + 0.2 === 0.30000000000000004` is the reason;
dollars as binary floats lose cents over time. Conversion happens only at the display boundary,
through `src/domain/money.ts`, which is property-tested for round-trip accuracy and exact
allocation.

Allocation conserves money exactly: what leaves cash equals what is retired from debt, to the
cent, asserted on every scenario.

---

## The math gate

`eval/scenarios.ts` holds twenty debt-allocation scenarios. Every expected figure is **worked out
by hand in the comment above it** and typed in as a literal — none was copied from the code's
output, because an expectation harvested from the implementation only proves the implementation
is stable, not that it is correct.

They cover strategy ordering, tie-breaking, payoff opportunities, insufficient funds, capped
minimums, cent-level conservation on amounts that do not divide evenly, six-figure balances,
commitment windows, an underwater position that must be rejected on five rules at once, and a
hand-edited overpayment.

```bash
npm run eval
```

201 assertions. The bar is 100%.

---

## Architecture

```
src/domain/          pure TypeScript, no I/O, no React
  money.ts           integer cents, parsing, formatting, exact allocation
  explain.ts         Traced<T> — the step-by-step math machinery
  accounts.ts        accounts, commitments, snapshots; stable IDs
  health.ts          cushion headroom and status bands
  affordability.ts   purchase check, commitment-aware
  allocation.ts      ranking, allocation, and the four strategies
  validation.ts      ten hard-stop rules, each with a remedy
  trends.ts          regression and deterministic confidence
src/claude/
  ClaudePort.ts      one interface, three transports
  prompt.ts          hands Claude the finished arithmetic
  schema.ts          strict response contract
  crosscheck.ts      recomputes every figure Claude quoted
  TauriClaude.ts     IPC to Rust (desktop)
  HttpClaude.ts      to the dev proxy (browser)
  StubClaude.ts      recorded responses (keyless)
src/store/           JSON persistence, atomic writes, versioned
src/ui/              React screens
src/seed/            the fictional demo dataset
server/claudeProxy.ts  dev-only proxy; holds the key in memory
src-tauri/           Rust shell: keychain + the actual HTTPS call
eval/                the twenty scenarios
```

`domain/` is deliberately pure and I/O-free, which is why the whole math gate runs in
milliseconds with no key, no network and no browser.

### Why `Traced<T>`

"Every number must have visible math" is easy to honour the day a function is written and easy to
lose later, when a new branch quietly returns a figure nobody can explain. So explanation is not
a convention here, it is the type: a function that computes money returns `Traced<Cents>`, and
there is no way to construct one without recording how you got there.

---

## Security posture

- The webview is granted **no network permission at all** in the Tauri capability file, and
  `api.anthropic.com` is absent from the CSP. The request is made from Rust, so the frontend
  never needs to reach the network and is never allowed to.
- `anthropic-dangerous-direct-browser-access` appears nowhere in this project. The browser never
  holds a credential, so there is no CORS restriction to opt out of.
- The API key is never written to the saved data file — that file is something you might hand to
  someone else.
- The repository contains **no real financial data**. The demo dataset and the eval fixtures are
  both fabricated.

---

## Desktop build (optional)

Requires a Rust toolchain (1.88+) and the usual Tauri platform prerequisites.

```bash
npm run tauri:dev     # development
npm run tauri:build   # packaged app
```

The browser mode above is the quickest way to evaluate the tool and needs only Node.

---

## Mapping to the IMPACT framework

- **Intent** — one user, three trigger moments, medium-high cost of being wrong. Good enough for
  v1 is a clear position and a confident yes/no in under ten minutes.
- **Mental model** — AI *recommends*, human decides. Nothing is executed; the plan is a
  suggestion you approve, edit, or discard.
- **Plumbing** — level 2–3. One external API, called from the most privileged layer so the
  credential never reaches the least trusted one.
- **Accuracy** — product-layer nets: visible math on every figure, ten hard-stop rules with
  remedies, computed confidence labels, and a cross-check that treats the model's arithmetic as a
  claim rather than a fact.
- **Cost** — the surfaces that need to be fast make no network call, so the budgets are
  structural. Scope was cut to the brief's list.
- **Tracking** — math accuracy is the load-bearing metric: twenty scenarios, hand-computed, 100%
  or it does not ship.

---

## Not in v1, on purpose

| Cut | Why |
| --- | --- |
| Bank API integration | Balances are entered by hand. Automatic retrieval needs a security review out of scope here. |
| Automatic payment execution | Accuracy has to be proven before anything is allowed to move money. |
| Behavioural coaching | The tool explains the money. That is enough for v1. |
