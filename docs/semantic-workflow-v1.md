# Semantic Workflow V1 (Minimal Implementable Subset)

This document narrows `docs/semantic-workflow-contract.md` into the first subset we should actually build.

Goal: ship a semantic authoring layer that improves workflow quality **without** forcing an immediate full runtime rewrite.

---

## Why a V1 subset

The full semantic contract is promising, but too broad for a first runtime migration.

V1 should:
- cover the majority of coding workflows
- improve author quality immediately
- map cleanly onto the current runtime
- avoid introducing candidate/integration state machinery too early

So V1 focuses on:
- single implementation path
- review / test / fix loop
- analysis
- human approval for risky work

It intentionally does **not** include full multi-candidate orchestration yet.

---

## V1 step set

### Included in V1

- `analyze(prompt, opts)`
- `implement(prompt, opts)`
- `reviewChange(input, opts)`
- `continueImplementation(previous, opts)`
- `testChange(input, opts)`
- `request_human(request)`
- `phase(title)`
- `parallel(thunks)` (keep available, but only for read-oriented fan-out in V1)
- `log(message)`

### Deferred to V2+

- `compareCandidates(...)`
- `integrateChanges(...)`
- `summarize(...)` as a first-class semantic primitive
- explicit canonical integration state
- explicit candidate set handoff objects

Reason:
- these require stronger lowering rules and more explicit code-state semantics
- they are most valuable for complex multi-path workflows, which we can add after V1 is stable

---

## V1 roles

Keep the initial fixed set, but V1 really depends on these most:

- `planner`
- `developer`
- `reviewer`
- `tester`

Optional but not central in V1:
- `integrator`
- `summarizer`

---

## V1 function signatures

## analyze

```ts
analyze(
  prompt: string,
  opts?: {
    role?: 'planner' | 'reviewer'
    guidance?: string
    output?: JsonSchema
  }
): Promise<StepResult>
```

Use for:
- planning
- architecture/risk review
- bounded read-oriented analysis

Runtime lowering target:
- current `agent(...)` with read-oriented role
- no mutable continuation state exposed to author

---

## implement

```ts
implement(
  prompt: string,
  opts?: {
    role: 'developer'
    guidance?: string
    output?: JsonSchema
  }
): Promise<StepResult>
```

Use for:
- bug fixes
- feature work
- refactors

Runtime lowering target:
- current `agent(...)` dev call
- current mutable code path stays hidden behind helper

---

## reviewChange

```ts
reviewChange(
  input: StepResult,
  opts?: {
    role: 'reviewer'
    guidance?: string
    output?: JsonSchema
  }
): Promise<StepResult>
```

Use for:
- inspect-only review of implementation output

Runtime lowering target:
- current `agent(...)` review call
- author must not specify worktree/isolation/reuse details

---

## continueImplementation

```ts
continueImplementation(
  previous: StepResult,
  opts: {
    role: 'developer'
    feedback: unknown
    guidance?: string
    output?: JsonSchema
  }
): Promise<StepResult>
```

Use for:
- fix loop after review
- follow-up iteration on same implementation path

Runtime lowering target:
- current dev call that resumes the same hidden implementation lineage
- in the first lowering version this may map to the same current task-scoped mutable path

---

## testChange

```ts
testChange(
  input: StepResult,
  opts?: {
    role: 'tester'
    guidance?: string
    output?: JsonSchema
  }
): Promise<StepResult>
```

Use for:
- focused validation
- targeted regression checks
- lint/test/build verification

Rules:
- exact commands belong in prompt/guidance text, not in extra option fields like `command`.
- for medium/complex tasks, `testChange` must return explicit `status` values: `'passed'` or `'failed'`.
- in structured validation output, `issues` means blocking validation failures only; non-blocking environment, dependency, or retry notes belong in `warnings`.

---

## request_human

```ts
request_human(request: {
  title: string
  detail?: string
  options?: string[]
  data?: Record<string, unknown>
}): Promise<{ decision?: string; freeform?: string; metadata?: Record<string, unknown> }>
```

Use for:
- high-risk direction confirmation
- ambiguity resolution
- explicit approval gates

---

## V1 StepResult

Keep the result shape minimal and mostly opaque.

```ts
type StepResult<T = unknown> = {
  id: string
  kind: 'analyze' | 'implement' | 'reviewChange' | 'continueImplementation' | 'testChange'
  status?: string
  summary?: string
  artifact?: T
}
```

