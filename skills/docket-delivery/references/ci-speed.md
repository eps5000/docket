# Making CI faster, and what it costs

**Read when:** CI is slow, you change how CI jobs are split, sharded or cached, or you weigh paid CI capacity.
**Don't read when:** You only open a PR, wait for its checks or read a failure.

The gate rules in the skill always apply: never skip, weaken or bypass a check, and prove the gate whenever you change CI.

## Make CI parallel

1. **Find the slowest step first.** Read the timings of several recent runs. Don't optimize by guesswork.
2. **Split test types into separate jobs:** lint and types, unit, backend, API or contract, browser e2e.
3. **Shard slow suites,** giving each shard its own database, ports, temp folders and data. Shards that share state become flaky.
4. **Build shared artifacts once** and pass them to the jobs that need them.
5. **Measure before and after,** over more than one run. Keep the change only if it helps.

**Can't run jobs in parallel?** Put the fastest checks first so failures show up early.

## Weigh cost against time

- Use free or cheaper CI first when it's enough: parallel jobs on included runners, caching, running less.
- **Moving to paid capacity is the owner's decision.** Bring measured numbers: the time now, the expected time, and the cost. Don't turn it on yourself.
