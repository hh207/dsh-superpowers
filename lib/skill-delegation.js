import { defineTool, z } from './optional-deps.js'
import { DELEGABLE_SKILLS } from './delegable-skills.js'
import { NAMESPACE, resolveRoute, unvolatile } from './settings-schema.js'
import { recordRoute } from './records.js'

export { DELEGABLE_SKILLS }

/**
 * Agent-plane tool row: delegate one Superpowers skill to a fresh child agent
 * whose model is pinned by settings rather than chosen by the caller.
 *
 * This row belongs in the AGENT PRESET, not the profile: the tool must exist
 * only on sessions that actually carry the skill catalog. It publishes no
 * service — it registers a tool into the host `tools` registry and reads the
 * host `settings` namespace — so it needs no `isolate` realm.
 *
 * Why one tool and not one row per skill: fifteen near-identical schemas would
 * each occupy the model's context for no added expressiveness. One parameter
 * carrying an enumerated skill says the same thing for a fraction of the cost.
 */

export const name = 'superpowers-delegate-skill'

export const inject = ['tools', 'subagents', 'configEditor']

/** Persona prepended to every delegated child. A child cannot ask questions,
 * so it has to be told to decide and report instead of stopping.
 *
 * HONOURED ONLY ON DSH 0.2.0. `SubagentStartRequest` lost its `persona` field in
 * 0.2.1, so `startActivation` has nowhere to carry this text; the child inherits
 * the persona the preset mounts (`@deepseek-ai/dsh-persona`) instead. The value
 * stays exported because the legacy `startContinuable` path still sends it, and
 * a deployment pinned to 0.2.0 must keep behaving exactly as it did. */
export const DEFAULT_PERSONA =
  'You were dispatched to carry out exactly one task from the Superpowers methodology. '
  + 'Load the named skill first and follow it. It governs your process; your dispatch '
  + 'brief carries the specifics. Do not ask the user anything — a human cannot answer a '
  + 'child agent, so decide, record the decision in your report, and keep going. Your final '
  + 'message must state what you did, what you decided, and what you could not finish.'

/**
 * Built in a try/catch because schema builders are exactly the kind of
 * constructor that silently changes shape across versions: if it throws, an
 * `undefined` Config just means the loader skips validation — apply() applies
 * its own defaults anyway. A throw here would otherwise kill the whole
 * module's load, and a preset mount is whole-tree.
 */
export const Config = (() => {
  try {
    return z.object({
      /** `ctx.subagents` provider whose continuable capability establishes the child. */
      provider: z.string().default('spawn'),
      /** Overrides the delegable list when a preset wants a different surface. */
      skills: z.array(z.string()).default(DELEGABLE_SKILLS),
      /** Persona prepended to every delegated child. */
      persona: z.string().default(DEFAULT_PERSONA),
    })
  } catch {
    return undefined
  }
})()

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {any} [config]
 */
export function apply(ctx, config = {}) {
  try {
    registerTool(ctx, config)
  } catch (error) {
    // A preset mount is whole-tree: an error thrown out of here rolls back
    // every sibling row and the web client retries without backoff, so the
    // worst case is a degraded tool — never a dead tree.
    registerFallback(ctx, error)
  }
}

/**
 * Read the delegation config from the host row that owns the namespace.
 *
 * `configEditor.entries()` walks every addressable profile row; the one whose
 * id is `NAMESPACE` is this plugin's own settings row. Returns `undefined`
 * when nothing has been configured yet, which `resolveRoute` treats as "no
 * override" rather than an error.
 *
 * @param {any} ctx - a context carrying `configEditor`
 * @returns {any} the row's config, or undefined
 */
function hostDelegationConfig(ctx) {
  const editor = ctx.get('configEditor')
  if (editor === undefined || typeof editor.entries !== 'function') return undefined
  const entry = editor.entries().find((row) => row.options?.id === NAMESPACE)
  return entry === undefined ? undefined : unvolatile(entry.fiber?.config)
}

