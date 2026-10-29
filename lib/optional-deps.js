/**
 * Peer dependencies without load-time risk.
 *
 * A preset mount is whole-tree: if this package fails to IMPORT, every sibling
 * row is rolled back and the web client retries without backoff — that is how
 * one unresolvable row became a resume storm (2026-09-29). So nothing at the
 * top level of the entry modules may be able to fail, and the only fragile
 * things there were these two libraries. They are imported through this
 * wrapper, which absorbs failure: the real library when it is installed, a
 * permissive stub (or plain absence) when it is not. Callers degrade instead
 * of dying at load.
 *
 * Loaded eagerly rather than at first use on purpose: apply() registers the
 * tool synchronously and the session snapshots its tool list right after the
 * mount — a registration that landed later would silently miss the session.
 */

async function soft(name) {
  try {
    return await import(name)
  } catch {
    return null
  }
}

const [schemastery, dshTools, cosmokit, yaml] = await Promise.all([
  soft('@deepseek-ai/schemastery'),
  soft('@deepseek-ai/dsh-tools'),
  soft('@deepseek-ai/cosmokit'),
  soft('js-yaml'),
])

/** A schema that validates nothing and returns the value unchanged. */
function stubSchema() {
  const schema = (value) => value
  schema.default = () => schema
  schema.required = () => schema
  schema.optional = () => schema
  return schema
}

const stubZ = {
  object: () => stubSchema(),
  string: () => stubSchema(),
  array: () => stubSchema(),
  dict: () => stubSchema(),
}

/** Schemastery when it is installed; a no-op stand-in when it is not. */
export const z = (schemastery?.default ?? schemastery) ?? stubZ

/** Real tool factory when dsh-tools is installed; `null` tells apply() to degrade. */
export const defineTool = dshTools?.defineTool ?? null

/**
 * Unwrap a volatile config reference.
 *
 * Volatile config values parse into a stable reference read with `.get()`
 * (cosmokit's `write` symbol marks them). Absent the library — the development
 * checkout with no node_modules — every value is already plain, so a permissive
 * `false` is the correct answer and callers unwrap nothing.
 *
 * The probe asks whether the FUNCTION is there, not whether the module is:
 * cosmokit only grew `isVolatile` in 1.8.4 (verified against the published
 * tarballs 2026-10-16), so a profile carrying an older copy resolves a
 * perfectly truthy module and then throws on the first call. That is how the
 * settings page failed with `cosmokit.isVolatile is not a function` on
 * 2026-10-16 — a load-time degrade that never ran, because the check it was
 * guarding was one level too shallow.
 */
export const isVolatile = (value) =>
  typeof cosmokit?.isVolatile === 'function'
    ? cosmokit.isVolatile(value)
    : typeof value === 'object' && value !== null && typeof value.get === 'function'

/** YAML parser when js-yaml is installed; `null` means "cannot parse", which callers treat as "nothing to migrate". */
export const parseYaml = (text) => {
  const load = yaml?.load ?? yaml?.default?.load
  return typeof load === 'function' ? load(text) : null
}
