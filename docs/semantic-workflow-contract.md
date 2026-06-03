# Semantic Workflow Contract (Draft)

Goal: let the workflow author decide orchestration semantics, not low-level execution mechanics.

## Principles

1. Author controls **steps, dependencies, branching, approvals**.
2. Runtime controls **handoff transport, isolation, mutable code state, cleanup**.
3. Default handoff is **artifact/inspect**, not workspace reuse.
4. Only explicit continuation/integration steps get mutable code state.
5. Author should not emit low-level fields like `isolation`, `reuseBranch`, `agentType`, `branch`, `worktree`.

---

## Allowed roles

Initial fixed role set:

- `planner`
- `developer`
- `reviewer`
- `tester`
- `integrator`
- `summarizer`

Roles may have default model profiles, tool policies, and output conventions, but the author only selects the role.

---

## Allowed step kinds

## 1. `analyze(prompt, opts)`
Read-oriented analysis.

```ts
analyze(
  prompt: string,
  opts?: {
    role?: 'planner' | 'reviewer' | 'summarizer'
    guidance?: string
    output?: JsonSchema
  }
): Promise<StepResult>
```

Use for:
- architecture reading
- repo shape understanding
- planning
- risk analysis

Default runtime behavior:
- inspect-only
- no mutable code state required

## 2. `implement(prompt, opts)`
Create a new candidate implementation.

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
- candidate design implementation

Default runtime behavior:
- creates a new candidate code state
- returns both inspect and continue handoff capability

## 3. `reviewChange(input, opts)`
Inspect an implementation result without continuing its code state.

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
- code review
- design review
- completeness / safety review

Default runtime behavior:
- inspect-only handoff
- reviewer should not receive mutable continuation by default

## 4. `continueImplementation(previous, opts)`
Continue an earlier candidate after feedback.

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
- fix after review
- second pass implementation
- iterative refinement

Default runtime behavior:
- resumes/continues previous mutable code state

## 5. `testChange(input, opts)`
Validate an implementation or integrated result.

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
- targeted test verification
- regression testing
- lint/build/test checks

Rule:
- if exact commands matter, put them in `guidance`, not in low-level custom fields

## 6. `compareCandidates(inputs, opts)`
Compare multiple candidates.

```ts
compareCandidates(
  inputs: StepResult[],
  opts?: {
    role: 'reviewer' | 'planner'
    guidance?: string
    output?: JsonSchema
  }
): Promise<StepResult>
```

Use for:
- option A vs B comparison
- multiple review synthesis
- selecting a preferred design

Default runtime behavior:
- inspect-only
- no mutable code state

## 7. `integrateChanges(inputs, opts)`
Create a canonical integrated result.

```ts
integrateChanges(
  inputs: StepResult[],
  opts?: {
    role: 'integrator'
    guidance?: string
    output?: JsonSchema
  }
): Promise<StepResult>
```

Use for:
- selected candidate becomes canonical result
- multiple patches/candidates are merged conceptually
- final integrated state before broad validation or human takeover

Default runtime behavior:
- creates canonical mutable integrated code state

## 8. `summarize(input, opts)`
Produce a concise human-facing synthesis.

```ts
summarize(
  input: unknown,
  opts?: {
    role?: 'summarizer' | 'planner' | 'integrator'
    guidance?: string
    output?: JsonSchema
  }
): Promise<StepResult>
```

Use for:
- implementation plans
- final summaries
- migration docs

## 9. `request_human(request)`
Pause for explicit human approval or guidance.

```ts
request_human(request: {
  title: string
  detail?: string
  options?: string[]
  data?: Record<string, unknown>
}): Promise<{ decision?: string; freeform?: string; metadata?: Record<string, unknown> }>
```

Use for:
- risky architecture changes
- ambiguity with multiple acceptable directions
- merge/release approvals

---

## Shared helpers

- `phase(title)`
- `parallel(thunks)`
- `log(message)`
- `args`, `cwd`, `budget`