Important V1 rule:
- the author passes whole `StepResult` objects into later semantic helpers
- the runtime can carry hidden lineage metadata internally
- the author does not manipulate handoff refs directly yet

This keeps the first version simple.

---

## V1 lowering model

V1 does **not** require a new state engine.

Instead:
- semantic helpers lower to current runtime primitives
- lineage metadata is tracked internally by the helper layer
- low-level fields stay hidden from workflow author

## Lowering sketch

### analyze
Lower to:
- `agent(prompt, { role, schema?, instructions? })`

### implement
Lower to:
- `agent(prompt, { role: 'developer', schema?, instructions? })`
- mark returned step as implementation lineage root

### reviewChange
Lower to:
- `agent(reviewPrompt, { role: 'reviewer', schema?, instructions? })`
- constructed from the implementation result as inspect-only review

### continueImplementation
Lower to:
- `agent(fixPrompt, { role: 'developer', schema?, instructions? })`
- linked to prior implementation lineage internally

### testChange
Lower to:
- `agent(testPrompt, { role: 'tester', schema?, instructions? })`

### request_human
Lower to existing human gate primitive.

---

## V1 workflow shapes we should support well

## Shape A: simple bugfix

```js
phase('Implement')
const dev = await implement('Fix the bug and add one regression test. Run: ...', { role: 'developer' })
return { dev }
```

## Shape B: simple bugfix + validation

```js
phase('Implement')
const dev = await implement('Fix the bug and add one regression test. Run: ...', { role: 'developer' })
phase('Validate')
const test = await testChange(dev, { role: 'tester', guidance: 'Run the focused regression tests.' })
return { dev, test }
```

## Shape C: medium task with review loop

```js
phase('Implement')
const dev = await implement('Do the change with TDD. Run: ...', { role: 'developer' })

phase('Review')
const review = await reviewChange(dev, {
  role: 'reviewer',
  guidance: 'Check correctness, maintainability, and test coverage.',
  output: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['approved', 'needs_fix'] },
      summary: { type: 'string' },
      issues: { type: 'array', items: { type: 'string' } },
    },
    required: ['status', 'summary'],
  },
})

if (review.status === 'needs_fix') {
  phase('Fix')
  const fix = await continueImplementation(dev, {
    role: 'developer',
    feedback: review,
    guidance: 'Address review issues and rerun focused tests.',
  })
  return { dev, review, fix }
}

return { dev, review }
```

## Generated workflow quality gates

Generated workflow output should enforce these minimal gates:

- **reviewChange**: `status: 'approved'` means no blocking issues remain.
- **Reviewer issues** (typically `status: 'needs_fix'`): must trigger one `continueImplementation(...)` fix pass using the review result as `feedback` before moving forward.
- **testChange (medium/complex tasks)**: must return either `status: 'passed'` or `status: 'failed'`, with blocking failures in `issues` and non-blocking notes in `warnings`.
- **Validation failures**: when validation fails, run `continueImplementation(..., { guidance: 'Fix validation' })` and then a fresh `testChange(...)` pass (`Re-validate`).

## Shape D: risky redesign with approval gate

```js
phase('Analyze')
const analysis = await analyze('Examine the current architecture and propose a redesign direction.', {
  role: 'planner',
})

phase('Approval')
const approval = await request_human({
  title: 'Approve redesign direction',
  detail: analysis.summary,
})

phase('Implement')
const impl = await implement(`Proceed with redesign. Direction: ${approval.freeform || analysis.summary}`, {
  role: 'developer',
})

return { analysis, approval, impl }
```

---

## Authoring rules for V1

### The author should
- prefer the smallest safe workflow
- use `implement` for code changes
- use `reviewChange` when explicit review is required
- use `continueImplementation` for fix loops
- use `testChange` when explicit validation is needed
- use `request_human` for risky or ambiguous tasks

### The author should not
- emit `isolation`
- emit `reuseBranch`
- emit `agentType`
- emit worktree/branch/path controls
- invent custom option fields like `command`, `testCommand`
- use `compareCandidates` / `integrateChanges` in V1

---

## When to move to V2

V2 becomes necessary when we want to support:
- genuine multi-candidate exploration
- explicit compare-and-select workflows
- explicit canonical integration state
- richer handoff objects
- stronger isolation semantics independent of current task-scoped mutable behavior

Until then, V1 is enough to improve author quality substantially while staying close to the current runtime.
