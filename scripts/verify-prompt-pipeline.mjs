import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { rewritePromptAssembly } from '../lib/identity.js';

// Pass explicit @deepseek-ai directories; this does not discover installations.
for (const root of process.argv.slice(2)) {
  const { Context } = await import(pathToFileURL(path.join(root, 'cordis/lib/index.js')));
  const { SystemPrompt, renderPrompt } = await import(pathToFileURL(path.join(root, 'dsh-system-prompt/lib/index.js')));
  const ctx = new Context();
  try {
    await ctx.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '' });
    ctx.systemPrompt.variable('provider', () => 'test');
    ctx.systemPrompt.variable('model', () => 'test');
    ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      return rewritePromptAssembly(await next(), {
        fallbackInject: 'Local pipeline verification.',
        capabilityProtocol: false,
        context,
      });
    });
    for (let round = 0; round < 3; round++) {
      const assembly = await ctx.systemPrompt.assemble({});
      assert.equal(Object.hasOwn(assembly.variables, 'cwd'), false);
      const text = renderPrompt(assembly);
      assert.match(text, /Local pipeline verification\./);
      assert.doesNotMatch(text, /\{\{cwd\}\}/);
    }
    console.log(`PASS: actual Cordis -> assembly hook -> renderer (3 rounds): ${root}`);
  } finally {
    await ctx.fiber.dispose();
  }
}
