# ChatGPT and GitHub development loop

This repository is structured so an agent working only through GitHub can make changes and obtain trustworthy validation from GitHub Actions.

## What the connected GitHub tooling can do

The ChatGPT GitHub connection can:

- inspect repositories, branches, commits, issues, pull requests, and repository files
- create branches and commit files
- open, update, review, and merge pull requests
- inspect workflow runs associated with a commit
- inspect workflow jobs, steps, and failed-job logs
- download workflow artifacts
- rerun failed workflow jobs

The connection is not a substitute for a local shell or physical ESP32 hardware. GitHub Actions is therefore the execution environment and evidence store for all host-side work.

## Required development flow

1. Create a `codex/<scope>` branch from `main`.
2. Make the smallest coherent change.
3. Open a draft pull request.
4. Wait for all required GitHub Actions checks.
5. Inspect failed job steps and logs through the GitHub connection.
6. Commit fixes to the same branch.
7. Repeat until every required check passes.
8. Review uploaded artifacts, especially `localization-evidence-<sha>` and dashboard screenshots.
9. Merge only after the software claim in the PR matches the evidence.

A passing synthetic localization test must never be described as proof of real-room accuracy.

## Required checks

Every localization change must pass:

- `tools-ci / node tools and dashboard`
- `tools-ci / four receiver XY localization`
- `dashboard-e2e / four-node dashboard browser e2e`
- `localization-gate / four-receiver localization contract`
- `firmware-ci` when firmware or protocol code changes

The repository owner should configure these checks as required branch protection rules for `main`.

## Evidence contract

The `localization-gate` workflow uploads a per-commit artifact containing:

- protocol and joint-alignment test output
- synthetic XY training and validation output
- production build output
- `verdict.json`, which explicitly distinguishes synthetic validation from hardware validation

The PR receives one continuously updated bot comment with PASS or FAIL and the artifact name. This gives ChatGPT a stable place to read the latest result without relying on prose claims.

## What CI proves today

CI can prove that:

- four receiver observations can be aligned by controlled transmitter packet identity
- the deterministic simulator produces a learnable continuous XY signal
- an unseen synthetic coordinate is predicted within configured error gates
- empty-room, out-of-distribution, and insufficient-receiver samples are rejected
- the dashboard and host services compile and browser tests render four receivers

CI does not prove that four physical ESP32 receivers can reliably locate a person in a real room.

## Hardware promotion gate

Real-room XY may be called reliable only after a versioned dataset artifact passes all of these gates:

- four receiver packet overlap and synchronization thresholds
- recordings from multiple days
- multiple people, orientations, and movement paths
- recording-group isolation between train and validation
- leave-one-day-out and leave-one-person-out evaluation
- median error at or below 0.75 m
- p90 error at or below 1.5 m
- accepted coverage at or above 80 percent
- false accepted empty-room rate at or below 5 percent
- out-of-distribution rejection at or above 90 percent
- uncertainty calibration showing that rejected predictions are materially worse than accepted predictions

The dataset, model manifest, metrics JSON, confusion or error plots, and dashboard replay should be uploaded as immutable workflow artifacts.

## Failure handling

When a check fails, the next agent action is deterministic:

1. fetch the latest PR head SHA
2. fetch workflow runs for that SHA
3. fetch jobs for each failed run
4. fetch the failed job log
5. identify the first actionable failure, not the final cascade error
6. patch the branch
7. rerun failed jobs or allow the new commit to trigger the workflow

Do not merge around a failed check. Do not weaken thresholds to make CI green without an explicit engineering justification in the PR.

## Recommended repository settings

Configure `main` with:

- pull requests required before merging
- required status checks listed above
- branches required to be up to date before merging
- conversation resolution required
- force pushes and branch deletion disabled
- squash merge preferred
- auto-merge enabled only after all required checks pass

GitHub Actions permissions should remain read-only by default. Individual workflows should request only the write permissions they need, such as `pull-requests: write` for the localization result comment.