/** The real registration. Throws on any breakage; apply() owns the outcome. */
function registerTool(ctx, config) {
  if (typeof defineTool !== 'function') {
    throw new Error('the tool factory did not load — @deepseek-ai/dsh-tools is missing or broken')
  }
  // Probe the CAPABILITY, not the service. DSH 0.2.1 still publishes
  // `ctx.subagents`; it simply has no `startContinuable` on it, so a
  // module-presence check would pass and every dispatch would then throw
  // "startContinuable is not a function" (the 0.2.1 incident). Failing here
  // instead routes through apply()'s catch into the degraded tool, which says
  // why on the FIRST call rather than mid-run.
  const api = delegationApi(ctx)
  if (api === null) {
    throw new Error(
      'ctx.subagents exposes neither startActivation (DSH 0.2.1+) nor startContinuable (DSH 0.2.0); '
      + 'this DSH renamed the subagent seam and delegate_skill cannot dispatch',
    )
  }
  const skills = config.skills ?? DELEGABLE_SKILLS
  const provider = config.provider ?? 'spawn'
  const persona = config.persona ?? DEFAULT_PERSONA

  // 0.2.1 dropped `persona` from SubagentStartRequest. Warn only when a custom
  // persona was actually configured — the schema's own default is not a choice
  // a user made, and warning about it on every boot would be pure noise.
  if (api === 'activation' && config.persona !== undefined && config.persona !== DEFAULT_PERSONA) {
    ctx.logger?.warn?.(
      '[superpowers-delegate-skill] DSH 0.2.1+ cannot carry a per-child persona; '
      + 'the configured persona is ignored and the child inherits the preset persona. '
      + 'Move it into the preset\'s @deepseek-ai/dsh-persona row instead.',
    )
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'delegate_skill',
    description:
      `Dispatch a fresh child agent to carry out one Superpowers skill end to end, and return a durable id. `
      + `The child runs on the model pinned for that skill in the superpowers-delegation settings — it is chosen for you, so never pass a model. `
      + `The child sees none of this conversation: give it a complete, standalone brief. `
      + `The child's final message is its report; it cannot ask you questions, so the brief must settle anything it would otherwise ask. `
      + `This tool runs in the background by default and immediately returns a durable subagent id; when the run settles the runtime notifies you. `
      + `Do not poll for it. `
      + `In this preset this is the ONLY way to dispatch: the plain subagent tool picks a model that `
      + `is frozen in the preset and cannot be changed from Settings, and a foreground dispatch `
      + `(run_in_background false) creates a one-shot child with no chat box the user can open. `
      + `Delegatable skills: ${skills.join(', ')}.`,
    parameters: {
      skill: {
        type: 'string',
        description:
          `The skill the child will run: one of ${skills.join(', ')}. `
          + `Omit it for work that is not skill-bound — the child then runs on the `
          + `model in the "other subagents" row of the same settings table. Prefer `
          + `omitting it over the plain subagent tool: the plain tool's model is `
          + `frozen in the preset and cannot be changed from Settings.`,
      },
      task: {
        type: 'string',
        required: true,
        description:
          'A short (3-5 word) label for this delegation. It becomes the child session\'s name, '
          + 'and is the only thing that shows in the session tree — say what the child is doing.',
      },
      brief: {
        type: 'string',
        required: true,
        description:
          'The complete, self-contained task. The child has no context of this conversation, so '
          + 'include every path, constraint, interface, and acceptance condition it needs.',
      },
    },
    output: {
      // The registry's value-schema DSL, not raw JSON Schema: required-ness is
      // a SIBLING `required: true` on each property, never a top-level array.
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          childId: { type: 'string', required: true, description: 'Durable child session id — pass this to send_message or interrupt_agent.' },
          skill: { type: 'string', required: true, description: 'The skill the child was handed.' },
          model: { type: 'string', required: true, description: 'The route the child runs on, or "inherited" when nothing is pinned.' },
          label: { type: 'string', required: true, description: 'The child session name as it appears in the session list.' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 1) }]
      },
    },
    /**
     * The registry calls this with exactly two arguments: the parsed arguments
     * and the execution context. An earlier revision declared three and read
     * `exec.agent` off the third, which is always `undefined` — every call
     * failed with "Cannot read properties of undefined (reading 'agent')".
     *
     * @param {{skill: string, task: string, brief: string}} args
     * @param {{agent?: unknown, signal: AbortSignal}} exec
     */
    async execute(args, exec) {
      // Read the host row's config through the config editor: DSH 0.2.x exposes
      // no `settings.get()`, and this row is mounted by the PRESET — it has no
      // config of its own, so the pins live on the profile's `superpowers-
      // delegation-settings` row and are read across from there. Volatile config
      // parses into a reference, so `unvolatile` before use.
      const settings = hostDelegationConfig(ctx)
      // An absent skill is not an error: it is the "other subagents" row, and it
      // is the only way a non-skill child can be given a model from Settings.
      const skill = typeof args.skill === 'string' && args.skill.trim() !== '' ? args.skill.trim() : null
      const route = resolveRoute(settings, skill)
      const parent = exec.agent
      if (parent === undefined) {
        throw new Error('delegate_skill requires a calling agent (exec.agent was undefined)')
      }

      const child = await startChild(ctx, {
        provider,
        parent,
        signal: exec.signal,
        // The skill name leads the label so a session-tree node reads as
        // "[test-driven-development] Task 3" rather than an opaque auto title.
        label: skill === null ? `[通用] ${args.task}` : `[${skill}] ${args.task}`,
        persona,
        brief: args.brief,
        route,
      })

      // Record the route the moment it is known, and before returning: the
      // browser can only ever show what this ledger holds, because DSH does not
      // expose a child's frozen route any other way.
      recordRoute(child.childId, route)

      return {
        childId: child.childId,
        skill: skill ?? '（未指定技能，走其他子代理那一行）',
        model: route === null ? 'inherited' : `${route.provider}/${route.model}`,
        label: skill === null ? `[通用] ${args.task}` : `[${skill}] ${args.task}`,
      }
    },
  })), 'superpowers-delegate-skill.register()')
}

