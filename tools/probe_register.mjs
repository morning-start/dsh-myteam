const calls = []
const tools = {
  register: (def) => { calls.push(def) },
  restrict: () => () => {},
  get: () => undefined,
  schemas: () => ({}),
}
const ctx = {
  tools,
  agents: { create: async () => ({}) },
  effect: (fn) => { try { return fn() } catch (e) { return () => {} } },
  on: () => {},
  logger: { info: (...a) => console.log('[log]', ...a), warn: (...a) => console.log('[warn]', ...a), error: (...a) => console.log('[err]', ...a) },
  reflect: { provide: () => {} },
  set: () => {},
  get: () => undefined,
  root: {},
}
const mod = await import('./lib/host.mjs')
try {
  await mod.apply(ctx, {})
} catch (e) {
  console.log('APPLY THREW:', e && e.message)
}
console.log('register calls:', calls.length)
for (const d of calls) {
  const ok = d.output && typeof d.output === 'object' && typeof d.output.render === 'function' && d.output.schema
  console.log(' -', d.name, 'output:', ok ? 'OK keys=' + JSON.stringify(Object.keys(d.output)) : 'MISSING/BAD', 'defKeys=' + JSON.stringify(Object.keys(d)))
}
