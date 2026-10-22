import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ALL_PATCHES, applyReplacementsToText } from '../lib/core.js';
import { hostPromptKeepsInject } from '../lib/host-clean.js';
import { rewritePromptAssembly } from '../lib/identity.js';

const patch = ALL_PATCHES.find(p => p.id === 40);
const current = `\t\tconst transformed = await this.ctx.waterfall(scopeTarget(this, scope), "system-prompt/assemble", assembly, context, () => Promise.resolve(assembly));
\t\tif (completeSection === void 0 && !runtimeContextSuppressed) return transformed;
\t\tconst requiredContexts = new Set([...contextByName.values()].filter((entry) => entry.required === true).map((entry) => entry.name));
\t\treturn {
\t\t\t...transformed,
\t\t\tsections: completeSection === void 0 ? transformed.sections : [completeSection],
\t\t\tcontexts: runtimeContextSuppressed ? transformed.contexts.filter((entry) => requiredContexts.has(entry.name)) : transformed.contexts
\t\t};`;

test('bundle persona does not interpolate an unregistered cwd variable', () => {
  const bundle = fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.match(bundle, /personaSuffix:\s*""/);
  assert.doesNotMatch(bundle, /personaSuffix:.*\{\{cwd\}\}/);
});

for (const suffix of [undefined, '', 'Your working directory is {{cwd}}.']) {
  test(`runtime identity overlay does not recreate unregistered cwd: ${String(suffix)}`, () => {
    const assembly = {
      sections: suffix === undefined ? [] : [{ name: 'deployment:persona-suffix', text: suffix }],
      variables: { provider: 'test', model: 'test' },
      contexts: [{ name: 'working-directory', text: 'D:/workspace' }],
    };
    let out = assembly;
    for (let round = 0; round < 3; round++) {
      out = rewritePromptAssembly(out, { capabilityProtocol: false });
      assert.equal(out.sections.find(s => s.name === 'deployment:persona-suffix')?.text ?? '', '');
      assert.deepEqual(out.contexts, assembly.contexts);
    }
  });
}

test('runtime identity overlay retains cwd interpolation for older registered hosts', () => {
  const out = rewritePromptAssembly({ sections: [], variables: { cwd: 'D:/workspace' } }, { capabilityProtocol: false });
  assert.equal(out.sections.find(s => s.name === 'deployment:persona-suffix').text, 'Your working directory is {{cwd}}.');
});

for (const [name, source] of [
  ['tabs', current],
  ['spaces', current.replaceAll('\t', '  ')],
  ['CRLF', current.replaceAll('\n', '\r\n')],
]) {
  test(`0.2.1 complete-prompt compatibility: ${name}`, async () => {
    const result = applyReplacementsToText(source, patch);
    assert.equal(result.changed, true);
    assert.equal(hostPromptKeepsInject('// system-prompt/assemble\n// [dsh-purge] identity stripped\n' + result.text), true);
    assert.equal(applyReplacementsToText(result.text, patch).changed, false);
    const evaluate = new Function('scopeTarget', `return async function(assembly, context, scope, completeSection, runtimeContextSuppressed, contextByName) { ${result.text} }`)(() => ({}));
    const injected = { name: 'dsh-purge:test', text: 'local instruction' };
    const required = { name: 'required', text: 'required context' };
    const optional = { name: 'optional', text: 'optional context' };
    const assembly = { sections: [{ name: 'base', text: 'base' }], contexts: [required, optional] };
    const transformed = { ...assembly, sections: [...assembly.sections, injected] };
    const owner = { ctx: { waterfall: async () => transformed } };
    const definitions = new Map([['required', { name: 'required', required: true }]]);
    const complete = { name: 'base', text: 'complete' };
    for (const suppressed of [false, true]) {
      const out = await evaluate.call(owner, assembly, {}, {}, complete, suppressed, definitions);
      assert.deepEqual(out.sections, [injected, complete]);
      assert.deepEqual(out.contexts, suppressed ? [required] : [required, optional]);
    }
    const ordinary = await evaluate.call(owner, assembly, {}, {}, undefined, false, definitions);
    assert.deepEqual(ordinary.sections, [injected, assembly.sections[0]]);
    assert.deepEqual(ordinary.contexts, assembly.contexts);
  });
}