/**
 * Which continuable-child API this Host exposes, or `null` when it exposes none.
 *
 * The seam was renamed in DSH 0.2.1: `startContinuable(spec)` became
 * `startActivation(spec)` and the persona field left `SubagentStartRequest`.
 * The rename is silent from this side — 0.2.1 still publishes a `subagents`
 * service object, it simply has no `startContinuable` on it — so the failure
 * only surfaced on the first dispatch. Probing the capability (not the module)
 * is what turns that into a loud, load-time degrade.
 *
 * @param {any} ctx - a context carrying `subagents`
 * @returns {'activation' | 'continuable' | null}
 */
export function delegationApi(ctx) {
  const subagents = ctx?.subagents
  if (subagents === null || typeof subagents !== 'object') return null
  if (typeof subagents.startActivation === 'function') return 'activation'
  if (typeof subagents.startContinuable === 'function') return 'continuable'
  return null
}

/**
 * Establish the background child on whichever API the Host exposes.
 *
 * Both paths publish a child that outlives this tool call, and both return the
 * durable child id. The differences that matter:
 *
 *   - 0.2.1's `startActivation` takes `delivery` and carries `signal` on the
 *     SPEC, not inside `request` (`request` is typed
 *     `Omit<SubagentStartRequest, 'label' | 'signal'>`).
 *   - 0.2.1 has no `persona` on the request, so a custom persona cannot be
 *     forwarded; the child inherits the preset's persona instead. This is
 *     reported once at registration rather than silently per dispatch.
 *   - `startActivation` resolves to a `SubagentActivation` that owns a
 *     background `result` promise. We do not dispose it — the manager owns the
 *     child's lifetime, exactly as the first-party `subagent` tool does — but
 *     its rejection is captured so a child-level failure cannot surface as an
 *     unhandled rejection here.
 *
 * @param {any} ctx
 * @param {{provider: string, parent: unknown, signal: AbortSignal, label: string,
 *          persona: string, brief: string, route: {provider: string, model: string} | null}} job
 * @returns {Promise<{childId: string}>}
 */
async function startChild(ctx, job) {
  const api = delegationApi(ctx)
  if (api === null) {
    throw new Error(
      'this DSH exposes neither ctx.subagents.startActivation nor startContinuable; '
      + 'the subagent seam changed again and delegate_skill cannot dispatch',
    )
  }

  const request = {
    parent: job.parent,
    prompt: [{ type: 'text', text: job.brief }],
    ...(job.route === null ? {} : { agentOptions: job.route }),
  }

  if (api === 'continuable') {
    // DSH 0.2.0: one call, signal nested in the request, persona honoured.
    return ctx.subagents.startContinuable({
      provider: job.provider,
      label: job.label,
      signal: job.signal,
      request: { ...request, signal: job.signal, persona: job.persona },
    })
  }

  const activation = await ctx.subagents.startActivation({
    provider: job.provider,
    label: job.label,
    signal: job.signal,
    // 'parent' notifies the parent model when the child settles; 'caller' would
    // only hand the result back to this call, and a background child has no
    // caller left to hand it to.
    delivery: 'parent',
    request,
  })
  // Background children are released by the manager at teardown. Attaching a
  // handler keeps a child-level rejection from becoming an unhandled one.
  void activation.result?.catch?.((error) => {
    ctx.logger?.warn?.(`[superpowers-delegate-skill] child ${activation.childId} failed: ${String(error)}`)
  })
  return activation
}

/**
 * Degraded-mode registration: a tool with the same name and shape that does
 * nothing but report why the real one is missing. Hand-rolled on purpose —
 * the factory that normally builds tools is exactly what may be unavailable
 * here. Registering it must also be failure-proof: if even this cannot
 * register, there is nothing left to do but not throw.
 */
function registerFallback(ctx, error) {
  const reason = error instanceof Error ? error.message : String(error)
  try {
    ctx.effect(() => ctx.tools.register({
      name: 'delegate_skill',
      description:
        'DEGRADED: delegate_skill could not initialise — ' + reason
        + '. Calling it will fail with the same message. Report this state to the '
        + 'user instead of retrying; everything else keeps working.',
      parameters: {
        type: 'object',
        properties: {
          skill: { type: 'string', description: 'The skill the child would have been handed.' },
          task: { type: 'string', description: 'Short label for the delegation.' },
          brief: { type: 'string', description: 'The standalone brief for the child.' },
        },
        required: ['task', 'brief'],
      },
      output: {
        schema: { type: 'object', properties: {} },
        render(_args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 1) }]
        },
      },
      async execute() {
        throw new Error('delegate_skill is degraded and cannot dispatch: ' + reason)
      },
    }), 'superpowers-delegate-skill.fallback()')
  } catch {
    // Nothing further to try, and apply() must never throw.
  }
}