`pipeline(...)` may remain internally, but is not required in the first semantic contract draft.

---

## StepResult shape

Runtime returns a normalized structure.

```ts
type StepResult<T = unknown> = {
  id: string
  kind: StepKind
  status: 'done' | 'blocked' | 'failed' | 'approved' | 'needs_fix'
  summary?: string
  artifact?: T
  handoff?: {
    inspect?: { type: 'artifact_bundle' }
    continue?: { type: 'code_state'; stateId: string }
    compare?: { type: 'candidate_set' }
    integrate?: { type: 'integration_input' }
  }
}
```

Author should treat this as opaque except for status/summary/artifact and passing the whole result into later semantic steps.

---

## Lowering rules

Runtime maps semantic steps to execution primitives.

### analyze
- lower to read-oriented agent call
- no mutable continuation state

### implement
- lower to agent call that produces a new candidate code state
- result gets:
  - inspect handoff
  - continue handoff

### reviewChange
- lower to review agent over inspect handoff
- read-only by policy

### continueImplementation
- lower to agent call using previous continue handoff
- same candidate state lineage

### testChange
- lower to tester agent over implementation/integrated state
- exact command should be embedded in guidance if needed

### compareCandidates
- lower to reviewer/planner agent over inspect summaries of inputs
- no writable state

### integrateChanges
- lower to integrator agent that creates canonical integrated state
- use only when combining or canonizing results is necessary

### summarize
- lower to summarizer/integrator/planner agent over artifacts/results

### request_human
- lower to existing human gate primitive

---

## Policy defaults

### Simple tasks
Typical shape:
- `implement`
- optional `testChange` or `reviewChange`

Avoid:
- `compareCandidates`
- `integrateChanges`
- `request_human`

### Medium tasks
Typical shape:
- `implement`
- `reviewChange` and/or `testChange`
- optional `continueImplementation` fix loop

### Complex tasks
Typical shape:
- optional `analyze`
- optional parallel candidates
- `compareCandidates`
- optional `integrateChanges`
- `summarize`
- optional `request_human`

---

## Hard authoring constraints

Workflow author should:
- prefer the smallest safe workflow
- avoid low-level execution controls
- avoid gratuitous `integrateChanges`
- avoid multiple candidates unless they are genuinely useful
- include a fix loop when the task explicitly requires review after implementation and review failure is plausible

Workflow author should not:
- specify `isolation`
- specify `reuseBranch`
- specify `agentType`
- specify branch/worktree/path fields
- invent unsupported option fields (e.g. `command`, `testCommand`) unless the contract explicitly adds them

---

## Example: medium task

```js
export const meta = {
  name: 'improve_cli_display',
  description: 'Add milliseconds to tail timestamps and show branch/isolation info',
}

phase('Implement')
const dev = await implement(
  'Improve CLI display with TDD. Add milliseconds to kanade tail event timestamps and show Base branch, Isolation, and worktree branch/path in kanade show. Run: npx vitest run src/server/app.test.ts test/e2e-mock/cli.test.ts',
  { role: 'developer' }
)

phase('Review')
const review = await reviewChange(dev, {
  role: 'reviewer',
  guidance: 'Check correctness, output formatting, and focused test coverage.',
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
    guidance: 'Address review issues and rerun: npx vitest run src/server/app.test.ts test/e2e-mock/cli.test.ts',
  })
  return { dev, review, fix }
}

return { dev, review }
```

---

## Migration plan

### Phase 1
- keep current runtime internals
- add author-facing semantic prompt and helper API
- lower helpers to current `agent(...)`

### Phase 2
- introduce explicit step result wrappers and code state ids
- hide worktree/reuse semantics behind runtime

### Phase 3
- refine isolation/handoff internals independently of author contract
- add canonical integration state behavior behind `integrateChanges`

This preserves the author contract while allowing runtime evolution.
